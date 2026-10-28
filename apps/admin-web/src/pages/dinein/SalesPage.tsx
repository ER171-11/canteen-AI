import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  Popconfirm,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import { fetchAdminConfig, fetchReportDaily, fetchSalesList, postAction, saveAdminConfig } from '../../api'
import type { ReportDaily, SaleListItem } from '../../api/types'
import { useAuthStore } from '../../store/auth'
import { COLORS } from '../../theme'
import SaleCreateModal from './SaleCreateModal'
import SaleEditModal from './SaleEditModal'
import SalePayModal from './SalePayModal'
import SaleImportModal from './SaleImportModal'
import SaleBatchesModal from './SaleBatchesModal'
import DishAliasModal from './DishAliasModal'

/**
 * 销售收银（FP-SALE-07 销售单列表 / FP-SALE-08 顶部 KPI / FP-SALE-11 分次收款）。
 *
 * 口径（ADR-008，唯一出口在 BFF）：
 *   · 应收按**单日期**、实收按**收款日期**、欠款 = 应收 − Σ收款（累计，派生不落库）
 *   · 顶部 KPI **复用 `routes/report.js` 的既有聚合**（不另算、不前端回算），
 *     列表的应收/实收/欠款来自 `GET /api/admin/sales`，同源 `lib/sales_model.js`
 *   · 写操作（收款/作废）一律走 /api/actions 队列，本页只提交「建议动作」
 */

/** 顶部 KPI 取这四张（口径与经营看板同源，不新增公式） */
const KPI_LABELS = ['应收合计', '实收合计', '未收欠款', '销售毛利率']

const RANGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '7', label: '近7天' },
  { value: '30', label: '近30天' },
  { value: 'all', label: '全部' },
]

const STATUS_FILTERS = ['全部', '有欠款', '已结清', '已作废']

