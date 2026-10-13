import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Card,
  Col,
  DatePicker,
  List,
  Row,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { useNavigate } from 'react-router-dom'
import dayjs, { type Dayjs } from 'dayjs'
import { fetchAnalysis, fetchReportDaily } from '../api'
import type {
  AlertItem,
  AnalysisResp,
  DailySeriesPoint,
  DebtSaleItem,
  ReportDaily,
  SaleListItem,
  TodoItem,
} from '../api/types'
import { resolveDeepLink } from '../config/menu'
import { COLORS } from '../theme'
import SalePayModal from './dinein/SalePayModal'

const LEVEL_TAG: Record<string, { color: string; text: string }> = {
  critical: { color: COLORS.red, text: '紧急' },
  warn: { color: COLORS.yellow, text: '预警' },
  info: { color: COLORS.purple, text: '提示' },
}

/** FP-DASH-01 周期选项：顺序与文案逐字照抄旧版 `#dashRange` chips（HTML:194-198） */
const RANGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '7', label: '近7天' },
  { value: '30', label: '近30天' },
  { value: 'all', label: '全部' },
]

/** 默认「近30天」：旧版 DASH_R=30（HTML:1221）且该 chip 默认 on（HTML:196） */
const DEFAULT_RANGE = '30'

/** FP-DASH-11 明细截断条数：旧版 `low.slice(0,12)`（HTML:1281） */
const LOW_STOCK_SHOWN = 12

/** 数值展示：千分位 + 最多 1 位小数（旧版 fmt(x,1)，HTML:1282） */
function fmtNum(n?: number | null): string {
  if (n == null || !isFinite(Number(n))) return '-'
  return Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 1 })
}

/* ---------------- FP-DASH-10 每日应收 vs 实收（近14天） ---------------- */

/** 旧版柱图几何（HTML:1258 `const W=620,H=210,PL=44,PB=38,PT=16`） */
const CHART = { W: 620, H: 210, PL: 44, PB: 38, PT: 16 }
/** 旧版柱图配色（HTML:1273-1275）：应收 #3D7EA6 / 实收 #1E8E5A / 当日新增欠款红点 #D93025 */
const CHART_COLORS = { receivable: '#3D7EA6', received: '#1E8E5A', debtDot: '#D93025' }
/** 旧版红点判据：当日「应收 − 实收 > 1 元」才画红点（HTML:1275 `recvMap[d]-gotMap[d]>1`） */
const NEW_DEBT_DOT_MIN = 1

/**
 * FP-DASH-10 14 天应收/实收双柱图（旧版 `#chartDaily` SVG，HTML:1258-1278 逐式对照）。
 * 数据由 BFF 下发（`daily_series`，口径唯一出口在 lib/sales_model.js），本组件只画图不重算。
 */
