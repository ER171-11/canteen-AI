import { Card, Empty, Typography } from 'antd'
import type { BaobenType } from '../../api/types'
import { CALC_TYPE_COLOR } from './calcSim'

/**
 * 结构测算 · 菜品结构（五类角色）卡片
 * 源：旧版 `#typeCards` + `renderCalcTypes`（HTML:387、:3978-4019）。
 * 逐卡展示 引流/爆品/利润/形象/常规 五类角色的 道数 / 日销量 / 销量占比 /
 * 日营收 / 营收占比 / 成本率 / 日毛利额 / 毛利占比。
 *
 * 与左栏「四象限分布」（波士顿口径，WeeklyReportPage）**并列存在**，不替换既有口径。
 * 指标一律取后端回传 `baoben_summary.types`（含 `qty_share`），前端不持第二份公式。
 * 本轮只读：不写库、不入队。
 */

const fmt = (v: number | undefined | null, d = 2) =>
  v == null
    ? '-'
    : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d })

const pct = (v: number | undefined | null, d = 0) => (v == null ? '-' : `${fmt(v, d)}%`)

function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        fontSize: 12,
        lineHeight: '20px',
      }}
    >
      <span style={{ color: '#8C8C8C' }}>{label}</span>
      <b style={color ? { color } : undefined}>{value}</b>
    </div>
  )
}

export default function CalcTypeCards({
  types,
  loading,
}: {
  types: BaobenType[]
  loading?: boolean
}) {
  return (
    <Card
      title="菜品结构（五类角色）"
      size="small"
      style={{ marginTop: 16 }}
      loading={loading}
      extra={
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          静态价盘口径 · 引流 / 爆品 / 利润 / 形象 / 常规
        </Typography.Text>
      }
    >
      {types.length === 0 ? (
        <Empty description="暂无类型数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
          {types.map((t) => {
            const k = t.k ?? t.name ?? ''
            const color = CALC_TYPE_COLOR[k] ?? '#8C8C8C'
            return (
              <div
                key={k}
                style={{
                  flex: '1 1 190px',
                  minWidth: 180,
                  border: '1px solid #f0f0f0',
                  borderLeft: `4px solid ${color}`,
                  borderRadius: 8,
                  padding: '10px 12px',
                }}
              >
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}
                >
                  <span style={{ color, fontWeight: 600 }}>{t.name ?? k}</span>
                  <span style={{ color: '#8C8C8C', fontSize: 12 }}>{t.n ?? 0} 道</span>
                </div>
                <div
                  style={{ color: '#8C8C8C', fontSize: 12, minHeight: 36, margin: '4px 0 8px' }}
                >
                  {t.desc ?? ''}
                </div>
                <Metric label="日销量" value={`${fmt(t.qty, 0)} 份`} />
                <Metric label="销量占比" value={pct(t.qty_share, 0)} />
                <Metric label="日营收" value={`${fmt(t.rev)} 元`} />
                <Metric label="营收占比" value={pct(t.rev_share, 0)} />
                <Metric label="成本率" value={pct(t.cost_rate, 0)} />
                <Metric label="日毛利额" value={`${fmt(t.gp)} 元`} color={color} />
                <Metric label="毛利占比" value={pct(t.gp_share, 0)} />
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
