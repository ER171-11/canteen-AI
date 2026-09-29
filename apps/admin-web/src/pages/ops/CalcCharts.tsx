import { type ReactNode } from 'react'
import { Button, Card, Col, Row, Space, Table, Typography } from 'antd'
import type { BaobenKpi, BaobenParams, BaobenScene } from '../../api/types'

/**
 * 结构测算 · 图表与情景（只读）
 * 源：旧版 `renderCalcCharts`（HTML:4092-4139）、`renderCalcScene`（HTML:4144-4208）
 * 画法为同尺寸 SVG（viewBox 560×150 / 560×108 / 560×230），不引入图表依赖。
 */

/** 旧版配色（HTML:4102-4121、:4142），保持视觉一致 */
const C = {
  rev: '#3D7EA6',
  be: '#D93025',
  safe: '#1E8E5A',
  pur: '#6B4C9A',
  gold: '#B7791F',
  gray: '#9CA3AF',
  orange: '#E8734A',
  lightBlue: '#7BA7C4',
  lightGray: '#C4C4C4',
  darkRed: '#7F1D1D',
} as const

const fmt = (n?: number | null, d = 2) =>
  n == null || !Number.isFinite(Number(n))
    ? '—'
    : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d })

const pct = (ratio?: number | null, d = 0) =>
  ratio == null || !Number.isFinite(Number(ratio))
    ? '—'
    : `${(Number(ratio) * 100).toFixed(d)}%`

const SVG = { width: '100%', height: 'auto', display: 'block' } as const

/** 图例项（对齐旧版 legend 的圆点 + 文案） */
function Legend({ items }: { items: Array<{ color: string; text: string }> }) {
  return (
    <Space size={12} wrap style={{ marginTop: 6 }}>
      {items.map((it) => (
        <span key={it.text} style={{ fontSize: 12, color: '#666' }}>
          <i
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: 2,
              background: it.color,
              marginRight: 4,
            }}
          />
          {it.text}
        </span>
      ))}
    </Space>
  )
}

/** FP-CALC-16 日营收 vs 保本线 */
function BeChart({ kpi }: { kpi: BaobenKpi }) {
  const dayRev = Number(kpi.day_rev) || 0
  const beDay = Number(kpi.be_day) || 0
  const W = 560
  const H = 150
  const PL = 8
  const max = Math.max(dayRev, beDay) * 1.18 || 1
  const bw = W - PL - 10
  const w1 = Math.max((bw * dayRev) / max, 1)
  const w2 = Math.max((bw * beDay) / max, 1)
  const ok = dayRev >= beDay
  const diff = dayRev - beDay
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={SVG}>
      <rect x={PL} y={26} width={w1} height={34} fill={C.rev} rx={3} />
      <text x={PL + w1 + 8} y={49} fontSize={12.5} fill={C.rev} fontWeight={700}>
        预估 {fmt(dayRev)} 元/天
      </text>
      <rect x={PL} y={76} width={w2} height={34} fill={C.be} rx={3} opacity={0.9} />
      <text x={PL + w2 + 8} y={99} fontSize={12.5} fill={C.be} fontWeight={700}>
        保本线 {fmt(beDay)} 元/天
      </text>
      <line
        x1={PL + w2}
        y1={20}
        x2={PL + w2}
        y2={H - 18}
        stroke={C.be}
        strokeDasharray="4 3"
        strokeWidth={1.2}
      />
      <text
        x={PL}
        y={132}
        fontSize={13}
        fontWeight={700}
        fill={ok ? C.safe : C.be}
      >{`${ok ? '安全边际' : '缺口'} ${fmt(Math.abs(diff))} 元/天（${pct(
        Math.abs(Number(kpi.safety) || 0) / 100,
        0,
      )}）`}</text>
      <text x={PL} y={H - 2} fontSize={11} fill="#6b7280">
        {ok
          ? `相当于每天可少做 ${fmt(Math.abs(diff))} 元仍不亏损`
          : `需每天多卖 ${fmt(Math.abs(diff))} 元才能保本`}
      </text>
    </svg>
  )
}

