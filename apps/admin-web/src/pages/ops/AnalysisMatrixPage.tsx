import { useEffect, useMemo, useState } from 'react'
import { Card, Col, Row, Skeleton, Tag, Typography } from 'antd'
import { fetchAnalysisMatrix, type AnalysisMatrixRow } from '../../api'
import { COLORS } from '../../theme'

const QUAD: Record<string, { name: string; color: string }> = {
  star: { name: '明星菜', color: COLORS.red },
  puzzle: { name: '问题菜', color: COLORS.orange },
  cow: { name: '现金牛', color: COLORS.blue },
  dog: { name: '瘦狗', color: '#8A8A8A' },
}

function median(xs: number[]) {
  const ys = xs.filter((x) => isFinite(x)).slice().sort((a, b) => a - b)
  if (!ys.length) return 0
  const m = Math.floor(ys.length / 2)
  return ys.length % 2 ? ys[m] : (ys[m - 1] + ys[m]) / 2
}

export default function AnalysisMatrixPage() {
  const [rows, setRows] = useState<AnalysisMatrixRow[]>([])
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState<AnalysisMatrixRow | null>(null)

  useEffect(() => {
    setLoading(true)
    fetchAnalysisMatrix()
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false))
  }, [])

  const { baseV, baseM } = useMemo(() => {
    return { baseV: median(rows.map((r) => r.volume)), baseM: median(rows.map((r) => r.margin)) }
  }, [rows])

  // 坐标：volume(x) → margin(y)，气泡大小=volume
  const W = 560
  const H = 380
  const pad = 40
  const maxV = Math.max(...rows.map((r) => r.volume), 1)
  const maxM = Math.max(...rows.map((r) => r.margin), 0.01)
  const x = (v: number) => pad + (v / maxV) * (W - 2 * pad)
  const y = (m: number) => H - pad - (m / maxM) * (H - 2 * pad)
  const r = (v: number) => 6 + (v / maxV) * 22

  if (loading) return <Card style={{ margin: 16 }}><Skeleton active /></Card>

  return (
    <div style={{ padding: 16 }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        波士顿矩阵（an-mx）
      </Typography.Title>
      <Card size="small">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="波士顿矩阵">
          {/* 象限基准线（销量/毛利中位数） */}
          <line x1={x(baseV)} y1={pad} x2={x(baseV)} y2={H - pad} stroke="#bbb" strokeDasharray="4 4" />
          <line x1={pad} y1={y(baseM)} x2={W - pad} y2={y(baseM)} stroke="#bbb" strokeDasharray="4 4" />
          <text x={W - pad} y={y(baseM) - 6} fontSize={11} fill="#999" textAnchor="end">
            毛利中位数基准
          </text>
          <text x={x(baseV) + 4} y={pad + 12} fontSize={11} fill="#999">
            销量中位数基准
          </text>
          {rows.map((d, i) => (
            <circle
              key={i}
              cx={x(d.volume)}
              cy={y(d.margin)}
              r={r(d.volume)}
              fill={(QUAD[d.quadrant]?.color || '#999') + 'cc'}
              stroke={QUAD[d.quadrant]?.color || '#999'}
              onClick={() => setSel(d)}
              style={{ cursor: 'pointer' }}
            />
          ))}
        </svg>
        <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
          {Object.entries(QUAD).map(([k, v]) => (
            <Tag key={k} color={v.color} style={{ color: '#fff' }}>
              {v.name}
            </Tag>
          ))}
        </div>
      </Card>

      {sel && (
        <Card size="small" title={`${sel.name} · ${QUAD[sel.quadrant]?.name || sel.quadrant}`} style={{ marginTop: 12 }}>
          <Row gutter={16}>
            <Col>销量：{sel.volume}</Col>
            <Col>毛利率：{(sel.margin * 100).toFixed(1)}%</Col>
            <Col>价格：{sel.price ?? '—'}</Col>
            <Col>
              <Typography.Text type="secondary">成本字段：成本待测算</Typography.Text>
            </Col>
          </Row>
        </Card>
      )}
    </div>
  )
}
