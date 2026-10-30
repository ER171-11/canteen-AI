import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { type Dayjs } from 'dayjs'
import {
  fetchSupplyVendors,
  fetchSupplyVendorTerms,
  submitVendorTermUpsert,
  fetchSupplyCompare,
  fetchSupplyAccounts,
  fetchSupplyOverview,
  fetchSupplyConfig,
  fetchAdminPrice,
  fetchExportQuoteTaskBlob,
  saveSupplyConfig,
  upsertSupplyVendor,
  deleteSupplyVendor,
  deleteSupplyQuote,
  logSupplyPo,
} from '../../api'
import type {
  PricePlanItem,
  PriceQuoteRow,
  PriceReportRow,
  PriceResp,
  SupplyAccountRow,
  SupplyAccountsResp,
  SupplyCompareResp,
  SupplyConfigResp,
  SupplyOverviewResp,
  SupplyQuote,
  SupplyVendorRow,
  SupplyVendorsResp,
  SupplyVendorTerm,
} from '../../api/types'
import { useAuthStore } from '../../store/auth'
import { client } from '../../api/client'
import { comparePlatformUrl, DEF_COMPARE_PLATFORMS, normalizeComparePlatforms } from './comparePlatforms'
import type { ComparePlatform } from './comparePlatforms'
import QuoteEntryModal, { type QuoteIngOption } from './QuoteEntryModal'
import QuoteImportModal from './QuoteImportModal'
import { downloadBlob } from './settle/download'
import { safeHref, todayStr } from './utils'
import { COLORS } from '../../theme'

type SupplyTab = 'vendors' | 'compare' | 'accounts' | 'price'
type PriceFilter = 'all' | 'better' | 'worse' | 'none'

/** FP-PRICE-06/08 报价明细统一行：两表（比价 / 原料比价）与全量表共用同一列口径 */
type QuoteDetailRow = {
  key: string
  /** 报价主键（存量报价可能没有；缺失时删除按 ing+src 定位） */
  id: string
  ingName: string
  unit: string
  buy: string
  src: string
  price: number
  per: string
  perStock: number
  diff: number | null
  date: string
  note: string
}

/** W3 供应商资质临期分级 → Tag 颜色（与食安 certLevel 口径一致） */
const CERT_LEVEL_TAG: Record<string, { color: string; text: string }> = {
  expired: { color: 'red', text: '已逾期' },
  red: { color: 'red', text: '临期' },
  orange: { color: 'orange', text: '临期' },
  yellow: { color: 'gold', text: '临期' },
  green: { color: 'green', text: '有效' },
  unknown: { color: 'default', text: '未登记' },
}



const qDetailOf = (
  q: PriceQuoteRow | SupplyQuote,
  ingName: string,
  unit: string,
  buy: string,
  idx: number,
  diff?: number,
): QuoteDetailRow => ({
  key: `${ingName}|${q.src}|${q.date ?? ''}|${q.price}|${idx}`,
  /* 原料比价行（PriceQuoteRow）带报价主键；供应商比价行（SupplyQuote）没有，删除时按 ing+src 定位 */
  id: String((q as PriceQuoteRow).id ?? ''),
  ingName,
  unit,
  buy,
  src: q.src,
  price: q.price,
  per: q.per,
  perStock: q.perStock,
  diff: diff ?? null,
  date: String(q.date ?? ''),
  note: q.note ?? '',
})

/**
 * 报价明细列（逐列对齐旧版 `quoteListHtml` :5035 / `openQuoteList` :5035）。
 * 传入 `onDelete` 时末列追加「删」（W2-02 / FP-PRICE-07：单条报价删除，走审批队列）。
 */
function quoteDetailCols(
  showIng: boolean,
  onDelete?: (r: QuoteDetailRow) => void,
  canWrite = true,
): ColumnsType<QuoteDetailRow> {
  const cols: ColumnsType<QuoteDetailRow> = [{ title: '日期', dataIndex: 'date', width: 110 }]
  if (showIng) {
    cols.push({ title: '原料', dataIndex: 'ingName', width: 160, render: (x) => <strong>{x}</strong> })
  }
  cols.push(
    { title: '来源', dataIndex: 'src', width: 130 },
    {
      title: '报价', dataIndex: 'price', width: 130, align: 'right',
      render: (x, r) => `¥${x}/${r.per === 'buy' ? (r.buy || r.unit) : r.unit}`,
    },
    {
      title: '折库存单位价', dataIndex: 'perStock', width: 130, align: 'right',
      render: (x, r) => <strong>¥{x}/{r.unit}</strong>,
    },
    {
      title: '对比本店', dataIndex: 'diff', width: 100, align: 'right',
      render: (x) => (x == null ? '-' : <span style={{ color: x < 0 ? COLORS.green : x > 0 ? COLORS.red : undefined }}>{x > 0 ? '+' : ''}{x}</span>),
    },
    { title: '备注', dataIndex: 'note', render: (x) => <Typography.Text type="secondary">{x || ''}</Typography.Text> },
  )
  if (onDelete) {
    cols.push({
      title: '操作', key: 'act', width: 80, align: 'center',
      render: (_, r) => (
        <Popconfirm
          title={`删除报价「${r.ingName} · ${r.src} · ¥${r.price}」？`}
          description={`${r.date || '无日期'} · 只摘掉这一条报价记录，不动原料主数据、库存与进货单。`}
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => onDelete(r)}
        >
          <Tooltip title={canWrite ? undefined : '当前角色无写权限'}>
            <Button size="small" type="link" danger disabled={!canWrite}>删</Button>
          </Tooltip>
        </Popconfirm>
      ),
    })
  }
  return cols
}

const DEFAULT_CFG: SupplyConfigResp['supply'] = {
  spread_warn_pct: 10,
  aging_over30_d: 30,
  aging_over60_d: 60,
  low_level: 3,
}

/**
 * 供应商类目兜底词表：与 bff/lib/supplier_terms.js::seedTerms() 保持一致。
 * 仅在 `GET /api/supply/vendor-terms` 不可用（离线/演示 mock）时兜底，
 * 正常路径一律以后端词表为准（data.vendor_terms 优先）。
 */
const DEF_VENDOR_TERMS: SupplyVendorTerm[] = [
  { id: 'S001', name: '食材', category: '供应商类目', aliases: [], status: 'active' },
  { id: 'S002', name: '餐具', category: '供应商类目', aliases: [], status: 'active' },
  { id: 'S003', name: '酒水', category: '供应商类目', aliases: [], status: 'active' },
  { id: 'S004', name: '设备工程商', category: '供应商类目', aliases: [], status: 'active' },
  { id: 'S005', name: '其他', category: '供应商类目', aliases: [], status: 'active' },
]