/** FP-CALC-17 月营收成本结构（占营收 %） */
function CostChart({ kpi }: { kpi: BaobenKpi }) {
  const mr = Number(kpi.month_rev) || 1
  const items: Array<[string, number, string]> = [
    ['食材+酒水成本', Number(kpi.cost_bev_month) || 0, C.be],
    ['其他变动成本(外卖佣金/营销/能耗/杂费)', Number(kpi.var_other_month) || 0, C.orange],
    ['人工成本', Number(kpi.labor) || 0, C.pur],
    ['租金', Number(kpi.rent) || 0, C.rev],
    ['物业', Number(kpi.prop) || 0, C.lightBlue],
    ['装修设备摊销', Number(kpi.amort) || 0, C.gold],
    ['能耗(固定)', Number(kpi.util_fix) || 0, C.gray],
    ['其他固定', Number(kpi.other) || 0, C.lightGray],
  ]
  const used = items.reduce((a, b) => a + b[1], 0)
  const prof = mr - used
  if (prof >= 0) items.push(['净利润', prof, C.safe])
  else items.push(['亏损', -prof, C.darkRed])
  const tot = items.reduce((a, b) => a + b[1], 0) || 1

  const W = 560
  const H = 108
  let x = 0
  const segs: ReactNode[] = []
  const legends: Array<{ color: string; text: string }> = []
  for (const [n, v, c] of items) {
    const w = (v / tot) * (W - 16)
    segs.push(
      <rect key={n} x={8 + x} y={34} width={Math.max(w, 0.6)} height={40} fill={c} />,
    )
    if (w > 46) {
      segs.push(
        <text
          key={`${n}-t`}
          x={8 + x + w / 2}
          y={59}
          fontSize={10.5}
          fill="#fff"
          textAnchor="middle"
          fontWeight={600}
        >
          {((v / tot) * 100).toFixed(0)}%
        </text>,
      )
    }
    legends.push({ color: c, text: `${n} ${fmt(v)}（${pct(v / mr, 1)}）` })
    x += w
  }
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} style={SVG}>
        <text x={8} y={20} fontSize={11.5} fill="#6b7280">
          月营收 {fmt(mr)} 元 · 100% 分解
        </text>
        {segs}
        <text x={8} y={96} fontSize={12} fontWeight={700} fill={prof >= 0 ? C.safe : C.be}>
          {prof >= 0
            ? `月净利润 ${fmt(prof)} 元（净利率 ${pct(prof / mr, 1)}）`
            : `月亏损 ${fmt(-prof)} 元`}
        </text>
      </svg>
      <Legend items={legends} />
    </>
  )
}

