import { useMemo, useState } from 'react'
import { Card, Col, Row, Segmented, Tag, Typography } from 'antd'
import { useAnalysisPeriod, PERIODS } from '../../hooks/usePeriodSwitch'

const SCALE = [
  { c: '#D6EFD6', t: '低' },
  { c: '#FCE9A8', t: '中低' },
  { c: '#F8C28A', t: '中高' },
  { c: '#F2A0A0', t: '高' },
]
const WEEK = ['日', '一', '二', '三', '四', '五', '六']

function colorOf(v: number, max: number) {
  if (!max) return SCALE[0].c
  const r = v / max
  if (r < 0.25) return SCALE[0].c
  if (r < 0.5) return SCALE[1].c
  if (r < 0.75) return SCALE[2].c
  return SCALE[3].c
}

export default function AnalysisHeatPage() {
  const { period, setPeriod, status, heat } = useAnalysisPeriod()
  const [sel, setSel] = useState<{ hour: number; weekday: number; revenue: number; orders: number } | null>(null)

  const { max, peaks } = useMemo(() => {
    const m = Math.max(...heat.map((h) => h.revenue), 0)
    const sorted = heat.slice().sort((a, b) => b.revenue - a.revenue)
    return { max: m, peaks: sorted.slice(0, 2) }
  }, [heat])

  const grid: Record<number, Record<number, { revenue: number; orders: number }>> = {}
  for (const c of heat) {
    if (!grid[c.weekday]) grid[c.weekday] = {}
    grid[c.weekday][c.hour] = { revenue: c.revenue, orders: c.orders }
  }

  return (
    <div style={{ padding: 16 }}>
      <Row justify="space-between" align="middle" style={{ marginBottom: 12 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          时段热力（an-heat · 24h×7天）
        </Typography.Title>
        <Segmented options={PERIODS.map((p) => ({ label: p.label, value: p.key }))} value={period} onChange={(v) => setPeriod(v as never)} />
      </Row>

      {status === 'loading' && <Card size="small" loading />}

      <Card size="small" title="营收热力（颜色越深=营收越高）">
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th />
                {Array.from({ length: 24 }, (_, h) => (
                  <th key={h} style={{ fontSize: 10, padding: 2, color: '#999' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {WEEK.map((wname, wd) => (
                <tr key={wd}>
                  <td style={{ fontSize: 11, padding: '2px 6px', color: '#666' }}>周{wname}</td>
                  {Array.from({ length: 24 }, (_, h) => {
                    const cell = grid[wd] && grid[wd][h]
                    const rev = cell ? cell.revenue : 0
                    const isPeak = peaks.some((p) => p.hour === h && p.weekday === wd)
                    return (
                      <td
                        key={h}
                        onClick={() => cell && setSel({ hour: h, weekday: wd, revenue: rev, orders: cell.orders })}
                        style={{
                          width: 16,
                          height: 16,
                          background: colorOf(rev, max),
                          border: isPeak ? '2px solid #E8442E' : '1px solid #fff',
                          cursor: cell ? 'pointer' : 'default',
                        }}
                        title={cell ? `${wname} ${h}:00 ¥${rev}` : undefined}
                      />
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 8, display: 'flex', gap: 12, alignItems: 'center' }}>
          {SCALE.map((s) => (
            <Tag key={s.t} color={s.c} style={{ color: '#333' }}>
              {s.t}
            </Tag>
          ))}
          {peaks[0] && (
            <Typography.Text type="danger">
              双峰：{WEEK[peaks[0].weekday]} {peaks[0].hour}:00（{WEEK[peaks[1]?.weekday]} {peaks[1]?.hour}:00）
            </Typography.Text>
          )}
        </div>
      </Card>

      {sel && (
        <Card size="small" title={`下钻：周${WEEK[sel.weekday]} ${sel.hour}:00`} style={{ marginTop: 12 }}>
          <Row gutter={16}>
            <Col>营收：¥{sel.revenue}</Col>
            <Col>订单：{sel.orders}</Col>
          </Row>
        </Card>
      )}
    </div>
  )
}