function fmt(n?: number | null): string {
  if (n == null || !isFinite(Number(n))) return '-'
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function parseNum(v: unknown): number {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

/** 单据状态标签色：已作废灰 / 有欠款红 / 已结清绿 */
function statusColor(status?: string): string {
  if (status === '已作废') return COLORS.gray
  if (status === '有欠款') return COLORS.red
  return COLORS.green
}

export default function SalesPage() {
  const account = useAuthStore((s) => s.account)
  const role = useAuthStore((s) => s.role)

  const [report, setReport] = useState<ReportDaily | null>(null)
  const [rows, setRows] = useState<SaleListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [range, setRange] = useState<string>('30')
  const [channel, setChannel] = useState<string>('全部')
  const [status, setStatus] = useState<string>('全部')
  const [payTarget, setPayTarget] = useState<SaleListItem | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<SaleListItem | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const [aliasOpen, setAliasOpen] = useState(false)

  // 特性开关：真实出餐销售统一走 POS 扣料（进销存-真实出餐销售统一走pos扣料+特性开关）。
  // 开关存 data.config.saleRealDeduct（默认关闭）；开启后 admin-web 手工录入的销售单也按配方 BOM 扣料。
  const [deductOn, setDeductOn] = useState(false)
  const [deductLoading, setDeductLoading] = useState(false)

  useEffect(() => {
    fetchAdminConfig()
      .then((resp) => setDeductOn(!!(resp?.config && resp.config.saleRealDeduct)))
      .catch(() => { /* 非阻断：读不到配置时按关闭展示 */ })
  }, [])

  const toggleDeduct = async (next: boolean) => {
    setDeductLoading(true)
    try {
      await saveAdminConfig({ saleRealDeduct: next })
      setDeductOn(next)
      message.success(next ? '已开启：手工录入销售单将按 POS 逻辑扣减库存' : '已关闭：手工录入销售单仅记账、不扣料')
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } } }
      message.error(er.response?.data?.error || '开关切换失败（需老板/店长权限）')
    } finally {
      setDeductLoading(false)
    }
  }

  const load = useCallback(() => {
    setLoading(true)
    setErr(null)
    Promise.all([fetchReportDaily(undefined, range), fetchSalesList()])
      .then(([rep, list]) => {
        setReport(rep)
        setRows(list.items ?? [])
      })
      .catch(() => setErr('加载失败：请确认 BFF 在线（销售单列表与经营 KPI 均为只读接口）'))
      .finally(() => setLoading(false))
  }, [range])

  useEffect(() => {
    load()
  }, [load])

  /** 顶部 KPI：逐字复用 BFF 下发的 kpi[]，前端不重算 */
  const kpis = useMemo(
    () => (report?.kpi ?? []).filter((k) => KPI_LABELS.indexOf(k.label) >= 0),
    [report],
  )

  const channels = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) if (r.channel) set.add(r.channel)
    return ['全部', ...Array.from(set)]
  }, [rows])

  const shown = useMemo(
    () =>
      rows.filter(
        (r) =>
          (channel === '全部' || r.channel === channel) &&
          (status === '全部' || r.status === status),
      ),
    [rows, channel, status],
  )

  const totalDebt = useMemo(() => rows.reduce((a, r) => a + (Number(r.debt) || 0), 0), [rows])

  const queueVoid = async (r: SaleListItem) => {
    try {
      await postAction({
        type: 'sale.void',
        operator: role ?? account ?? 'admin',
        payload: {
          id: String(r.no ?? r.id ?? ''),
          reason: '管理端作废',
          operator: role ?? account ?? 'admin',
          source: 'admin-web/dinein/sales',
        },
      })
      message.success('作废已入队 → 请到审批中心确认（作废保留原单行，不物理删除）')
      load()
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } } }
      message.error(er.response?.data?.error || '提交失败')
    }
  }

  const columns = [
    { title: '单号', dataIndex: 'no', width: 150 },
    { title: '日期', dataIndex: 'date', width: 110 },
    { title: '渠道', dataIndex: 'channel', width: 90, render: (v: string) => v || '-' },
    { title: '菜品明细', dataIndex: 'detail', ellipsis: true },
    { title: '售价合计', dataIndex: 'sub', align: 'right' as const, width: 100, render: fmt },
    { title: '折扣', dataIndex: 'discount', align: 'right' as const, width: 90, render: fmt },
    { title: '应收', dataIndex: 'receivable', align: 'right' as const, width: 100, render: fmt },
    { title: '实收', dataIndex: 'received', align: 'right' as const, width: 100, render: fmt },
    {
      title: '欠款',
      dataIndex: 'debt',
      align: 'right' as const,
      width: 100,
      render: (v: number) => <span style={{ color: v > 0 ? COLORS.red : undefined }}>{fmt(v)}</span>,
    },
    {
      title: '毛利率',
      dataIndex: 'gm',
      align: 'right' as const,
      width: 90,
      render: (v: number | null) => (v != null ? (v * 100).toFixed(1) + '%' : '-'),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: string, r: SaleListItem) =>
        v === '已作废' && r.void_operator ? (
          <Tag color={statusColor(v)} title={`作废人 ${r.void_operator} · ${r.void_at ?? ''}`}>
            {v}
          </Tag>
        ) : (
          <Tag color={statusColor(v)}>{v}</Tag>
        ),
    },
    {
      title: '操作',
      width: 190,
      render: (_: unknown, r: SaleListItem) => (
        <Space size={4}>
          <Typography.Link disabled={r.status === '已作废'} onClick={() => setEditTarget(r)}>
            编辑
          </Typography.Link>
          <Typography.Link
            disabled={r.status === '已作废' || !(Number(r.debt) > 0)}
            onClick={() => setPayTarget(r)}
          >
            收款
          </Typography.Link>
          <Popconfirm
            title="确认作废该销售单？"
            description="作废保留原单行（留痕不物理删除），作废后不计入应收/实收/欠款。"
            okText="确认作废"
            cancelText="取消"
            disabled={r.status === '已作废'}
            onConfirm={() => queueVoid(r)}
          >
            <Typography.Link disabled={r.status === '已作废'}>作废</Typography.Link>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }} size={4}>
          <Space wrap align="center">
            <Typography.Text strong>销售收银</Typography.Text>
            <span style={{ fontSize: 13 }}>统计周期：</span>
            {RANGE_OPTIONS.map((o) => (
              <Tag.CheckableTag
                key={o.value}
                checked={range === o.value}
                onChange={() => setRange(o.value)}
              >
                {o.label}
              </Tag.CheckableTag>
            ))}
            <Tooltip title="开启后：在「录入销售单」里手填的堂食/外卖真实出餐单，将复用移动端 POS 的配方 BOM 扣料逻辑自动扣减库存（平台导入单不扣，避免与平台自有 POS 重复）。关闭（默认）：仅记账、不扣料，保护现有数据。移动端 POS 结账始终扣料，不受此开关影响。">
              <Space size={6}>
                <Switch
                  size="small"
                  checked={deductOn}
                  loading={deductLoading}
                  onChange={toggleDeduct}
                />
                <Typography.Text style={{ fontSize: 13 }}>真实出餐扣料(POS)</Typography.Text>
              </Space>
            </Tooltip>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {report?.range_label ?? ''}
            {' '}应收按单日期、实收按收款日期、欠款为累计派生值（口径唯一出口在服务端）
          </Typography.Text>
        </Space>
      </Card>

      {/* FP-SALE-08 顶部 KPI：复用 routes/report.js 既有聚合，前端只渲染 */}
      <Row gutter={[16, 16]}>
        {kpis.map((kpi) => (
          <Col xs={12} md={6} key={kpi.label}>
            <Card>
              <Statistic title={kpi.label} value={kpi.value} />
              {kpi.sub && (
                <Typography.Text
                  style={{
                    fontSize: 12,
                    color:
                      /未收欠款/.test(kpi.label) && parseNum(kpi.value) > 0
                        ? COLORS.red
                        : COLORS.gray,
                  }}
                >
                  {kpi.sub}
                </Typography.Text>
              )}
            </Card>
          </Col>
        ))}
      </Row>

      {err && <Alert type="error" showIcon message={err} style={{ marginTop: 16 }} />}

      <Card
        size="small"
        style={{ marginTop: 16 }}
        title={`销售单列表（${shown.length} / ${rows.length} 单）`}
        extra={
          <Space wrap>
            <Button type="primary" onClick={() => setCreateOpen(true)}>
              录入销售单
            </Button>
            <Button onClick={() => setImportOpen(true)}>导入平台数据</Button>
            <Button onClick={() => setBatchOpen(true)}>批次管理</Button>
            <Button onClick={() => setAliasOpen(true)}>菜名映射</Button>
            <Select
              value={channel}
              style={{ width: 120 }}
              options={channels.map((c) => ({ value: c, label: c }))}
              onChange={setChannel}
            />
            <Select
              value={status}
              style={{ width: 120 }}
              options={STATUS_FILTERS.map((s) => ({ value: s, label: s }))}
              onChange={setStatus}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              未收欠款合计 ¥{fmt(totalDebt)}
            </Typography.Text>
          </Space>
        }
      >
        {loading ? (
          <Spin />
        ) : (
          <Table
            size="small"
            rowKey={(r) => String(r.id ?? r.no ?? '')}
            dataSource={shown}
            columns={columns}
            pagination={{ pageSize: 20, showSizeChanger: false }}
            locale={{ emptyText: '暂无销售单（销售单由销售端录入，走审批队列后生效）' }}
          />
        )}
      </Card>

      <SaleCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onQueued={load}
      />
      <SaleEditModal
        open={!!editTarget}
        sale={editTarget}
        onClose={() => setEditTarget(null)}
        onQueued={load}
      />
      <SalePayModal
        open={!!payTarget}
        sale={payTarget}
        onClose={() => setPayTarget(null)}
        onQueued={load}
      />
      <SaleImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onQueued={load}
      />
      <SaleBatchesModal
        open={batchOpen}
        onClose={() => setBatchOpen(false)}
        onQueued={load}
      />
      <DishAliasModal
        open={aliasOpen}
        onClose={() => setAliasOpen(false)}
        onQueued={load}
      />
    </div>
  )
}