/** FP-CALC-18 客流情景曲线 */
function SceneChart({
  scenes,
  kpi,
  params,
}: {
  scenes: BaobenScene[]
  kpi: BaobenKpi
  params?: BaobenParams
}) {
  const days = Number(params?.days) || 30
  const targetProfit = Number(params?.target_profit) || 0
  const dayRev = Number(kpi.day_rev) || 0
  const beDay = Number(kpi.be_day) || 0
  const cm = (Number(kpi.contribution_margin) || 0) / 100
  const finite = Number.isFinite(beDay)

  const ks: number[] = []
  for (let k = 0.3; k <= 1.65 + 1e-9; k += 0.05) ks.push(Number(k.toFixed(2)))
  const vals = ks.map((k) => ({ k, p: finite ? (dayRev * k * days - beDay * days) * cm : 0 }))
  const maxP = Math.max(...vals.map((v) => v.p), targetProfit, 1) * 1.1
  const minP = Math.min(...vals.map((v) => v.p), 0) * 1.1

  const W = 560
  const H = 230
  const PL = 52
  const PB = 46
  const PT = 16
  const X = (k: number) => PL + ((k - 0.3) / (1.65 - 0.3)) * (W - PL - 14)
  const Y = (p: number) => PT + ((maxP - p) / (maxP - minP || 1)) * (H - PB - PT)

  const grid = [0, maxP / 2, maxP].map((v) => (
    <g key={`g${v}`}>
      <line x1={PL} y1={Y(v)} x2={W - 14} y2={Y(v)} stroke="#eef1f5" />
      <text x={PL - 8} y={Y(v) + 4} fontSize={10} fill={C.gray} textAnchor="end">
        {fmt(v / 10000, 1)}万
      </text>
    </g>
  ))

  const path = vals.map((v, i) => `${i ? 'L' : 'M'}${X(v.k)} ${Y(v.p)}`).join('')
  const breakK = dayRev ? beDay / dayRev : 0
  const rows = scenes.map((s) => ({
    ...s,
    profit: Number(s.month_profit) || 0,
    monthRev: Number(s.month_rev) || 0,
    color:
      s.k === 0.55 ? C.gray : s.k === 0.75 ? C.rev : s.k === 1 ? C.gold : s.k === 1.15 ? C.safe : C.pur,
    ok: s.above_be !== false,
  }))

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={SVG}>
      {grid}
      <line x1={PL} y1={Y(0)} x2={W - 14} y2={Y(0)} stroke={C.be} strokeWidth={1.4} />
      <text x={W - 14} y={Y(0) - 6} fontSize={10.5} fill={C.be} textAnchor="end">
        盈亏平衡线
      </text>
      {targetProfit > 0 && targetProfit < maxP && (
        <>
          <line
            x1={PL}
            y1={Y(targetProfit)}
            x2={W - 14}
            y2={Y(targetProfit)}
            stroke={C.safe}
            strokeDasharray="4 3"
          />
          <text x={PL + 4} y={Y(targetProfit) - 5} fontSize={10} fill={C.safe}>
            目标利润 {fmt(targetProfit)}
          </text>
        </>
      )}
      <path d={path} fill="none" stroke={C.rev} strokeWidth={2.4} />
      {breakK > 0.3 && breakK < 1.65 && (
        <>
          <circle cx={X(breakK)} cy={Y(0)} r={5} fill={C.be} />
          <text x={X(breakK)} y={Y(0) + 18} fontSize={10.5} fill={C.be} textAnchor="middle">
            保本 {breakK.toFixed(2)}×
          </text>
        </>
      )}
      {rows.map((r) => (
        <g key={String(r.k)}>
          <circle cx={X(Number(r.k))} cy={Y(r.profit)} r={4.5} fill={r.color} stroke="#fff" strokeWidth={1.5} />
          <text x={X(Number(r.k))} y={Y(r.profit) - 10} fontSize={10} fill="#374151" textAnchor="middle">
            {fmt(r.profit / 10000, 1)}万
          </text>
        </g>
      ))}
      {[0.4, 0.7, 1.0, 1.3, 1.6].map((k) => (
        <text key={`x${k}`} x={X(k)} y={H - PB + 18} fontSize={10.5} fill="#6b7280" textAnchor="middle">
          {k.toFixed(1)}×
        </text>
      ))}
      <text x={(PL + W) / 2} y={H - 6} fontSize={11} fill={C.gray} textAnchor="middle">
        客流系数（1.00 = 当前菜品销量设定）
      </text>
    </svg>
  )
}

