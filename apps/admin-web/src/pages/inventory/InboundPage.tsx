import { useCallback, useEffect, useMemo, useState } from 'react'
import { rk } from '../../utils/rowKey'
import { allValueOf, fromAll, withAll } from '../../utils/filterAll'
import {
  Button,
  Card,
  Col,
  DatePicker,
  Drawer,
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
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { Dayjs } from 'dayjs'
import {
  fetchAcceptStandards,
  fetchRecvAccept,
  fetchSnapshot,
  postAction,
} from '../../api'
import type {
  AcceptStandard,
  IngItem,
  InventoryDoc,
  InventoryLine,
  RecvAcceptRecord,
} from '../../api/types'
import { useAuthStore } from '../../store/auth'
import MockAlert from '../kitchen/components/MockAlert'
import { docDebt, docPaid, formatLinesSummary, lineAmount } from './utils'
import { COLORS } from '../../theme'
import SettleModal from './settle/SettleModal'
import SettleBatchModal from './settle/SettleBatchModal'
import PayModal from './PayModal'
import RecvFormModal from './RecvFormModal'
import RecvImportModal from './RecvImportModal'
import { downloadRecvTemplate } from './recvTemplate'
import { DEFAULT_SETTLE_TPL, loadSettleTpl } from './settle/template'
import { exportSettlePdf } from './settle/pdf'
import type { SettleOpts } from './settle/html'
import type { SettleTemplate } from '../../api/types'
import type { IngLookup } from './settle/data'

function asDoc(r: unknown): InventoryDoc | null {
  if (!r || typeof r !== 'object') return null
  const d = r as InventoryDoc
  if (d.no || d.supplier || d.lines) return d
  return null
}

function docKey(d: InventoryDoc): string {
  return String(d.id ?? d.no ?? '')
}

/** 是否已作废（状态含「作废」/void，旧版 delRecv 物理删除在 Node 改为留痕） */
function isVoided(d: InventoryDoc): boolean {
  return /作废|void/i.test(String(d.status ?? ''))
}

/** pass/warn/fail 及中文 → Tag 色 */
function verdictMeta(v?: string): { color: string; text: string } | null {
  if (!v) return null
  const s = String(v).trim().toLowerCase()
  if (s === 'pass' || s === '合格' || s === 'ok' || s === '通过') {
    return { color: COLORS.green, text: v === 'pass' ? '合格' : String(v) }
  }
  if (s === 'warn' || s === '让步' || s === 'warning' || s === '有瑕疵') {
    return { color: COLORS.yellow, text: v === 'warn' ? '让步' : String(v) }
  }
  if (s === 'fail' || s === '拒收' || s === '不合格' || s === 'reject') {
    return { color: COLORS.red, text: v === 'fail' ? '拒收' : String(v) }
  }
  return { color: 'default', text: String(v) }
}

/** 按单据聚合验收结论：优先最差（fail > warn > pass） */
function worstVerdict(records: RecvAcceptRecord[]): string | undefined {
  if (!records.length) return undefined
  const rank = (v?: string) => {
    const s = String(v || '').toLowerCase()
    if (s === 'fail' || s.includes('拒') || s.includes('不合格')) return 3
    if (s === 'warn' || s.includes('让步') || s.includes('瑕')) return 2
    if (s === 'pass' || s.includes('合格') || s === 'ok') return 1
    return 0
  }
  return [...records].sort((a, b) => rank(b.verdict) - rank(a.verdict))[0]?.verdict
}

export default function InboundPage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const account = useAuthStore((s) => s.account)
  const role = useAuthStore((s) => s.role)

  const [docs, setDocs] = useState<InventoryDoc[]>([])
  const [ings, setIngs] = useState<IngItem[]>([])
  /* FP-RECV-01 新建进货单的「关联采购单」下拉数据源（快照 data.orders） */
  const [orders, setOrders] = useState<InventoryDoc[]>([])
  const [accepts, setAccepts] = useState<RecvAcceptRecord[]>([])
  const [standards, setStandards] = useState<AcceptStandard[]>([])
  const [supplier, setSupplier] = useState<string>()
  const [acceptDate, setAcceptDate] = useState<Dayjs>(dayjs())
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [drawerDoc, setDrawerDoc] = useState<InventoryDoc | null>(null)
  const [acceptOpen, setAcceptOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form] = Form.useForm()
  /* 结算单（只读输出层）：模板 + 弹窗状态 */
  const [tpl, setTpl] = useState<SettleTemplate>(DEFAULT_SETTLE_TPL)
  const [settleDoc, setSettleDoc] = useState<InventoryDoc | null>(null)
  const [settleBatchOpen, setSettleBatchOpen] = useState(false)
  /* FP-RECV-07 补付（欠款清收）：走 recv.pay 审批队列，不直写库 */
  const [payDoc, setPayDoc] = useState<InventoryDoc | null>(null)
  /* FP-RECV-01 新建进货单：走 recv.inbound 审批队列，不直写库 */
  const [recvOpen, setRecvOpen] = useState(false)
  /* FP-RECV-08 编辑进货单：走 recv.update 审批队列，不直写库 */
  const [editDoc, setEditDoc] = useState<InventoryDoc | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  /* FP-RECV-02 批量导入：预览（只读）→ 提交只投一个 recv.import 动作 */
  const [importOpen, setImportOpen] = useState(false)

  const load = useCallback((d: Dayjs) => {
    setLoading(true)
    const ds = d.format('YYYY-MM-DD')
    Promise.all([
      fetchSnapshot()
        .then((snap) => {
          setIngs(snap.data?.ings ?? [])
          setOrders(snap.data?.orders ?? [])
          const raw = snap.data?.recv ?? []
          const list = raw.map(asDoc).filter(Boolean) as InventoryDoc[]
          setDocs(list)
          setIsMock(false)
        })
        .catch(() => {
          setDocs([])
          setOrders([])
          setIsMock(true)
        }),
      fetchRecvAccept(ds)
        .then((items) => setAccepts(items ?? []))
        .catch(() => setAccepts([])),
      fetchAcceptStandards()
        .then((r) => setStandards(r.standards ?? []))
        .catch(() => setStandards([])),
    ]).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load(acceptDate)
  }, [acceptDate, load])

  /* 结算单模板：取不到就回落默认，不阻断页面（结算单是只读输出层） */
  useEffect(() => {
    let alive = true
    loadSettleTpl()
      .then((t) => alive && setTpl(t))
      .catch(() => alive && setTpl(DEFAULT_SETTLE_TPL))
    return () => {
      alive = false
    }
  }, [])

  const ingName = useMemo(() => {
    const m = new Map(ings.map((g) => [g.id, g.name]))
    return (id: string) => m.get(id) ?? id ?? '?'
  }, [ings])

  const acceptsByRecv = useMemo(() => {
    const m = new Map<string, RecvAcceptRecord[]>()
    for (const a of accepts) {
      const key = String(a.recv_id ?? '')
      if (!key) continue
      const list = m.get(key) ?? []
      list.push(a)
      m.set(key, list)
    }
    return m
  }, [accepts])

  /** 结算单用：原料 id → {名称, 采购单位}（旧版 ing(l.ing) 对应物） */
  const ingLookup = useMemo<IngLookup>(() => {
    const m = new Map<string, { name: string; buy: string }>()
    for (const g of ings) m.set(String(g.id), { name: g.name, buy: g.buy ?? '' })
    return (id: string) => m.get(String(id))
  }, [ings])

  const standardByName = useMemo(() => {
    const m = new Map<string, AcceptStandard>()
    for (const s of standards) {
      if (s.ing_name) m.set(s.ing_name.replace(/\s+/g, ''), s)
    }
    return m
  }, [standards])

  const suppliers = useMemo(
    () => [...new Set(docs.map((d) => d.supplier).filter(Boolean))] as string[],
    [docs],
  )

  const filtered = useMemo(
    () =>
      docs
        .filter((d) => !supplier || d.supplier === supplier)
        .sort((a, b) => String(b.date).localeCompare(String(a.date))),
    [docs, supplier],
  )

  /**
   * FP-RECV-10 顶部汇总卡。口径对齐旧版 renderRecvKpi()（旧 HTML:1502-1511）：
   *   累计应付 = Σ 全部进货单 payable；累计实付 = Σ 已付；欠供应商 = 应付 − 实付
   *   「本月」= 近 30 天（旧版 daysAgo(29) 起，含今日），非自然月
   * 注意：用全部 docs，不随供应商筛选变化（与旧版一致）。
   */
  const kpi = useMemo(() => {
    const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
    const pay = r2(docs.reduce((a, d) => a + (Number(d.payable) || 0), 0))
    const got = r2(docs.reduce((a, d) => a + docPaid(d), 0))
    const cutoff = dayjs().subtract(29, 'day').format('YYYY-MM-DD')
    const mPay = r2(
      docs
        .filter((d) => String(d.date ?? '') >= cutoff)
        .reduce((a, d) => a + (Number(d.payable) || 0), 0),
    )
    return { monthPayable: mPay, totalPayable: pay, totalPaid: got, debt: r2(pay - got) }
  }, [docs])

  const drawerAccepts = useMemo(() => {
    if (!drawerDoc) return []
    const key = docKey(drawerDoc)
    const byId = acceptsByRecv.get(key) ?? []
    if (byId.length) return byId
    // 按原料名兜底关联（无 recv_id 时）
    const names = new Set(
      (drawerDoc.lines ?? []).map((l) => String(ingName(String(l.ing ?? l.name ?? '')))),
    )
    return accepts.filter((a) => a.ing_name && names.has(String(a.ing_name)))
  }, [drawerDoc, acceptsByRecv, accepts, ingName])

  /* FP-RECV-04/05 PDF：canvas 光栅化 → JPEG → 极简 PDF 容器（零依赖） */
  const exportPdf = async (
    list: InventoryDoc[],
    t: SettleTemplate,
    opts: SettleOpts,
    single: boolean,
  ) => {
    const name = await exportSettlePdf(list, t, ingLookup, opts, single)
    message.success(`已导出 PDF：${name}（可直接发微信）`)
  }

  /** FP-RECV-09 作废：只投 recv.void 建议动作（执行器只留痕、不物理删除、库存按台账自动回退） */
  const voidRecv = async (doc: InventoryDoc) => {
    const id = docKey(doc)
    try {
      await postAction({
        type: 'recv.void',
        operator: role ?? account ?? 'admin',
        payload: { id, reason: '管理端作废', source: 'admin-web/inventory/inbound' },
      })
      message.success('作废已入队 → 请到审批中心确认（确认后原单标记已作废、库存自动回退）')
      load(acceptDate)
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '作废失败')
    }
  }

  const openAcceptModal = (doc?: InventoryDoc) => {
    form.resetFields()
    const firstLine = doc?.lines?.[0]
    const name = firstLine
      ? ingName(String(firstLine.ing ?? firstLine.name ?? ''))
      : undefined
    form.setFieldsValue({
      recv_id: doc ? docKey(doc) : undefined,
      ing_name: name && name !== '?' ? name : undefined,
      qty_received: firstLine?.recvQty ?? firstLine?.qty,
      qty_ordered: firstLine?.qty,
      verdict: 'pass',
    })
    setAcceptOpen(true)
  }

  const columns: ColumnsType<InventoryDoc> = [
    { title: '单号', dataIndex: 'no', width: 150, render: (v) => v ?? '-' },
    { title: '日期', dataIndex: 'date', width: 110 },
    { title: '供应商', dataIndex: 'supplier', width: 140, ellipsis: true },
    {
      title: '明细',
      key: 'lines',
      ellipsis: true,
      render: (_, r) => formatLinesSummary(r.lines, ingName),
    },
    {
      title: '验收结论',
      key: 'accept',
      width: 120,
      render: (_, r) => {
        const recs = acceptsByRecv.get(docKey(r)) ?? []
        const v = worstVerdict(recs)
        const meta = verdictMeta(v)
        if (!meta) {
          return (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              未验收
            </Typography.Text>
          )
        }
        return (
          <Space size={4}>
            <Tag color={meta.color}>{meta.text}</Tag>
            {recs.length > 1 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {recs.length}项
              </Typography.Text>
            )}
          </Space>
        )
      },
    },
    {
      title: '应付',
      dataIndex: 'payable',
      width: 100,
      align: 'right',
      render: (v) => (v == null ? '-' : `¥${v}`),
    },
    {
      title: '实付',
      key: 'paid',
      width: 100,
      align: 'right',
      render: (_, r) => `¥${docPaid(r)}`,
    },
    {
      title: '欠款',
      key: 'debt',
      width: 90,
      align: 'right',
      render: (_, r) => {
        const d = docDebt(r)
        return d > 0.01 ? <span style={{ color: COLORS.red }}>¥{d}</span> : '—'
      },
    },
    {
      title: '结算',
      key: 'settle',
      width: 90,
      render: (_, r) =>
        isVoided(r) ? (
          <Tag color="default">已作废</Tag>
        ) : docDebt(r) > 0.01 ? (
          <Tag color={COLORS.yellow}>有欠款</Tag>
        ) : (
          <Tag color={COLORS.green}>已结清</Tag>
        ),
    },
    {
      title: '操作',
      key: 'ops',
      width: 140,
      fixed: 'right',
      render: (_, r) => (
        <Space size={0}>
          <Button type="link" size="small" onClick={() => setDrawerDoc(r)}>
            验收明细
          </Button>
          {/* FP-RECV-04 行内结算单（只读输出层，不写库） */}
          <Button type="link" size="small" onClick={() => setSettleDoc(r)}>
            结算单
          </Button>
          {/* FP-RECV-07 补付：仅欠款单显示，走 recv.pay 审批队列 */}
          {canWrite && !isMock && docDebt(r) > 0.01 && (
            <Button type="link" size="small" onClick={() => setPayDoc(r)}>
              补付
            </Button>
          )}
          {canWrite && !isMock && (
            <Button type="link" size="small" onClick={() => openAcceptModal(r)}>
              补录
            </Button>
          )}
          {/* FP-RECV-08 编辑：走 recv.update 审批队列；已作废单不可编辑 */}
          {canWrite && !isMock && !isVoided(r) && (
            <Button type="link" size="small" onClick={() => { setEditDoc(r); setEditOpen(true) }}>
              编辑
            </Button>
          )}
          {/* FP-RECV-09 作废：走 recv.void 审批队列；只留痕不物理删除；已作废单不再显示 */}
          {canWrite && !isMock && !isVoided(r) && (
            <Popconfirm
              title="作废进货单"
              description="原单保留可查（不删除），确认后库存按台账自动回退，确定？"
              okText="确认作废"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => voidRecv(r)}
            >
              <Button type="link" size="small" danger>
                作废
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  const acceptCols: ColumnsType<RecvAcceptRecord> = [
    { title: '原料', dataIndex: 'ing_name', render: (v) => v ?? '-' },
    {
      title: '标准规格',
      key: 'spec',
      width: 140,
      ellipsis: true,
      render: (_, r) => {
        const k = String(r.ing_name ?? '').replace(/\s+/g, '')
        return standardByName.get(k)?.spec_req || '-'
      },
    },
    {
      title: '订/收/拒',
      key: 'qty',
      width: 120,
      render: (_, r) =>
        `${r.qty_ordered ?? '-'} / ${r.qty_received ?? '-'} / ${r.qty_rejected ?? 0}`,
    },
    {
      title: '结论',
      dataIndex: 'verdict',
      width: 90,
      render: (v) => {
        const m = verdictMeta(v)
        return m ? <Tag color={m.color}>{m.text}</Tag> : '-'
      },
    },
    {
      title: '批次/证号',
      key: 'batch',
      width: 140,
      ellipsis: true,
      render: (_, r) => [r.batch_no, r.cert_no].filter(Boolean).join(' · ') || '-',
    },
    {
      title: '时间',
      dataIndex: 'ts',
      width: 160,
      render: (v) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-'),
    },
  ]

  /** FP-RECV-11 明细行内展开：逐项 名称/数量/单价/金额（对齐旧版 renderRecv() :1519-1521） */
  const lineCols: ColumnsType<InventoryLine> = [
    { title: '原料', key: 'name', render: (_, l) => ingName(String(l.ing ?? l.name ?? '')) },
    {
      title: '订购量',
      dataIndex: 'qty',
      width: 90,
      align: 'right',
      render: (v) => (v == null ? '-' : v),
    },
    {
      title: '实收量',
      key: 'recvQty',
      width: 90,
      align: 'right',
      render: (_, l) => (l.recvQty == null ? '-' : l.recvQty),
    },
    {
      title: '单价',
      dataIndex: 'price',
      width: 90,
      align: 'right',
      render: (v) => (v == null ? '-' : `¥${v}`),
    },
    {
      title: '金额',
      key: 'amount',
      width: 100,
      align: 'right',
      render: (_, l) => `¥${lineAmount(l)}`,
    },
  ]

  const expandedRowRender = (doc: InventoryDoc) => {
    const lines = doc.lines ?? []
    if (!lines.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该单无明细行" />
    const total = Math.round(lines.reduce((a, l) => a + lineAmount(l), 0) * 100) / 100
    return (
      <Table<InventoryLine>
        size="small"
        rowKey={rk}
        columns={lineCols}
        dataSource={lines}
        pagination={false}
        summary={() => (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0}>
              <Typography.Text type="secondary">共 {lines.length} 项</Typography.Text>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={1} />
            <Table.Summary.Cell index={2} />
            <Table.Summary.Cell index={3}>
              <Typography.Text type="secondary">合计</Typography.Text>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={4} align="right">
              <Typography.Text strong>¥{total}</Typography.Text>
            </Table.Summary.Cell>
          </Table.Summary.Row>
        )}
      />
    )
  }

  return (
    <div>
      {isMock && <MockAlert endpoint="/api/snapshot/latest · data.recv" />}
      {/* FP-RECV-10 顶部汇总卡（口径同旧版 renderRecvKpi()，「本月」= 近 30 天） */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card>
            <Statistic
              title="本月进货应付"
              prefix="¥"
              value={kpi.monthPayable}
              suffix={<span style={{ fontSize: 12 }}>（近30天）</span>}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="累计应付" prefix="¥" value={kpi.totalPayable} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="累计实付" prefix="¥" value={kpi.totalPaid} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="欠供应商"
              prefix="¥"
              value={kpi.debt}
              valueStyle={{ color: kpi.debt > 0.01 ? COLORS.red : COLORS.green }}
            />
          </Card>
        </Col>
      </Row>
      <Card
        title="进货入库（JH 进货单）"
        extra={
          <Space wrap>
            {/* 有筛选时给出「筛选后 / 全部」两个数：避免把筛选态误读成「列表少了几条」 */}
            <span>
              共 {filtered.length}
              {supplier ? ` / ${docs.length}` : ''} 张
            </span>
            <DatePicker
              value={acceptDate}
              allowClear={false}
              onChange={(d) => d && setAcceptDate(d)}
              title="验收记录日期"
            />
            {/* 首项固定「全部供应商」：不筛选=看全部单据，且随时一键退回全部 */}
            <Select
              allowClear
              placeholder="供应商"
              style={{ width: 160 }}
              options={withAll(
                suppliers.map((s) => ({ value: s, label: s })),
                '全部供应商',
              )}
              value={allValueOf(supplier)}
              onChange={(v) => setSupplier(fromAll<string>(v))}
            />
            {/* FP-RECV-05 批量生成结算单（只读输出层） */}
            <Button disabled={!filtered.length} onClick={() => setSettleBatchOpen(true)}>
              批量结算单
            </Button>
            {/* FP-RECV-03 下载导入模板（只读：客户端生成 CSV，零写库） */}
            <Button onClick={downloadRecvTemplate}>下载导入模板</Button>
            {/* FP-RECV-02 批量导入：预览只读 → 提交投 recv.import（走审批队列，确认前零变化） */}
            <Tooltip title={canWrite ? undefined : '当前角色无写权限，仅可查看'}>
              <Button disabled={!canWrite || isMock} onClick={() => setImportOpen(true)}>
                批量导入
              </Button>
            </Tooltip>
            {/* FP-RECV-01 新建进货单：只投 recv.inbound 建议动作，确认前不改账面 */}
            <Tooltip title={canWrite ? undefined : '当前角色无写权限，仅可查看'}>
              <Button
                type="primary"
                disabled={!canWrite || isMock}
                onClick={() => setRecvOpen(true)}
              >
                新建进货单
              </Button>
            </Tooltip>
            <Tooltip title={canWrite ? undefined : '当前角色无写权限，仅可查看'}>
              <Button
                disabled={!canWrite || isMock}
                onClick={() => openAcceptModal()}
              >
                补录验收
              </Button>
            </Tooltip>
          </Space>
        }
      >
        {filtered.length === 0 && !loading ? (
          <Empty description="暂无进货单：货到了点右上角「新建进货单」录入，提交后到审批中心确认" />
        ) : (
          <Table<InventoryDoc>
            rowKey={rk}
            columns={columns}
            dataSource={filtered}
            loading={loading}
            pagination={{ pageSize: 15 }}
            scroll={{ x: 1100 }}
            rowClassName={(r) => (docDebt(r) > 0.01 ? 'ant-table-row-warning' : '')}
            /* FP-RECV-11 明细行内展开：逐项 名称/数量/单价/金额 */
            expandable={{
              expandedRowRender,
              rowExpandable: (r) => (r.lines?.length ?? 0) > 0,
            }}
          />
        )}
      </Card>

      <Drawer
        title={
          drawerDoc
            ? `验收明细 · ${drawerDoc.no ?? drawerDoc.id ?? ''}`
            : '验收明细'
        }
        open={!!drawerDoc}
        onClose={() => setDrawerDoc(null)}
        width={720}
      >
        {drawerAccepts.length === 0 ? (
          <Empty description="该单暂无逐项验收记录" />
        ) : (
          <Table<RecvAcceptRecord>
            rowKey={rk}
            size="small"
            columns={acceptCols}
            dataSource={drawerAccepts}
            pagination={false}
          />
        )}
        {standards.length > 0 && drawerDoc?.lines?.length ? (
          <div style={{ marginTop: 16 }}>
            <Typography.Text type="secondary">对照验收标准（有匹配才显示）</Typography.Text>
            <Table
              size="small"
              style={{ marginTop: 8 }}
              pagination={false}
              rowKey="ing_name"
              dataSource={(drawerDoc.lines ?? [])
                .map((l) => {
                  const name = ingName(String(l.ing ?? l.name ?? ''))
                  const std = standardByName.get(name.replace(/\s+/g, ''))
                  return std ? { ...std, _lineName: name } : null
                })
                .filter(Boolean) as Array<AcceptStandard & { _lineName: string }>}
              columns={[
                { title: '原料', dataIndex: '_lineName' },
                { title: '规格', dataIndex: 'spec_req', render: (v) => v ?? '-' },
                { title: '感官', dataIndex: 'sensory', ellipsis: true, render: (v) => v ?? '-' },
                {
                  title: '容差',
                  dataIndex: 'weight_tol_pct',
                  width: 80,
                  render: (v) => (v == null ? '-' : `±${v}%`),
                },
              ]}
              locale={{ emptyText: '本单原料暂无标准库匹配' }}
            />
          </div>
        ) : null}
      </Drawer>

      <Modal
        title="补录验收（recv.accept）"
        open={acceptOpen}
        onCancel={() => setAcceptOpen(false)}
        confirmLoading={busy}
        destroyOnHidden
        onOk={async () => {
          const v = await form.validateFields()
          setBusy(true)
          try {
            await postAction({
              type: 'recv.accept',
              operator: role ?? account ?? 'admin',
              payload: {
                recv_id: v.recv_id,
                source: 'admin-web/inventory/inbound',
                items: [
                  {
                    ing_name: v.ing_name,
                    qty_ordered: v.qty_ordered,
                    qty_received: v.qty_received,
                    qty_rejected: v.qty_rejected ?? 0,
                    verdict: v.verdict,
                    batch_no: v.batch_no,
                    cert_no: v.cert_no,
                    detail: v.detail,
                  },
                ],
              },
            })
            message.success('验收已入队 → 请到审批中心确认')
            setAcceptOpen(false)
            load(acceptDate)
          } catch (e: unknown) {
            const err = e as { response?: { data?: { error?: string } } }
            message.error(err.response?.data?.error || '提交失败')
          } finally {
            setBusy(false)
          }
        }}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="recv_id" label="进货单号 / recv_id">
            <Input placeholder="对应 JH 单号或 id" />
          </Form.Item>
          <Form.Item
            name="ing_name"
            label="原料名称"
            rules={[{ required: true, message: '请填写原料' }]}
          >
            <Input placeholder="与验收标准 / 进货明细一致" />
          </Form.Item>
          <Space style={{ display: 'flex' }} size="middle">
            <Form.Item name="qty_ordered" label="订购量">
              <InputNumber style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="qty_received" label="实收量">
              <InputNumber style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="qty_rejected" label="拒收量">
              <InputNumber style={{ width: 120 }} min={0} />
            </Form.Item>
          </Space>
          <Form.Item
            name="verdict"
            label="结论"
            rules={[{ required: true, message: '请选择结论' }]}
          >
            <Select
              options={[
                { value: 'pass', label: '合格' },
                { value: 'warn', label: '让步' },
                { value: 'fail', label: '拒收' },
              ]}
            />
          </Form.Item>
          <Form.Item name="batch_no" label="批次号">
            <Input />
          </Form.Item>
          <Form.Item name="cert_no" label="索证号">
            <Input />
          </Form.Item>
          <Form.Item name="detail" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 结算单（只读输出层） */}
      <SettleModal
        open={!!settleDoc}
        doc={settleDoc}
        tpl={tpl}
        lookup={ingLookup}
        onClose={() => setSettleDoc(null)}
        onExportPdf={(doc, t, opts) => exportPdf([doc], t, opts, true)}
      />
      <SettleBatchModal
        open={settleBatchOpen}
        list={filtered}
        tpl={tpl}
        lookup={ingLookup}
        onClose={() => setSettleBatchOpen(false)}
        onExportPdf={(list, t, opts) => exportPdf(list, t, opts, false)}
      />

      {/* FP-RECV-07 补付：入队后刷新列表（执行要等审批中心确认） */}
      <PayModal
        open={!!payDoc}
        doc={payDoc}
        onClose={() => setPayDoc(null)}
        onQueued={() => load(acceptDate)}
      />

      {/* FP-RECV-01 新建进货单：入队后刷新列表（库存/欠款要等确认后由店内消费器改） */}
      <RecvFormModal
        open={recvOpen}
        ings={ings}
        suppliers={suppliers}
        orders={orders}
        onClose={() => setRecvOpen(false)}
        onQueued={() => load(acceptDate)}
      />

      {/* FP-RECV-08 编辑进货单：入队后刷新列表（库存/欠款要等确认后由店内消费器改） */}
      <RecvFormModal
        open={editOpen}
        editDoc={editDoc}
        ings={ings}
        suppliers={suppliers}
        orders={orders}
        onClose={() => setEditOpen(false)}
        onQueued={() => load(acceptDate)}
      />

      {/* FP-RECV-02 批量导入：预览零写，整批只投一个 recv.import 动作 */}
      <RecvImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onQueued={() => load(acceptDate)}
      />
    </div>
  )
}