function DailyBars({ series }: { series: DailySeriesPoint[] }) {
  if (!series.length) return null
  const { W, H, PL, PB, PT } = CHART
  const maxV =
    Math.max(1, ...series.map((d) => Math.max(d.receivable ?? 0, d.received ?? 0))) * 1.15
  const bw = (W - PL - 14) / series.length
  /** 值 → y 坐标（旧版 Y(v)，HTML:1266） */
  const Y = (v: number) => H - PB - (v / maxV) * (H - PB - PT)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}>
      {/* 4 等分网格线 + 千元刻度（旧版 HTML:1268-1270） */}
      {[0, 1, 2, 3, 4].map((i) => {
        const v = (maxV * i) / 4
        const y = Y(v)
        return (
          <g key={i}>
            <line x1={PL} y1={y} x2={W - 10} y2={y} stroke="#eef1f5" />
            <text x={PL - 6} y={y + 3.5} fontSize={9.5} fill="#9ca3af" textAnchor="end">
              {(v / 1000).toFixed(1)}k
            </text>
          </g>
        )
      })}
      {series.map((d, i) => {
        const x = PL + i * bw + bw * 0.1
        const recv = d.receivable ?? 0
        const got = d.received ?? 0
        return (
          <g key={d.date}>
            <rect
              x={x}
              y={Y(recv)}
              width={bw * 0.36}
              height={Math.max(0, H - PB - Y(recv))}
              fill={CHART_COLORS.receivable}
              rx={1}
            >
              <title>{`${d.date} 应收 ¥${recv.toFixed(2)}`}</title>
            </rect>
            <rect
              x={x + bw * 0.4}
              y={Y(got)}
              width={bw * 0.36}
              height={Math.max(0, H - PB - Y(got))}
              fill={CHART_COLORS.received}
              rx={1}
            >
              <title>{`${d.date} 实收 ¥${got.toFixed(2)}`}</title>
            </rect>
            {/* 当日新增欠款红点（旧版 HTML:1275） */}
            {recv - got > NEW_DEBT_DOT_MIN && (
              <circle
                cx={x + bw * 0.38}
                cy={Y(recv) - 3}
                r={2.4}
                fill={CHART_COLORS.debtDot}
              >
                <title>{`${d.date} 当日新增欠款 ¥${(recv - got).toFixed(2)}`}</title>
              </circle>
            )}
            <text
              x={x + bw * 0.38}
              y={H - PB + 14}
              fontSize={9}
              fill="#6b7280"
              textAnchor="middle"
            >
              {d.date.slice(5)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/** 归一 kpi：BFF 的 kpi[] → 前端 kpis[] */
function normalizeReport(data: ReportDaily): ReportDaily {
  const kpis =
    data.kpis ??
    (Array.isArray(data.kpi)
      ? data.kpi.map((k, i) => ({
          key: k.label ?? String(i),
          label: k.label,
          value: k.value,
          delta: k.delta ?? undefined,
          sub: k.sub ?? undefined,
          trend: k.delta && String(k.delta).startsWith('-') ? ('down' as const) : ('up' as const),
        }))
      : [])
  const todos = (data.todos ?? []).map((t: TodoItem, i) => ({
    ...t,
    id: t.id ?? `t${i}`,
    title: t.title ?? t.text ?? '',
  }))
  const alerts = (data.alerts ?? []).map((a: AlertItem, i) => ({
    ...a,
    id: a.id ?? `a${i}`,
    title: a.title ?? a.text ?? '',
  }))
  return { ...data, kpis, todos, alerts }
}

function ageMinutes(iso?: string | null): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((Date.now() - t) / 60000))
}

/** 从 kpi 值（可能是 ¥12,860 字符串）解析数字 */
function parseNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) && String(v ?? '') !== '' ? n : null
}

/** 从 report kpis 中取今日营收（兼容 kpi/kpis 两种形状） */
function todayRevenue(report: ReportDaily | null): number | null {
  if (!report) return null
  const list = report.kpis ?? []
  const hit = list.find((k) => /营业额|营收/.test(k.label ?? '') || k.key === 'revenue')
  if (hit) return parseNum(hit.value)
  const raw = (report.kpi ?? []).find((k) => /营业额|营收/.test(k.label ?? ''))
  return raw ? parseNum(raw.value) : null
}

export default function DashboardPage() {
  const navigate = useNavigate()
  const [report, setReport] = useState<ReportDaily | null>(null)
  const [analysis, setAnalysis] = useState<AnalysisResp | null>(null)
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [date, setDate] = useState<Dayjs>(dayjs())
  /** FP-DASH-01 统计周期（'7' | '30' | 'all'） */
  const [range, setRange] = useState<string>(DEFAULT_RANGE)
  /** FP-DASH-14：行内「收款」登记的销售单（走 sale.pay 审批队列，无写权限则由 BFF 挡） */
  const [payTarget, setPayTarget] = useState<SaleListItem | null>(null)
  /** 收款入队后重取快照 + 报表（等审批执行后账面才变，此处只刷新读侧） */
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let alive = true
    fetchReportDaily(date.format('YYYY-MM-DD'), range)
      .then((data) => {
        if (!alive) return
        const n = normalizeReport(data)
        setReport(n)
        setIsMock(!!n.mock)
      })
      .catch(() => {
        if (alive) setIsMock(true)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [date, range, reloadKey])

  useEffect(() => {
    fetchAnalysis()
      .then((a) => setAnalysis(a))
      .catch(() => setAnalysis(null))
  }, [])

  const age = useMemo(() => ageMinutes(report?.generated_at), [report?.generated_at])
  const stale = age != null && age > 15

  /** 保本卡数据：优先 report.breakeven（动态），否则 baoben_summary.kpi（静态价盘） */
  const baoben = useMemo(() => {
    const kpi = analysis?.baoben_summary?.kpi ?? {}
    const be = report?.breakeven
    const live = !!(be && be.be_day != null)
    const beDay = live ? be!.be_day! : kpi.be_day
    const todayRev = live ? be!.today_rev ?? null : todayRevenue(report)
    const attain =
      live && be!.attain_pct != null
        ? be!.attain_pct
        : beDay && todayRev != null
          ? (todayRev / beDay) * 100
          : null
    if (beDay == null && kpi.safety == null && kpi.month_profit == null) return null
    return {
      live,
      beDay: beDay ?? null,
      todayRev,
      attain,
      safety: kpi.safety ?? null,
      monthProfit: kpi.month_profit ?? null,
    }
  }, [analysis, report])

  if (loading || !report) {
    return (
      <div style={{ textAlign: 'center', padding: 80 }}>
        <Spin size="large" />
      </div>
    )
  }

  const heat = (report.heat_mini ?? []).map((h) =>
    typeof h === 'number' ? h : (h.orders ?? 0),
  )
  const heatMax = Math.max(1, ...heat)

  /** FP-DASH-11 低库存预警明细（旧版 #lowStockBox，HTML:1280-1285） */
  const lowStockItems = report?.low_stock?.items ?? []
  const lowStockTotal = Number(report?.low_stock?.total ?? lowStockItems.length)
  const lowStockShown = lowStockItems.slice(0, LOW_STOCK_SHOWN)

  /** FP-DASH-10 近14天应收/实收逐日序列（BFF `daily_series`；空数组不出图，不编造） */
  const dailySeries = report?.daily_series ?? []
  /** 14 天全零：照旧画轴（旧版行为），另加一行说明，避免「空白图」被误读成加载失败 */
  const seriesAllZero =
    dailySeries.length > 0 && dailySeries.every((d) => !d.receivable && !d.received)
  /** FP-DASH-13 未收账款（客户挂账）清单（BFF `debt_sales`，欠款 > 0.01，按单日期倒序） */
  const debtSales = report?.debt_sales ?? []
  const debtTotal = debtSales.reduce((a, r) => a + (Number(r.debt) || 0), 0)

  /** FP-DASH-12 低库存行「去采购」：跳「采购管理」并把该原料带进采购单草稿（旧版 HTML:1312 `go('po')+openOrder(null,ing)`） */
  const goPurchase = (ingId?: string | null) => {
    if (!ingId) return
    navigate('/inventory/purchase', { state: { poIng: String(ingId) } })
  }

  /** FP-DASH-14 行内「收款」：把挂账行按销售单形状交给 SalePayModal（口径字段来自 BFF） */
  const debtRowToSale = (r: DebtSaleItem): SaleListItem => ({
    id: r.id ?? null,
    no: r.no ?? null,
    date: r.date,
    channel: r.channel,
    receivable: r.receivable,
    received: r.received,
    debt: r.debt,
    status: r.status,
  })

  return (
    <div>
      {isMock && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="演示数据（/api/report/daily mock 或 BFF 不可用）"
        />
      )}
      {!isMock && stale && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`快照时延 ${age} 分钟（>15 分钟标黄），rev=${report.rev ?? '-'}`}
        />
      )}
      {!isMock && !stale && age != null && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={`${age} 分钟前更新 · rev=${report.rev ?? '-'}`}
        />
      )}

      <div
        style={{
          background: COLORS.aiGradient,
          borderRadius: 8,
          padding: '24px 28px',
          color: '#fff',
          marginBottom: 16,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <Typography.Title level={4} style={{ color: '#fff', margin: 0 }}>
            经营看板 · {report.date}
          </Typography.Title>
          <DatePicker
            value={date}
            allowClear={false}
            disabledDate={(d) => d.isAfter(dayjs(), 'day')}
            onChange={(d) => d && setDate(d)}
          />
        </div>
        {/* FP-DASH-01 统计周期：chips（旧版 #dashRange HTML:194-198）+ 区间文字（旧版 dashDateTip :200/:1235） */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 10,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 13, opacity: 0.92 }}>统计周期：</span>
          {RANGE_OPTIONS.map((o) => (
            <Tag.CheckableTag
              key={o.value}
              checked={range === o.value}
              onChange={() => setRange(o.value)}
              data-range={o.value}
            >
              {o.label}
            </Tag.CheckableTag>
          ))}
          <span style={{ fontSize: 12, opacity: 0.85 }} data-range-label>
            {report.range_label ?? ''}
          </span>
        </div>
        <div style={{ marginTop: 8, opacity: 0.92 }}>
          {report.banner ?? '五福临门，今日加油！'}
        </div>
        {report.kitchen && (
          <div style={{ marginTop: 8, fontSize: 13, opacity: 0.9 }}>
            今日工单 {report.kitchen.workorders_done ?? 0}/{report.kitchen.workorders_total ?? 0}
          </div>
        )}
      </div>

      {baoben && (
        <Card
          size="small"
          style={{ marginBottom: 16, borderLeft: `4px solid ${COLORS.purple}` }}
          title={
            <Space size={8}>
              <span>保本经营</span>
              <Tag color={baoben.live ? COLORS.green : COLORS.yellow}>
                {baoben.live ? '动态实况' : '静态价盘'}
              </Tag>
            </Space>
          }
        >
          <Row gutter={[16, 8]}>
            <Col xs={12} md={4}>
              <Statistic
                title="日保本"
                value={baoben.beDay != null ? baoben.beDay.toFixed(0) : '-'}
                prefix="¥"
              />
            </Col>
            <Col xs={12} md={5}>
              <Statistic
                title="今日营收"
                value={baoben.todayRev != null ? baoben.todayRev.toFixed(0) : '-'}
                prefix="¥"
              />
            </Col>
            <Col xs={12} md={5}>
              <Statistic
                title="保本达成率"
                value={baoben.attain != null ? baoben.attain.toFixed(1) : '-'}
                suffix="%"
                valueStyle={{
                  color:
                    baoben.attain == null
                      ? undefined
                      : baoben.attain >= 100
                        ? COLORS.green
                        : COLORS.red,
                }}
              />
            </Col>
            <Col xs={12} md={5}>
              <Statistic
                title="安全边际"
                value={baoben.safety != null ? baoben.safety.toFixed(1) : '-'}
                suffix="%"
              />
            </Col>
            <Col xs={12} md={5}>
              <Statistic
                title="月利润预测"
                value={baoben.monthProfit != null ? baoben.monthProfit.toFixed(0) : '-'}
                prefix="¥"
              />
            </Col>
          </Row>
        </Card>
      )}

      <Row gutter={[16, 16]}>
        {(report.kpis ?? []).map((kpi) => (
          <Col xs={12} sm={12} md={6} key={kpi.key}>
            <Card>
              <Statistic title={kpi.label} value={kpi.value} suffix={kpi.unit} />
              {kpi.sub && (
                <Typography.Text
                  style={{
                    fontSize: 12,
                    // FP-DASH-04：未收欠款 > 0 时副标标红（纯展示，不改口径）
                    color:
                      /未收欠款/.test(kpi.label ?? '') && (parseNum(kpi.value) ?? 0) > 0
                        ? COLORS.red
                        : COLORS.gray,
                  }}
                >
                  {kpi.sub}
                </Typography.Text>
              )}
              {kpi.delta && (
                <Typography.Text
                  style={{
                    fontSize: 12,
                    color: kpi.trend === 'down' ? COLORS.red : COLORS.green,
                  }}
                >
                  {kpi.trend === 'down' ? '↓' : '↑'} {kpi.delta}
                </Typography.Text>
              )}
            </Card>
          </Col>
        ))}
      </Row>

      {/* FP-DASH-10 每日应收 vs 实收（近14天）+ FP-DASH-13 未收账款（客户挂账）
          （旧版 #tab-dash 两两并排的 grid2 布局：HTML:203-227） */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={14}>
          <Card title="每日应收 vs 实收（近14天）" size="small">
            {dailySeries.length === 0 ? (
              <div style={{ color: COLORS.gray, fontSize: 12 }}>
                近 14 天暂无销售/收款记录（序列由服务端口径下发，无数据不出图）
              </div>
            ) : (
              <>
                <DailyBars series={dailySeries} />
                <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 12 }}>
                  <span>
                    <i
                      style={{
                        display: 'inline-block',
                        width: 10,
                        height: 10,
                        background: CHART_COLORS.receivable,
                        marginRight: 4,
                      }}
                    />
                    应收（挂账前）
                  </span>
                  <span>
                    <i
                      style={{
                        display: 'inline-block',
                        width: 10,
                        height: 10,
                        background: CHART_COLORS.received,
                        marginRight: 4,
                      }}
                    />
                    实收
                  </span>
                  <span>
                    <i
                      style={{
                        display: 'inline-block',
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        background: CHART_COLORS.debtDot,
                        marginRight: 4,
                      }}
                    />
                    当日新增欠款
                  </span>
                </div>
                {seriesAllZero && (
                  <div style={{ color: COLORS.gray, fontSize: 12, marginTop: 2 }}>
                    近 14 天应收与实收均为 0（快照内该区间无销售/收款记录），轴照常保留
                  </div>
                )}
              </>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card
            title="未收账款（客户挂账）"
            size="small"
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {debtSales.length} 单 · 欠款合计 ¥{fmtNum(debtTotal)}
              </Typography.Text>
            }
          >
            {debtSales.length === 0 ? (
              <div style={{ color: COLORS.green }}>暂无挂账欠款 ✅</div>
            ) : (
              <Table<DebtSaleItem>
                size="small"
                rowKey={(r) => String(r.id ?? r.no ?? '')}
                dataSource={debtSales}
                pagination={false}
                scroll={{ y: 240 }}
                columns={[
                  {
                    title: '单据',
                    dataIndex: 'no',
                    render: (_, r) => (
                      <div>
                        <span>
                          {String(r.no ?? r.id ?? '-').slice(-8)} · {r.date}
                        </span>
                        <div>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {r.note || r.channel || ''}
                          </Typography.Text>
                        </div>
                      </div>
                    ),
                  },
                  {
                    title: '应收',
                    dataIndex: 'receivable',
                    align: 'right',
                    width: 90,
                    render: (v) => '¥' + fmtNum(v),
                  },
                  {
                    title: '欠款',
                    dataIndex: 'debt',
                    align: 'right',
                    width: 90,
                    render: (v) => (
                      <span style={{ color: COLORS.red }}>¥{fmtNum(v)}</span>
                    ),
                  },
                  {
                    title: '操作',
                    width: 70,
                    render: (_, r) => (
                      <Typography.Link onClick={() => setPayTarget(debtRowToSale(r))}>
                        收款
                      </Typography.Link>
                    ),
                  },
                ]}
              />
            )}
          </Card>
        </Col>
      </Row>

      {/* FP-DASH-15 菜品毛利排行（近30天 Top12：份数/营收/毛利/毛利率） */}
      {(report.top_dishes ?? []).length > 0 && (
        <Card title="菜品毛利排行（近30天 Top12）" size="small" style={{ marginTop: 16 }}>
          <Table
            size="small"
            pagination={false}
            rowKey="rank"
            dataSource={(report.top_dishes ?? []).slice(0, 12)}
            columns={[
              { title: '#', dataIndex: 'rank', width: 44 },
              { title: '菜品', dataIndex: 'name' },
              { title: '分类', dataIndex: 'cat', width: 80 },
              { title: '份数', dataIndex: 'qty', align: 'right', render: (v) => fmtNum(v) },
              { title: '营收', dataIndex: 'rev', align: 'right', render: (v) => '¥' + fmtNum(v) },
              { title: '毛利额', dataIndex: 'gp', align: 'right', render: (v) => '¥' + fmtNum(v) },
              {
                title: '毛利率',
                dataIndex: 'gm',
                align: 'right',
                render: (v) => (v != null ? (v * 100).toFixed(1) + '%' : '-'),
              },
            ]}
          />
        </Card>
      )}

      {heat.length > 0 && (
        <Card title="时段热力（迷你）" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {heat.map((v, i) => {
              const cell = report.heat_mini?.[i]
              const hour = typeof cell === 'object' && cell ? cell.hour : i
              const alpha = 0.15 + (v / heatMax) * 0.85
              return (
                <div
                  key={i}
                  title={`${hour}时 · ${v} 单`}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 4,
                    background: `rgba(155, 107, 191, ${alpha})`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 10,
                    color: alpha > 0.5 ? '#fff' : COLORS.primary,
                  }}
                >
                  {hour}
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* FP-DASH-11 低库存预警明细（旧版「库存预警」卡 #lowStockBox，HTML:1280-1285） */}
      <Card
        title={`库存预警（低于安全线 · ${lowStockTotal} 种）`}
        size="small"
        style={{ marginTop: 16 }}
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            详见「原料库存」
          </Typography.Text>
        }
      >
        {lowStockTotal === 0 ? (
          <div style={{ color: COLORS.green }}>所有原料库存均高于安全线 ✅</div>
        ) : (
          <>
            <List
              size="small"
              dataSource={lowStockShown}
              renderItem={(it) => (
                <List.Item>
                  <span>
                    {it.name}
                    {it.cat ? (
                      <span style={{ color: '#888', fontSize: 12 }}> [{it.cat}]</span>
                    ) : null}
                  </span>
                  <Space size={12}>
                    <Typography.Text style={{ color: COLORS.red }}>
                      现存 {fmtNum(it.qty)} {it.unit || ''}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      安全 {fmtNum(it.safe)} {it.unit || ''}
                    </Typography.Text>
                    {/* FP-DASH-12 行内「去采购」（旧版 data-poing，HTML:1283/1312）：带该原料进采购单草稿 */}
                    <Tooltip title={it.id ? '跳「采购管理」并把该原料带进采购单草稿' : '该原料无主数据 id，无法带入采购单'}>
                      <Typography.Link
                        disabled={!it.id}
                        onClick={() => goPurchase(it.id)}
                        data-poing={it.id ?? undefined}
                      >
                        去采购
                      </Typography.Link>
                    </Tooltip>
                  </Space>
                </List.Item>
              )}
            />
            {lowStockTotal > LOW_STOCK_SHOWN && (
              <div style={{ color: '#888', fontSize: 12, marginTop: 6 }}>
                等 {lowStockTotal} 种，详见「原料库存」
              </div>
            )}
          </>
        )}
      </Card>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} md={12}>
          <Card title="待办事项">
            <List
              dataSource={report.todos ?? []}
              locale={{ emptyText: '暂无待办' }}
              renderItem={(item) => {
                const link = resolveDeepLink(
                  `${item.title ?? ''} ${item.source ?? ''} ${item.text ?? ''} ${item.desc ?? ''}`,
                  { route: item.route, kind: item.kind },
                )
                return (
                  <List.Item
                    style={link ? { cursor: 'pointer' } : undefined}
                    onClick={() => link && navigate(link)}
                    actions={
                      link
                        ? [
                            <Typography.Link key="go" onClick={() => navigate(link)}>
                              去处理
                            </Typography.Link>,
                          ]
                        : undefined
                    }
                  >
                    <div>
                      <Typography.Text delete={item.done}>{item.title}</Typography.Text>
                      {item.desc && (
                        <div>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {item.desc}
                          </Typography.Text>
                        </div>
                      )}
                    </div>
                    <Space size={4}>
                      {item.kind && <Tag>{item.kind}</Tag>}
                      {item.source && <Tag>{item.source}</Tag>}
                    </Space>
                  </List.Item>
                )
              }}
            />
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title="预警">
            <List
              dataSource={report.alerts ?? []}
              locale={{ emptyText: '暂无预警' }}
              renderItem={(item) => {
                const tag = LEVEL_TAG[item.level] ?? LEVEL_TAG.info
                const link = resolveDeepLink(
                  `${item.title ?? ''} ${item.detail ?? ''} ${item.text ?? ''} ${item.desc ?? ''}`,
                )
                return (
                  <List.Item
                    style={link ? { cursor: 'pointer' } : undefined}
                    onClick={() => link && navigate(link)}
                    actions={
                      link
                        ? [
                            <Typography.Link key="go" onClick={() => navigate(link)}>
                              去处理
                            </Typography.Link>,
                          ]
                        : undefined
                    }
                  >
                    <div>
                      <Typography.Text>{item.title}</Typography.Text>
                      {item.detail && (
                        <div>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {item.detail}
                          </Typography.Text>
                        </div>
                      )}
                    </div>
                    <Tag color={tag.color}>{tag.text}</Tag>
                  </List.Item>
                )
              }}
            />
          </Card>
        </Col>
      </Row>

      {/* FP-DASH-14 未收账款行内「收款」登记（旧版 data-get→openGet('S',…)，HTML:1313）：
          与「销售收银」页复用同一 SalePayModal（sale.pay 审批队列），不另写收款逻辑 */}
      <SalePayModal
        open={!!payTarget}
        sale={payTarget}
        onClose={() => setPayTarget(null)}
        onQueued={() => setReloadKey((k) => k + 1)}
      />
    </div>
  )
}