export default function CalcCharts({
  scenes,
  kpi,
  effParams,
  loading,
  onSync,
  canSync,
}: {
  scenes: BaobenScene[]
  kpi: BaobenKpi
  effParams?: BaobenParams
  loading?: boolean
  /** FP-CALC-07 同步菜品主数据：按最新快照/配方重置测算输入 */
  onSync: () => void
  canSync: boolean
}) {
  const days = Number(effParams?.days) || 30
  const dayRev = Number(kpi.day_rev) || 0
  const beDay = Number(kpi.be_day) || 0
  const cm = (Number(kpi.contribution_margin) || 0) / 100
  const guests = Number(kpi.guests) || 0
  const targetProfit = Number(effParams?.target_profit) || 0

  const bk = dayRev ? beDay / dayRev : 0
  const needK = bk > 0 && cm > 0 ? (beDay * days + targetProfit / cm) / (dayRev * days) : 0

  return (
    <>
      <Card
        size="small"
        title="三、保本测算与盈亏"
        loading={loading}
        extra={
          <Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              保本日营收 = 月固定成本 ÷ 边际贡献率 ÷ 月营业天数
            </Typography.Text>
            <Button size="small" onClick={onSync} disabled={!canSync}>
              同步菜品主数据
            </Button>
          </Space>
        }
      >
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>日营收 vs 保本线</div>
            <BeChart kpi={kpi} />
            <Legend
              items={[
                { color: C.rev, text: '预估日营收' },
                { color: C.be, text: '保本线' },
                { color: C.safe, text: '安全边际' },
              ]}
            />
          </Col>
          <Col xs={24} lg={12}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>月营收成本结构（占营收 %）</div>
            <CostChart kpi={kpi} />
          </Col>
        </Row>
      </Card>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}>
          <Card size="small" title="客流情景模拟（以当前菜品销量为 1.00 倍）" loading={loading}>
            <SceneChart scenes={scenes} kpi={kpi} params={effParams} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="分情景经营结果" loading={loading}>
            <Table
              size="small"
              rowKey={(r) => String(r.name)}
              dataSource={scenes}
              pagination={false}
              columns={[
                {
                  title: '情景',
                  dataIndex: 'name',
                  render: (v: string | undefined) => <Typography.Text strong>{v ?? '-'}</Typography.Text>,
                },
                { title: '客流系数', dataIndex: 'k', width: 84, render: (v?: number) => Number(v ?? 0).toFixed(2) },
                {
                  title: '日客流',
                  dataIndex: 'guests',
                  width: 92,
                  render: (v?: number) => `${fmt(v, 0)} 人`,
                },
                { title: '日营收', dataIndex: 'day_rev', width: 96, render: (v?: number) => fmt(v) },
                { title: '月营收', dataIndex: 'month_rev', width: 106, render: (v?: number) => fmt(v) },
                {
                  title: '月利润',
                  dataIndex: 'month_profit',
                  width: 106,
                  render: (v?: number) => (
                    <Typography.Text strong type={(Number(v) || 0) >= 0 ? 'success' : 'danger'}>
                      {fmt(v)}
                    </Typography.Text>
                  ),
                },
                {
                  title: '净利率',
                  width: 84,
                  render: (_: unknown, r: BaobenScene) =>
                    r.month_rev ? pct((Number(r.month_profit) || 0) / Number(r.month_rev), 1) : '—',
                },
              ]}
            />
            <div style={{ marginTop: 8, fontSize: 12, lineHeight: '20px' }}>
              {bk > 0 ? (
                <>
                  当前设定相当于保本客流的 <b>{(1 / bk).toFixed(2)} 倍</b>（保本系数 {bk.toFixed(2)}×）。即客流只要
                  达到当前设定的 <b>{pct(bk, 0)}</b> 即可保本；
                  {needK > 0 && (
                    <>
                      若要实现目标月利润 {fmt(targetProfit, 0)} 元，需客流系数约 <b>{needK.toFixed(2)}×</b>，对应日均{' '}
                      <b>{fmt(guests * needK, 0)} 人</b>。
                    </>
                  )}
                  <br />
                  <span style={{ color: C.gold }}>
                    注：表中利润为线性模型理论值（固定成本不随客流变化）。实际客流超过保本线 1.5
                    倍后通常需增派人手、加大营销，净利率会回落至行业优秀水平 10%-15%，请以该区间作保守预期。
                  </span>
                </>
              ) : (
                '当前参数下无有效保本点（边际贡献率过低或客流为 0），请检查变动成本率与菜品销量设置。'
              )}
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
              {`基准：日营收 ¥${fmt(dayRev)} · 日保本 ¥${fmt(beDay)} · 边际贡献率 ${pct(cm, 2)}`}
            </Typography.Text>
          </Card>
        </Col>
      </Row>
    </>
  )
}