export default function VendorsPage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const [vendors, setVendors] = useState<SupplyVendorsResp | null>(null)
  const [compare, setCompare] = useState<SupplyCompareResp | null>(null)
  const [accounts, setAccounts] = useState<SupplyAccountsResp | null>(null)
  const [overview, setOverview] = useState<SupplyOverviewResp | null>(null)
  const [cfg, setCfg] = useState<SupplyConfigResp['supply']>(DEFAULT_CFG)
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<SupplyTab>('vendors')
  const [price, setPrice] = useState<PriceResp | null>(null)
  const [priceQ, setPriceQ] = useState('')
  const [priceF, setPriceF] = useState<PriceFilter>('all')
  const [planOpen, setPlanOpen] = useState(false)
  /* FP-PRICE-08：「全部外部报价记录」全量表 */
  const [quoteAllOpen, setQuoteAllOpen] = useState(false)
  /* FP-PRICE-09：「去比价」外链所用的平台表（`config.compare_platforms`，缺省用旧版 DEF_PLATFORMS） */
  const [platforms, setPlatforms] = useState<ComparePlatform[]>(DEF_COMPARE_PLATFORMS.map((p) => ({ ...p })))

  const [vOpen, setVOpen] = useState(false)
  /* 非空 = 处于「编辑档案」模式（复用登记弹窗，提交带 edit 口径） */
  const [vEdit, setVEdit] = useState<SupplyVendorRow | null>(null)
  /* Phase 2 供应商类目受控词表（后端 data.vendor_terms 优先，拉不到用 DEF_VENDOR_TERMS 兜底） */
  const [vendorTerms, setVendorTerms] = useState<SupplyVendorTerm[]>(DEF_VENDOR_TERMS)
  /* 类目词表管理弹窗（申请 / 审核 / 上架，走审批队列，与库存受控词表同源套路） */
  const [termOpen, setTermOpen] = useState(false)
  const [termName, setTermName] = useState('')
  const [termAliases, setTermAliases] = useState('')
  const [termBusy, setTermBusy] = useState(false)
  const [vForm] = Form.useForm()
  const [qOpen, setQOpen] = useState(false)
  const [poOpen, setPoOpen] = useState(false)
  const [poForm] = Form.useForm()
  const [cfgOpen, setCfgOpen] = useState(false)
  const [cfgForm] = Form.useForm()

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      fetchSupplyVendors(),
      fetchSupplyCompare(),
      fetchSupplyAccounts(),
      fetchSupplyOverview(),
      fetchSupplyConfig().catch(() => null),
      fetchAdminPrice().catch(() => null),
      /* FP-PRICE-09/10：平台表取自 `GET /api/admin/config` 响应体（axios 的 `data`）里的 `config.compare_platforms` */
      client.get<{ config?: { compare_platforms?: unknown } }>('/admin/config').catch(() => null),
      /* Phase 2：类目下拉必须跟后端受控词表走，拉不到才回兜底种子 */
      fetchSupplyVendorTerms().catch(() => null),
    ])
      .then(([v, c, a, o, cf, pr, cfg, vt]) => {
        setVendors(v)
        setCompare(c)
        setAccounts(a)
        setOverview(o)
        if (cf?.supply) setCfg(cf.supply)
        if (pr) setPrice(pr)
        if (cfg?.data?.config) setPlatforms(normalizeComparePlatforms(cfg.data.config.compare_platforms))
        setVendorTerms(vt?.terms?.length ? vt.terms : DEF_VENDOR_TERMS)
        setIsMock(false)
      })
      .catch(() => {
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  /* 供应商登记（新建）/ 编辑：同一弹窗，靠 vEdit 区分口径 */
  const openVendorCreate = useCallback(() => {
    setVEdit(null)
    setVOpen(true)
  }, [])

  const openVendorEdit = useCallback((r: SupplyVendorRow) => {
    setVEdit(r)
    setVOpen(true)
  }, [])

  /* 类目词表管理：申请 / 审核 / 上架（全部走 supplier_term.upsert 审批队列，与库存受控词表同源） */
  const reloadVendorTerms = useCallback(() => {
    return fetchSupplyVendorTerms()
      .then((r) => setVendorTerms(r?.terms?.length ? r.terms : DEF_VENDOR_TERMS))
      .catch(() => {})
  }, [])

  const submitVendorTerm = async () => {
    if (!termName.trim()) { message.warning('请输入类目词条名'); return }
    const aliases = termAliases.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    setTermBusy(true)
    try {
      const res = await submitVendorTermUpsert({ name: termName.trim(), category: '供应商类目', aliases })
      if (res.ok) {
        message.success(res.note || '类目词条已申请（待审批上架）')
        setTermName(''); setTermAliases('')
        reloadVendorTerms()
      } else message.error(res.error || '申请失败')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '申请失败')
    } finally { setTermBusy(false) }
  }

  const setVendorTermStatus = async (t: SupplyVendorTerm, status: string) => {
    setTermBusy(true)
    try {
      const res = await submitVendorTermUpsert({ id: t.id, status })
      if (res.ok) {
        message.success(status === 'active' ? '已提交上架（待审批）'
          : status === 'rejected' ? '已提交驳回（待审批）' : '已提交状态变更（待审批）')
        reloadVendorTerms()
      } else message.error(res.error || '操作失败')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '操作失败')
    } finally { setTermBusy(false) }
  }

  /**
   * 类目下拉选项：只列后端受控词表里的标准词条（value = 词条 ID，如 S001）。
   * 写入侧由执行器 vendorCategoryOf 归一到词条 ID，展示侧 normVendor 还原标准名。
   * 驳回（rejected）的词条不可再选，但在编档案的旧值仍可回显（见 fillVendorForm）。
   */
  const vendorTermOptions = useMemo(
    () => vendorTerms.filter((t) => t && t.status !== 'rejected')
      .map((t) => ({ value: String(t.id), label: String(t.name) })),
    [vendorTerms],
  )

  /* 当前选中值不在词表内 = 存量自由文本（未归一），保存后会落兜底「其他」，需要明确提示 */
  const vCatVal = Form.useWatch('category', vForm)
  const vLegacyCat = useMemo(() => {
    const s = vCatVal == null ? '' : String(vCatVal)
    if (!s) return null
    return vendorTermOptions.some((o) => o.value === s) ? null : s
  }, [vCatVal, vendorTermOptions])

  /**
   * 档案类目 → 下拉值：优先词条 ID（category_id），
   * 其次按标准名反查（存量档案里可能还是标准名文本），都对不上则原样回显旧自由文本
   * （保存时后端会落兜底「其他」，UI 用 extra 文案提示）。
   */
  const categoryValueOf = useCallback((row: SupplyVendorRow): string | undefined => {
    if (row.category_id) return String(row.category_id)
    const cat = String(row.category ?? '').trim()
    if (!cat || cat === '未分类') return undefined
    const hit = vendorTerms.filter((t) => t && (
      String(t.name) === cat || (t.aliases ?? []).some((a) => String(a).trim() === cat)
    ))[0]
    return hit ? String(hit.id) : cat
  }, [vendorTerms])

  /**
   * 表单回填（「之前填过的内容不用再填一遍」）。
   *
   * 关键前提：Modal 必须 `forceRender`（见下方 <Modal>）——否则表单在首次打开时才挂载，
   * 挂载时序晚于本次 effect，setFieldsValue 会被丢弃，表现为编辑弹窗一片空白。
   * 常驻挂载后再 resetFields + setFieldsValue，值与 Form.List（资质证照）都能稳定回显。
   */
  const fillVendorForm = useCallback((row: SupplyVendorRow | null) => {
    /* 只写一次 setFieldsValue（不先 resetFields）：reset 的重置与 set 的写入会抢同一批渲染，
       表现为「部分字段回显、部分空白」（Select / Form.List 子字段尤其明显） */
    if (!row) {
      vForm.setFieldsValue({
        name: '', vendor_id: '', category: undefined, period: '月结30天', level: 3,
        status: '合作中', contact: '', phone: '', note: '', certs: [],
      })
      return
    }
    const certs = (row.certs ?? []).map((c) => ({
      type: c.type,
      cert_no: c.cert_no ?? '',
      expire_at: c.expire_at ? dayjs(c.expire_at) : null,
      url: c.url ?? '',
    }))
    vForm.setFieldsValue({
      name: row.name,
      vendor_id: row.id == null ? '' : String(row.id),
      category: categoryValueOf(row),
      period: row.period === '未标' ? '' : row.period,
      level: row.level ?? null,
      status: row.status || '合作中',
      contact: row.contact ?? '',
      phone: row.phone ?? '',
      note: row.note ?? '',
      certs,
    })
    /* Form.List 的行由本次写入创建，子字段在行挂载后才可写：下一拍补写一次，确保证号/到期日回填 */
    if (certs.length) {
      window.setTimeout(() => vForm.setFieldsValue({ certs }), 0)
    }
  }, [vForm, categoryValueOf])

  useEffect(() => {
    if (!vOpen) return
    fillVendorForm(vEdit)
  }, [vOpen, vEdit, fillVendorForm])

  /* 删除档案：入队 vendor.delete；有往来账会被执行器拒绝（提示改为「暂停」） */
  const removeVendor = useCallback(async (r: SupplyVendorRow) => {
    const vid = r.id == null ? undefined : String(r.id)
    setBusy(true)
    try {
      const res = await deleteSupplyVendor({ vendor_id: vid, name: vid ? undefined : r.name })
      if (res.ok) { message.success(res.note || '供应商删除已入队'); load() }
      else message.error(res.error || '删除失败')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '删除失败')
    } finally {
      setBusy(false)
    }
  }, [load])

  const vCols: ColumnsType<SupplyVendorRow> = useMemo(
    () => [
      { title: '供应商', dataIndex: 'name', width: 150, render: (x) => <strong>{x}</strong> },
      {
        title: '品类', dataIndex: 'category', width: 110,
        /* Phase 2：展示标准名，悬停看词条 ID；无 category_id = 存量自由文本尚未归一 */
        render: (x, r) => (
          <Tooltip title={r.category_id ? `受控词条 ${r.category_id}` : '存量自由文本，未归入词表（编辑保存或词表回填后收口）'}>
            <Tag color={r.category_id ? COLORS.blue : undefined}>{x}</Tag>
          </Tooltip>
        ),
      },
      { title: '账期', dataIndex: 'period', width: 110 },
      {
        title: '评级',
        dataIndex: 'level',
        width: 110,
        render: (x) => (x == null ? '-' : <Tag color={Number(x) < cfg.low_level ? COLORS.red : COLORS.green}>{x} 星</Tag>),
      },
      { title: '状态', dataIndex: 'status', width: 100, render: (x) => <Tag>{x}</Tag> },
      { title: '联系人', dataIndex: 'contact', width: 110, render: (x) => x ?? '-' },
      { title: '电话', dataIndex: 'phone', width: 140, render: (x) => x ?? '-' },
      {
        title: '资质',
        dataIndex: 'cert',
        width: 190,
        render: (_, r) => {
          const cert = r.cert
          const meta = (cert && CERT_LEVEL_TAG[cert.level]) || CERT_LEVEL_TAG.unknown
          const days = cert?.days_left
          const txt = cert?.level === 'expired'
            ? '已逾期'
            : cert?.level === 'green' ? '有效' : cert?.level === 'unknown' ? '未登记' : `临期 ${days} 天`
          const certs = r.certs ?? []
          /* W3：证照亮证明细（类型 / 证号 / 到期日）放 Tooltip，列表内只留可点击的附件链接 */
          const tip = certs.length
            ? certs.map((c) => `${c.type}${c.cert_no ? ` ${c.cert_no}` : ''}${c.expire_at ? `（到期 ${c.expire_at}）` : ''}`).join('\n')
            : (cert?.next_expire_at ? `最近到期：${cert.next_expire_at}` : undefined)
          return (
            <Space direction="vertical" size={2}>
              <Tooltip title={tip ? <span style={{ whiteSpace: 'pre-line' }}>{tip}</span> : undefined}>
                <Tag color={meta.color}>{txt}</Tag>
              </Tooltip>
              {certs.map((c, i) => {
                const href = safeHref(c.url)
                if (!href) return null
                return (
                  <a key={`${c.type}-${i}`} href={href} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>
                    {c.type || '证照附件'}
                  </a>
                )
              })}
            </Space>
          )
        },
      },
      {
        title: '操作',
        key: 'act',
        width: 120,
        fixed: 'right',
        render: (_, r) => (
          <Space size={0}>
            <Tooltip title={canWrite ? undefined : '当前角色无写权限'}>
              <Button size="small" type="link" disabled={!canWrite} onClick={() => openVendorEdit(r)}>编辑</Button>
            </Tooltip>
            <Popconfirm
              title={`删除供应商「${r.name}」？`}
              description="有往来账的供应商不能删除（请把状态改为「暂停」）；历史报价与单据不随档案删除。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => removeVendor(r)}
            >
              <Tooltip title={canWrite ? undefined : '当前角色无写权限'}>
                <Button size="small" type="link" danger disabled={!canWrite}>删除</Button>
              </Tooltip>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [cfg.low_level, canWrite, openVendorEdit, removeVendor],
  )

  /* 比价表：候选价口径同「原料比价」主表（折库存单位价）；单家报价不构成比价 → 最高价/价差显示 '-' */
  const cmpCols: ColumnsType<SupplyCompareResp['rows'][number]> = useMemo(
    () => [
      {
        title: '原料', dataIndex: 'name', width: 170,
        render: (x, r) => (
          <>
            <strong>{x}</strong>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
              {r.conv > 1 ? `1${r.buy}=${r.conv}${r.unit}` : r.unit}
            </Typography.Text>
          </>
        ),
      },
      { title: '候选数', dataIndex: 'candidates', width: 80 },
      { title: '本店均价', dataIndex: 'avg', width: 100, align: 'right', render: (x, r) => `¥${x}/${r.unit}` },
      {
        title: '最低价', key: 'best', width: 170,
        render: (_, r) => (
          <span>
            <strong style={{ color: COLORS.green }}>¥{r.best.perStock}/{r.unit}</strong>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
              {r.best.src} ¥{r.best.price}/{r.best.per === 'buy' ? r.buy : r.unit}
            </Typography.Text>
          </span>
        ),
      },
      {
        title: '最高价', key: 'worst', width: 170,
        render: (_, r) => (r.candidates < 2 ? <Typography.Text type="secondary">-</Typography.Text> : (
          <span>
            <strong style={{ color: COLORS.red }}>¥{r.worst.perStock}/{r.unit}</strong>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
              {r.worst.src} ¥{r.worst.price}/{r.worst.per === 'buy' ? r.buy : r.unit}
            </Typography.Text>
          </span>
        )),
      },
      {
        title: '对比本店', dataIndex: 'diff', width: 110, align: 'right',
        sorter: (a, b) => (a.diff ?? 0) - (b.diff ?? 0),
        /* 本店均价为 0 时无对比基准，显示 '-'（否则会得到「外价比 ¥0 贵 X 元」的失真结论） */
        render: (x, r) => (!(r.avg > 0)
          ? <Typography.Text type="secondary" title="本店暂无均价基准">-</Typography.Text>
          : <span style={{ color: x < 0 ? COLORS.green : x > 0 ? COLORS.red : undefined }}>{x > 0 ? '+' : ''}{x}</span>),
      },
      {
        title: '价差',
        dataIndex: 'spread_pct',
        width: 90,
        sorter: (a, b) => (a.spread_pct ?? 0) - (b.spread_pct ?? 0),
        render: (x) => (x == null ? <Typography.Text type="secondary">-</Typography.Text> : <Tag color={x > (compare?.warn_pct ?? 10) ? COLORS.orange : COLORS.gray}>{x}%</Tag>),
      },
    ],
    [compare],
  )

  /* W2-02 / FP-PRICE-07：删除单条报价（按 id 优先，存量无 id 时按 原料+供应商 定位） */
  const removeQuote = useCallback(async (r: QuoteDetailRow) => {
    setBusy(true)
    try {
      const res = r.id
        ? await deleteSupplyQuote({ id: r.id })
        : await deleteSupplyQuote({ ing: r.ingName, src: r.src })
      if (res.ok) { message.success(res.note || '报价删除已入队'); load() }
      else message.error(res.error || '报价删除失败')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '报价删除失败')
    } finally {
      setBusy(false)
    }
  }, [load])

  const quoteCols = useMemo(() => quoteDetailCols(false, removeQuote, canWrite), [removeQuote, canWrite])
  const quoteAllCols = useMemo(() => quoteDetailCols(true, removeQuote, canWrite), [removeQuote, canWrite])

  /* FP-PRICE-06 报价记录：按原料行展开看多家报价分组（旧版 data-quotelist → quoteListHtml :5035） */
  const cmpExpand = useCallback(
    (r: SupplyCompareResp['rows'][number]) => (
      <Table<QuoteDetailRow>
        rowKey="key"
        size="small"
        pagination={false}
        columns={quoteCols}
        dataSource={r.quotes.map((q, i) => qDetailOf(q, r.name, r.unit, r.buy, i, r.avg > 0 ? Math.round((q.perStock - r.avg) * 100) / 100 : undefined))}
      />
    ),
    [quoteCols],
  )

  const accCols: ColumnsType<SupplyAccountRow> = useMemo(
    () => [
      { title: '供应商', dataIndex: 'supplier', width: 150, render: (x) => <strong>{x}</strong> },
      { title: '类型', dataIndex: 'kind', width: 90, render: (x) => <Tag>{x}</Tag> },
      { title: '应付余额', dataIndex: 'balance', width: 120, align: 'right', render: (x) => `¥${x}` },
      { title: '到期日', dataIndex: 'due', width: 120, render: (x) => x ?? '-' },
      { title: '状态', dataIndex: 'status', width: 110, render: (x) => <Tag color={/逾期/.test(String(x)) ? COLORS.red : COLORS.gray}>{x || '-'}</Tag> },
    ],
    [],
  )

  /* FP-PRICE-03 比价主表：本店均价 vs 外部最低报价（差价 / 节省%） */
  const priceCols: ColumnsType<PriceReportRow> = useMemo(
    () => [
      {
        title: '原料', dataIndex: 'name', width: 170,
        render: (x, r) => (
          <>
            <strong>{x}</strong>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
              {r.cat}{r.conv !== 1 ? ` · 1${r.buy}=${r.conv}${r.unit}` : ''}
            </Typography.Text>
          </>
        ),
      },
      { title: '本店均价', dataIndex: 'avg', width: 100, align: 'right', render: (x, r) => `¥${x}/${r.unit}` },
      {
        title: '外部最低报价', key: 'best', width: 170,
        render: (_, r) => r.best
          ? <span><strong style={{ color: COLORS.green }}>¥{r.best.unit}/{r.unit}</strong><Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>{r.best.src} ¥{r.best.price}/{r.best.per === 'buy' ? r.buy : r.unit}</Typography.Text></span>
          : <Typography.Text type="secondary">暂无报价</Typography.Text>,
      },
      {
        title: '差价', dataIndex: 'diff', width: 100, align: 'right',
        sorter: (a, b) => (a.diff ?? 0) - (b.diff ?? 0),
        /* 本店均价为 0（无采购基价）时不显示省/贵差值，避免「比 ¥0 贵 X 元」的失真对比 */
        render: (x, r) => (x == null || !(r.avg > 0)
          ? <Typography.Text type="secondary" title="本店暂无均价基准">-</Typography.Text>
          : <span style={{ color: x < 0 ? COLORS.green : COLORS.red }}>{x > 0 ? '+' : ''}{x}</span>),
      },
      {
        title: '节省%', dataIndex: 'savePct', width: 100, align: 'right',
        sorter: (a, b) => (a.savePct ?? 0) - (b.savePct ?? 0),
        render: (x, r) => (x == null || !(r.avg > 0)
          ? <Typography.Text type="secondary">-</Typography.Text>
          : <Tag color={r.diff! < 0 ? COLORS.green : COLORS.red}>{r.diff! < 0 ? '省' : '高'} {x}%</Tag>),
      },
      {
        title: '来源与时间', key: 'recent', width: 200,
        render: (_, r) => r.best
          ? (
            <>
              {r.avg > 0
                ? <Tag color={r.diff! < -0.01 ? COLORS.green : r.diff! > 0.01 ? COLORS.red : COLORS.gray}>{r.diff! < -0.01 ? '外价更低' : r.diff! > 0.01 ? '外价更高' : '基本持平'}</Tag>
                : <Tag color={COLORS.gray}>无本店基准</Tag>}
              {r.recent.slice(0, 2).map((q, i) => (
                <Typography.Text key={i} type="secondary" style={{ fontSize: 12, display: 'block' }}>{q.src} · {q.date}</Typography.Text>
              ))}
            </>
          )
          : <Typography.Text type="secondary">无</Typography.Text>,
      },
      {
        /* FP-PRICE-09：跳转外部平台搜索（旧版 pricePop，HTML:1178-1182） */
        title: '去比价', key: 'go', width: 110,
        render: (_, r) => (
          <Dropdown
            menu={{
              items: platforms.length
                ? platforms.map((p) => ({
                    key: p.name || p.tpl,
                    label: (
                      <a href={comparePlatformUrl(p.tpl, r.name)} target="_blank" rel="noopener noreferrer">
                        🔍 {p.name || p.tpl}
                      </a>
                    ),
                  }))
                : [{ key: 'none', label: '未配置平台（到「设置」添加）', disabled: true }],
            }}
          >
            <Button size="small">去比价</Button>
          </Dropdown>
        ),
      },
    ],
    [platforms],
  )

  /* FP-PRICE-13 待比价清单 */
  const planCols: ColumnsType<PricePlanItem> = useMemo(
    () => [
      { title: '原料', dataIndex: 'name', width: 140, render: (x) => <strong>{x}</strong> },
      { title: '分类', dataIndex: 'cat', width: 90, render: (x) => <Tag color={COLORS.blue}>{x}</Tag> },
      { title: '建议搜索关键词', dataIndex: 'keyword', width: 160 },
      { title: '采购单位换算', key: 'conv', width: 120, render: (_, r) => `1${r.buy} = ${r.conv}${r.unit}` },
      { title: '本店均价', dataIndex: 'avg', width: 100, align: 'right', render: (x, r) => `¥${x}/${r.unit}` },
      { title: '状态', dataIndex: 'status', width: 100, render: (x) => <Tag color={x === '已比价' ? COLORS.green : COLORS.orange}>{x}</Tag> },
    ],
    [],
  )

  const priceRows = useMemo(() => {
    if (!price) return []
    return price.report.rows.filter((r) => {
      if (priceQ && !r.name.includes(priceQ) && !r.cat.includes(priceQ)) return false
      if (priceF === 'better') return r.best != null && (r.diff ?? 0) < -0.01
      if (priceF === 'worse') return r.best != null && (r.diff ?? 0) > 0.01
      if (priceF === 'none') return r.best == null
      return true
    })
  }, [price, priceQ, priceF])

  /* FP-PRICE-06 报价记录：原料比价主表按「原料」行展开看多家报价分组（旧版 quoteListHtml :5035） */
  const priceExpand = useCallback(
    (r: PriceReportRow) => (
      <Table<QuoteDetailRow>
        rowKey="key"
        size="small"
        pagination={false}
        columns={quoteCols}
        dataSource={r.quotes.map((q, i) => qDetailOf(q, r.name, r.unit, r.buy, i, r.avg > 0 ? q.diff : undefined))}
      />
    ),
    [quoteCols],
  )

  /* FP-PRICE-08 全部外部报价记录（旧版 openQuoteList :5035）：与主表同源（price.report.rows），按日期倒序 */
  const allQuotes = useMemo<QuoteDetailRow[]>(
    () =>
      (price?.report.rows ?? [])
        .flatMap((r) => r.quotes.map((q, i) => qDetailOf(q, r.name, r.unit, r.buy, i, r.avg > 0 ? q.diff : undefined)))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    [price],
  )

  const run = async (fn: () => Promise<{ ok?: boolean; note?: string; error?: string }>, close: () => void, okMsg: string) => {
    setBusy(true)
    try {
      const res = await fn()
      if (res.ok) { message.success(res.note || okMsg); close(); load() }
      else message.error(res.error || '操作失败')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '操作失败')
    } finally {
      setBusy(false)
    }
  }

  /* 编辑弹窗内的「旧记录」摘要：报价样本 + 往来账，取页面已加载数据，不额外请求 */
  const vHistory = useMemo(() => {
    if (!vEdit) return null
    const name = String(vEdit.name || '')
    const quotes = (price?.report.rows ?? [])
      .flatMap((r) => r.quotes
        .filter((q) => String(q.src || '') === name)
        .map((q) => ({
          ing: r.name,
          unit: r.unit,
          buy: r.buy,
          price: q.price,
          per: q.per,
          date: String(q.date || ''),
        })))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    const accs = (accounts?.rows ?? []).filter((a) => String(a.supplier || '') === name)
    const payable = Math.round(accs.reduce((s, a) => s + (Number(a.balance) || 0), 0) * 100) / 100
    return { quotes, payable, accCount: accs.length }
  }, [vEdit, price, accounts])

  const submitVendor = async () => {
    const v = await vForm.validateFields()
    const editing = vEdit != null
    await run(() => upsertSupplyVendor({
      name: v.name,
      vendor_id: v.vendor_id || undefined,
      category: v.category,
      period: v.period || undefined,
      /* 编辑口径允许显式 null（清空评级）；新建仍按缺省处理 */
      level: v.level == null ? (editing ? null : undefined) : Number(v.level),
      status: v.status,
      contact: v.contact ?? '',
      phone: v.phone ?? '',
      note: v.note ?? '',
      /* W3 资质证照：DatePicker 的 Dayjs 转回 YYYY-MM-DD；空行由后端 normalizeCerts 剔除 */
      certs: (v.certs ?? []).map((c: { type?: string; cert_no?: string; expire_at?: Dayjs | string | null; url?: string }) => ({
        type: c.type || '',
        cert_no: c.cert_no ?? '',
        expire_at: c.expire_at ? (typeof c.expire_at === 'string' ? c.expire_at : (c.expire_at as Dayjs).format('YYYY-MM-DD')) : '',
        url: c.url ?? '',
      })),
      edit: editing || undefined,
      /* 老档案无编号时靠原名定位（改名不新增一条） */
      old_name: editing && vEdit && vEdit.id == null ? vEdit.name : undefined,
    }), () => { setVOpen(false); setVEdit(null) }, editing ? '供应商档案修改已入队' : '供应商档案已入队')
  }
  /* FP-PRICE-05 报价口径实时折算已随弹窗抽到 QuoteEntryModal（两份页面共用同一口径），
     这里只提供「在售原料 + 本店均价」下拉数据源 */
  const qIngOptions = useMemo<QuoteIngOption[]>(
    () => (price?.report.rows ?? []).map((r) => ({
      ingId: r.ingId, name: r.name, avg: r.avg, unit: r.unit, buy: r.buy, conv: r.conv,
    })),
    [price],
  )

  /* W2-03 / FP-PRICE-11：导出待比价任务（只读下载，喂外部 fetch_quotes.py） */
  const [taskBusy, setTaskBusy] = useState(false)
  const [quoteImportOpen, setQuoteImportOpen] = useState(false)
  const exportQuoteTask = async () => {
    setTaskBusy(true)
    try {
      const blob = await fetchExportQuoteTaskBlob()
      const filename = `待比价任务_${todayStr()}.json`
      downloadBlob(filename, blob)
      message.success(`已导出 ${filename}（${price?.plan.onSale ?? 0} 种在售原料），放到「比价脚本/」目录即可运行`)
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } }; message?: string }
      message.error(err?.response?.data?.error || err?.message || '导出失败')
    } finally {
      setTaskBusy(false)
    }
  }

  const submitPo = async () => {
    const v = await poForm.validateFields()
    await run(() => logSupplyPo({
      vendor_id: v.vendor_id, amount: Number(v.amount), ref_no: v.ref_no || undefined,
      ts: v.ts ? (v.ts as Dayjs).format('YYYY-MM-DD') : undefined,
    }), () => setPoOpen(false), '采购应付已入队')
  }
  const submitCfg = async () => {
    const v = await cfgForm.validateFields()
    setBusy(true)
    try {
      const res = await saveSupplyConfig({
        spread_warn_pct: Number(v.spread_warn_pct),
        aging_over30_d: Number(v.aging_over30_d),
        aging_over60_d: Number(v.aging_over60_d),
        low_level: Number(v.low_level),
      })
      if (res.ok) { setCfg(res.supply); message.success('供应链配置已保存'); setCfgOpen(false); load() }
      else message.error('保存失败')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '保存失败')
    } finally {
      setBusy(false)
    }
  }
  const openCfg = () => { cfgForm.setFieldsValue({ ...cfg }); setCfgOpen(true) }
  const tip = canWrite ? undefined : '当前角色无写权限，仅可查看'

  const aging = accounts?.aging

  /* W3.4 看板临期告警：优先用 /api/supply/overview 透出的 cert_expiring（与 /api/supply/vendors 同源同数），
     老后端无该字段时回退供应商列表数据，避免看板静默丢资质告警 */
  const certExpiring = overview?.cert_expiring ?? vendors?.cert_expiring ?? []
  const certExpiredCnt = certExpiring.filter((c) => c.level === 'expired').length
  /* 告警按严重度排序后全量展示：原 slice(0,4) 会把最后压入的资质告警截断 */
  const OVERVIEW_LEVEL_RANK: Record<string, number> = { red: 0, orange: 1, yellow: 2 }
  const overviewAlerts = (overview?.alerts ?? [])
    .slice()
    .sort((a, b) => (OVERVIEW_LEVEL_RANK[a.level] ?? 9) - (OVERVIEW_LEVEL_RANK[b.level] ?? 9))

  return (
    <div>
      {isMock && <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="后端 /api/supply 未连通，当前为本地样例数据" />}
      {overviewAlerts.map((a, i) => (
        <Alert key={i} type={a.level === 'red' ? 'error' : a.level === 'orange' ? 'warning' : 'info'} showIcon style={{ marginBottom: 12 }} message={a.text} />
      ))}

      <Card
        title="供应链 · 供应商 / 比价 / 往来账"
        extra={
          <Space wrap>
            <Tooltip title={tip}><Button disabled={!canWrite} onClick={openCfg}>配置</Button></Tooltip>
            <Tooltip title={tip}><Button disabled={!canWrite} onClick={openVendorCreate}>供应商登记</Button></Tooltip>
            <Tooltip title={tip}><Button disabled={!canWrite} onClick={() => setQOpen(true)}>报价登记</Button></Tooltip>
            <Tooltip title={tip}><Button type="primary" disabled={!canWrite} onClick={() => { poForm.resetFields(); setPoOpen(true) }}>采购应付</Button></Tooltip>
            <Tooltip title="申请 / 审核供应商类目受控词条（入审批队列）"><Button onClick={() => setTermOpen(true)}>类目词表</Button></Tooltip>
            <Button size="small" onClick={load}>刷新</Button>
          </Space>
        }
      >
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          <Col xs={12} md={6}>
            <Card size="small"><Statistic title="供应商" value={overview?.vendors.count ?? 0} suffix="家" /><Typography.Text type="secondary" style={{ fontSize: 12 }}>低评级 {overview?.vendors.low_rated ?? 0} 家 · </Typography.Text><Typography.Text style={{ fontSize: 12, color: certExpiring.length ? COLORS.red : undefined }}>资质临期 {overview?.vendors.cert_expiring_count ?? certExpiring.length} 家</Typography.Text></Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small"><Statistic title="可比价原料" value={overview?.compare.available ?? 0} suffix="项" /><Typography.Text type="secondary" style={{ fontSize: 12 }}>{overview?.compare.top ? `最大价差 ${overview.compare.top.spread_pct}%（${overview.compare.top.name}）` : '暂无价差'}</Typography.Text></Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small"><Statistic title="应付总额" value={overview?.accounts.payable ?? 0} prefix="¥" /></Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small"><Statistic title="需结算（>60天/逾期）" value={overview?.accounts.need_settle ?? 0} prefix="¥" valueStyle={{ color: (overview?.accounts.need_settle ?? 0) > 0 ? COLORS.red : COLORS.green }} /></Card>
          </Col>
        </Row>

        <Tabs
          activeKey={tab}
          onChange={(k) => setTab(k as SupplyTab)}
          items={[
            {
              key: 'vendors',
              label: `供应商档案（${vendors?.count ?? 0}）`,
              children: vendors?.rows.length ? (
                <>
                  {certExpiring.length > 0 && (
                    <Alert
                      type={certExpiredCnt ? 'error' : 'warning'}
                      showIcon
                      style={{ marginBottom: 12 }}
                      message={`资质临期/逾期 ${certExpiring.length} 家${certExpiredCnt ? `（其中已逾期 ${certExpiredCnt} 家）` : ''}`}
                      description={
                        <Space direction="vertical" size={2}>
                          {certExpiring.map((c) => {
                            const meta = CERT_LEVEL_TAG[c.level] || CERT_LEVEL_TAG.unknown
                            return (
                              <span key={c.name}>
                                <strong>{c.name}</strong>{' '}
                                <Tag color={meta.color}>{c.level === 'expired' ? '已逾期' : `临期 ${c.days_left} 天`}</Tag>
                                {c.next_expire_at ? <Typography.Text type="secondary">最近到期 {c.next_expire_at}</Typography.Text> : null}
                                {c.expired_count > 1 ? <Typography.Text type="secondary">（{c.expired_count} 张证照已逾期）</Typography.Text> : null}
                              </span>
                            )
                          })}
                        </Space>
                      }
                    />
                  )}
                  <Table<SupplyVendorRow> rowKey={(r) => String(r.id ?? r.name)} columns={vCols} dataSource={vendors.rows} loading={loading} pagination={{ pageSize: 12 }} size="small" scroll={{ x: 1200 }} />
                </>
              ) : <Empty description="暂无供应商档案" />,
            },
            {
              key: 'compare',
              label: `比价（${compare?.available ?? 0}）`,
              children: compare?.rows.length ? (
                <>
                  <Typography.Paragraph type="secondary">按报价最低为最优候选（候选价统一折算为「元/库存单位」再比较）；AI 仅建议，切换供应商需确认。展开「原料」行可看该原料的多家报价分组。</Typography.Paragraph>
                  <Table<SupplyCompareResp['rows'][number]>
                    rowKey="ingId"
                    columns={cmpCols}
                    dataSource={compare.rows}
                    loading={loading}
                    pagination={{ pageSize: 12 }}
                    size="small"
                    expandable={{ expandedRowRender: cmpExpand, rowExpandable: (r) => r.quotes.length > 0 }}
                  />
                </>
              ) : <Empty description="暂无多供应商报价样本" />,
            },
            {
              key: 'accounts',
              label: `往来账龄（${accounts?.count ?? 0}）`,
              children: (
                <>
                  {aging && (
                    <Descriptions size="small" column={4} style={{ marginBottom: 12 }}>
                      <Descriptions.Item label="0-30 天"><span style={{ color: COLORS.green }}>¥{aging.current}</span></Descriptions.Item>
                      <Descriptions.Item label="31-60 天"><span style={{ color: COLORS.yellow }}>¥{aging.over30}</span></Descriptions.Item>
                      <Descriptions.Item label=">60 天"><span style={{ color: COLORS.orange }}>¥{aging.over60}</span></Descriptions.Item>
                      <Descriptions.Item label="逾期"><span style={{ color: COLORS.red }}>¥{aging.overdue}</span></Descriptions.Item>
                    </Descriptions>
                  )}
                  {accounts?.rows.length ? (
                    <Table<SupplyAccountRow> rowKey={(r) => String(r.id ?? r.supplier)} columns={accCols} dataSource={accounts.rows} loading={loading} pagination={{ pageSize: 12 }} size="small" />
                  ) : <Empty description="暂无供应商往来账" />}
                </>
              ),
            },
            {
              key: 'price',
              label: `原料比价（${price?.report.tip.onSale ?? 0}）`,
              children: (
                <>
                  {price && (
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message={
                        `待比价原料：${price.report.tip.onSale} 种 · 尚无报价 ${price.report.tip.noQuote} 种 · 已有报价 ${price.report.tip.hasQuote} 种`
                        + `（尚无报价 + 已有报价 = 在售原料总数 ${price.report.tip.onSale}）`
                      }
                    />
                  )}
                  <Space style={{ marginBottom: 12 }} wrap>
                    <Input.Search placeholder="搜索原料名 / 分类" allowClear style={{ width: 240 }} value={priceQ} onChange={(e) => setPriceQ(e.target.value)} onSearch={setPriceQ} />
                    <Select<PriceFilter> value={priceF} onChange={setPriceF} style={{ width: 150 }} options={[
                      { value: 'all', label: '全部' },
                      { value: 'better', label: '外价更低' },
                      { value: 'worse', label: '外价更高' },
                      { value: 'none', label: '暂无报价' },
                    ]} />
                    <Button onClick={() => setPlanOpen(true)}>待比价清单</Button>
                    {/* W2-03 / FP-PRICE-11：导出任务 JSON（panda-quote-task v1，外部 fetch_quotes.py 直接消费） */}
                    <Tooltip title="导出 panda-quote-task v1 任务文件，放进「比价脚本/」目录运行 fetch_quotes.py 即得比价结果">
                      <Button loading={taskBusy} onClick={exportQuoteTask}>导出待比价任务</Button>
                    </Tooltip>
                    {/* W2-04 / FP-PRICE-12（ADR-013 D2）：导入比价结果 JSON → 预览 → 确认入队（整批一个 quote.import 动作） */}
                    <Button onClick={() => setQuoteImportOpen(true)}>导入比价结果</Button>
                    <Button onClick={() => setQuoteAllOpen(true)}>全部报价记录（{allQuotes.length}）</Button>
                  </Space>
                  {priceRows.length ? (
                    <Table<PriceReportRow>
                      rowKey="ingId"
                      columns={priceCols}
                      dataSource={priceRows}
                      loading={loading}
                      pagination={{ pageSize: 12 }}
                      size="small"
                      expandable={{ expandedRowRender: priceExpand, rowExpandable: (r) => r.quotes.length > 0 }}
                    />
                  ) : <Empty description="暂无原料比价数据" />}
                </>
              ),
            },
          ]}
        />

        {(overview?.advice ?? []).length > 0 && (
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>{overview?.advice.join('；')}</Typography.Paragraph>
        )}
      </Card>

      <Modal
        title={vEdit ? `编辑供应商档案 · ${vEdit.name}` : '供应商登记'}
        open={vOpen}
        onCancel={() => { setVOpen(false); setVEdit(null) }}
        confirmLoading={busy}
        /* 常驻挂载表单：保证 setFieldsValue 有字段可写（详见 fillVendorForm 注释） */
        forceRender
        width={760}
        onOk={submitVendor}
      >
        {/* 编辑时先亮出该供应商的历史，避免「打开就一片空白、以为没记忆」 */}
        {vEdit && vHistory && (
          <div style={{ marginBottom: 12 }}>
            <Descriptions size="small" column={3} bordered>
              <Descriptions.Item label="历史报价">{vHistory.quotes.length} 条</Descriptions.Item>
              <Descriptions.Item label="应付余额">¥{vHistory.payable}</Descriptions.Item>
              <Descriptions.Item label="往来账">{vHistory.accCount} 笔</Descriptions.Item>
            </Descriptions>
            {vHistory.quotes.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  最近报价（只读；改价请走「报价登记」）：
                </Typography.Text>
                {vHistory.quotes.slice(0, 3).map((q, i) => (
                  <Typography.Text key={i} style={{ display: 'block', fontSize: 12 }}>
                    {q.ing} · ¥{q.price}/{q.per === 'buy' ? q.buy : q.unit} · {q.date}
                  </Typography.Text>
                ))}
              </div>
            )}
          </div>
        )}
        <Form form={vForm} layout="vertical" preserve={false}>
          <Form.Item name="name" label="供应商名称" rules={[{ required: true, message: '请填写名称' }]}><Input /></Form.Item>
          <Form.Item name="vendor_id" label="编号">
            <Input placeholder="选填，留空自动生成" disabled={vEdit != null} />
          </Form.Item>
          <Form.Item
            name="category"
            label="供应品类"
            rules={[{ required: true, message: '请选择供应品类' }]}
            /* 受控单选：选项只来自后端词表（GET /api/supply/vendor-terms），不再硬编码 */
            extra={vLegacyCat
              ? `旧值「${vLegacyCat}」不在受控词表内，保存后会归入「其他」，建议改选标准类目`
              : '受控单选：只能选词表内的标准类目（老档案的别名/自由文本保存时自动归一）'}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="请选择供应类目"
              options={vendorTermOptions}
            />
          </Form.Item>
          <Form.Item name="period" label="账期"><Input placeholder="月结30天 / 现结" /></Form.Item>
          <Form.Item name="level" label="评级（星）"><InputNumber style={{ width: '100%' }} min={0} max={5} /></Form.Item>
          <Form.Item name="status" label="状态">
            <Select options={['合作中', '考察中', '暂停']
              .concat(vEdit && vEdit.status && ['合作中', '考察中', '暂停'].indexOf(vEdit.status) < 0 ? [vEdit.status] : [])
              .map((s) => ({ value: s, label: s }))} />
          </Form.Item>
          <Form.Item name="contact" label="联系人"><Input /></Form.Item>
          <Form.Item name="phone" label="电话"><Input /></Form.Item>
          <Form.Item name="note" label="备注"><Input placeholder="选填" /></Form.Item>
          <Form.List name="certs">
            {(fields, { add, remove }) => (
              <>
                <Typography.Text strong style={{ display: 'block', margin: '4px 0 8px' }}>资质证照</Typography.Text>
                {fields.map(({ key, name, ...restField }) => (
                  <Space key={key} align="baseline" style={{ display: 'flex', marginBottom: 8, width: '100%' }}>
                    <Form.Item
                      {...restField}
                      name={[name, 'type']}
                      rules={[{ required: true, message: '请选类型' }]}
                      style={{ marginBottom: 0, width: 150 }}
                    >
                      <Select
                        placeholder="类型"
                        options={['营业执照', '食品经营许可', '检验合格', '其他'].map((s) => ({ value: s, label: s }))}
                      />
                    </Form.Item>
                    <Form.Item {...restField} name={[name, 'cert_no']} style={{ marginBottom: 0, width: 180 }}>
                      <Input placeholder="证号" />
                    </Form.Item>
                    <Form.Item {...restField} name={[name, 'expire_at']} style={{ marginBottom: 0, width: 150 }}>
                      <DatePicker placeholder="到期日" style={{ width: '100%' }} />
                    </Form.Item>
                    {/* W3 产品超链接：附件链接填好后就地给「预览附件」，免去回列表再点 */}
                    <Form.Item
                      noStyle
                      shouldUpdate={(prev, cur) => prev.certs?.[name]?.url !== cur.certs?.[name]?.url}
                    >
                      {({ getFieldValue }) => {
                        const href = safeHref(getFieldValue(['certs', name, 'url']))
                        return (
                          <Form.Item
                            {...restField}
                            name={[name, 'url']}
                            style={{ marginBottom: 0, width: 200 }}
                            extra={href ? <a href={href} target="_blank" rel="noopener noreferrer">预览附件</a> : undefined}
                          >
                            <Input placeholder="附件链接（选填）" />
                          </Form.Item>
                        )
                      }}
                    </Form.Item>
                    <Button type="link" danger onClick={() => remove(name)}>移除</Button>
                  </Space>
                ))}
                <Button type="dashed" block onClick={() => add({ type: '营业执照', cert_no: '', expire_at: null, url: '' })}>
                  + 添加证照
                </Button>
              </>
            )}
          </Form.List>
          <Alert
            type="info"
            showIcon
            message={vEdit
              ? '修改入队 vendor.upsert（编辑口径，可清空字段），经审批中心确认才写回；下拉状态即可把供应商改为「暂停 / 考察中」。'
              : '档案入队 vendor.upsert，经审批中心确认才写回。'}
          />
        </Form>
      </Modal>

      {/* W3-04：报价录入抽成共享组件（供应商比价页 / 原料库存页行内「比价」共用同一口径） */}
      <QuoteEntryModal
        open={qOpen}
        ings={qIngOptions}
        platforms={platforms}
        onCancel={() => setQOpen(false)}
        onDone={load}
      />

      {/* W2-04 / FP-PRICE-12（ADR-013 D2）：批量导入比价结果（预览 → 入队 → 审批确认 → 落库） */}
      <QuoteImportModal open={quoteImportOpen} onClose={() => setQuoteImportOpen(false)} />

      <Modal title="采购应付登记" open={poOpen} onCancel={() => setPoOpen(false)} confirmLoading={busy} destroyOnHidden onOk={submitPo}>
        <Form form={poForm} layout="vertical" preserve={false}>
          <Form.Item name="vendor_id" label="供应商" rules={[{ required: true, message: '请填写供应商' }]}><Input placeholder="供应商名称或编号" /></Form.Item>
          <Form.Item name="amount" label="应付金额（元）" rules={[{ required: true, message: '请填写金额' }]}><InputNumber style={{ width: '100%' }} min={0.01} /></Form.Item>
          <Form.Item name="ref_no" label="关联单号"><Input placeholder="选填" /></Form.Item>
          <Form.Item name="ts" label="日期"><DatePicker style={{ width: '100%' }} /></Form.Item>
        </Form>
      </Modal>

      <Modal title="供应链配置" open={cfgOpen} onCancel={() => setCfgOpen(false)} confirmLoading={busy} destroyOnHidden onOk={submitCfg}>
        <Form form={cfgForm} layout="vertical" preserve={false}>
          <Form.Item name="spread_warn_pct" label="价差告警阈值（%）" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} min={0} /></Form.Item>
          <Form.Item name="aging_over30_d" label="账龄 30 天档" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} min={1} /></Form.Item>
          <Form.Item name="aging_over60_d" label="账龄 60 天档" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} min={1} /></Form.Item>
          <Form.Item name="low_level" label="低评级线（星）" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} min={0} max={5} /></Form.Item>
          <Alert type="info" showIcon message="需满足：30 天档 < 60 天档；保存即对全店供应链台账生效。" />
        </Form>
      </Modal>

      <Modal title={`待比价清单（${price?.plan.onSale ?? 0}）`} open={planOpen} footer={null} onCancel={() => setPlanOpen(false)} width={820}>
        {price?.plan.items.length ? (
          <Table<PricePlanItem> rowKey="ingId" columns={planCols} dataSource={price.plan.items} pagination={{ pageSize: 12 }} size="small" />
        ) : <Empty description="暂无在售原料" />}
      </Modal>

      {/* FP-PRICE-08 全部外部报价记录（旧版 openQuoteList）：列 = 日期/原料/来源/报价/折库存单位/对比本店/备注/删 */}
      <Modal title={`全部外部报价记录（${allQuotes.length}）`} open={quoteAllOpen} footer={null} onCancel={() => setQuoteAllOpen(false)} width={1000}>
        {allQuotes.length ? (
          <Table<QuoteDetailRow> rowKey="key" columns={quoteAllCols} dataSource={allQuotes} pagination={{ pageSize: 12 }} size="small" />
        ) : <Empty description="暂无外部报价记录" />}
      </Modal>

      {/* Phase 2 供应商类目受控词表管理：申请 / 审核 / 上架（全部入审批队列） */}
      <Modal
        title="供应商类目 · 受控词表管理"
        open={termOpen}
        onCancel={() => setTermOpen(false)}
        footer={null}
        width={820}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="类目为受控单选（禁止自定义）。新词条默认「待审核」，经审批中心确认上架后，供应商档案的「供应品类」才能选用；驳回/下架同理需审批。"
          />
          <Space wrap>
            <Input
              placeholder="类目词条名（如：生鲜果蔬）"
              style={{ width: 180 }}
              value={termName}
              onChange={(e) => setTermName(e.target.value)}
            />
            <Input
              placeholder="别名（逗号分隔，如：果蔬,蔬果）"
              style={{ width: 280 }}
              value={termAliases}
              onChange={(e) => setTermAliases(e.target.value)}
            />
            <Button type="primary" loading={termBusy} onClick={submitVendorTerm}>申请词条</Button>
          </Space>
          <Table<SupplyVendorTerm>
            rowKey="id"
            size="small"
            dataSource={vendorTerms}
            pagination={false}
            columns={[
              { title: 'ID', dataIndex: 'id', width: 80 },
              { title: '类目', dataIndex: 'name', width: 140 },
              {
                title: '别名',
                dataIndex: 'aliases',
                render: (a: string[]) => (a?.length ? a.join('、') : '-'),
              },
              {
                title: '状态',
                dataIndex: 'status',
                width: 100,
                render: (s: string) =>
                  s === 'active' ? <Tag color="green">已上架</Tag>
                    : s === 'pending' ? <Tag color="orange">待审核</Tag>
                      : <Tag>已驳回</Tag>,
              },
              {
                title: '操作',
                key: 'act',
                width: 140,
                render: (_, t) =>
                  t.status === 'pending' ? (
                    <Space size={4}>
                      <Button size="small" type="primary" disabled={termBusy} onClick={() => setVendorTermStatus(t, 'active')}>上架</Button>
                      <Button size="small" disabled={termBusy} onClick={() => setVendorTermStatus(t, 'rejected')}>驳回</Button>
                    </Space>
                  ) : t.status === 'active' ? (
                    <Button size="small" disabled={termBusy} onClick={() => setVendorTermStatus(t, 'rejected')}>下架</Button>
                  ) : (
                    <Button size="small" type="primary" disabled={termBusy} onClick={() => setVendorTermStatus(t, 'active')}>重新上架</Button>
                  ),
              },
            ]}
          />
        </Space>
      </Modal>
    </div>
  )
}
