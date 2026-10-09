import { useEffect, useMemo, useState } from 'react'
import { Alert, Card, Col, List, Row, Segmented, Skeleton, Statistic, Tag, Typography } from 'antd'
import { useAnalysisPeriod, PERIODS } from '../../hooks/usePeriodSwitch'
import { postAnalysisSuggestions, type AnalysisSuggestion } from '../../api'
import { COLORS } from '../../theme'

function TrendLine({ points }: { points: { date: string; revenue: number }[] }) {
  const w = 600
  const h = 220
  const pad = 36
  if (points.length < 2) return <Alert type="info" message="样本不足，无法绘制趋势" />
  const max = Math.max(...points.map((p) => p.revenue), 1)
  const min = Math.min(...points.map((p) => p.revenue), 0)
  const xs = (i: number) => pad + (i / (points.length - 1)) * (w - 2 * pad)
  const ys = (v: number) => h - pad - ((v - min) / (max - min || 1)) * (h - 2 * pad)
  const line = points.map((p, i) => (i ? 'L' : 'M') + xs(i).toFixed(1) + ' ' + ys(p.revenue).toFixed(1)).join(' ')
  const area = `${line} L ${xs(points.length - 1).toFixed(1)} ${h - pad} L ${xs(0).toFixed(1)} ${h - pad} Z`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label="营收趋势">
      <path d={area} fill={COLORS.primary + '22'} />
      <path d={line} fill="none" stroke={COLORS.primary} strokeWidth={2} />
      {points.map((p, i) => (
        <circle key={i} cx={xs(i)} cy={ys(p.revenue)} r={2.5} fill={COLORS.primary} />
      ))}
    </svg>
  )
}

function WeeklyBars({ points }: { points: { date: string; revenue: number }[] }) {
  const weeks = useMemo(() => {
    const map = new Map<string, number>()
    for (const p of points) {
      const d = new Date(p.date)
      const y = d.getFullYear()
      const wk = Math.ceil(((d.getTime() - new Date(y, 0, 1).getTime()) / 86400000 + 1) / 7)
      const key = `${y}-W${wk}`
      map.set(key, (map.get(key) || 0) + p.revenue)
    }
    return Array.from(map.entries())
  }, [points])
  if (!weeks.length) return null
  const max = Math.max(...weeks.map((w) => w[1]), 1)
  const palette = [COLORS.red, COLORS.orange, COLORS.gold, COLORS.green, COLORS.blue, COLORS.indigo]
  return (
    <Row gutter={8}>
      {weeks.map((w, i) => (
        <Col key={w[0]} flex="1">
          <Card size="small" styles={{ body: { padding: 8, textAlign: 'center' } }}>
            <div style={{ height: 80, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
              <div
                style={{
                  width: '70%',
                  height: `${(w[1] / max) * 100}%`,
                  background: palette[i % palette.length],
                  borderRadius: 4,
                }}
              />
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {w[0]}
            </Typography.Text>
            <div style={{ fontWeight: 600 }}>{(w[1] / 10000).toFixed(1)}万</div>
          </Card>
        </Col>
      ))}
    </Row>
  )
}

export default function AnalysisTrendPage() {
  const { period, setPeriod, status, trend, efficiency, error } = useAnalysisPeriod()
  const totalRev = useMemo(() => trend.reduce((s, t) => s + t.revenue, 0), [trend])
  const totalOrders = useMemo(() => trend.reduce((s, t) => s + t.orders, 0), [trend])

  const [suggestions, setSuggestions] = useState<AnalysisSuggestion[]>([])
  const [weatherConclusion, setWeatherConclusion] = useState('')
  const [aiNote, setAiNote] = useState('')
  useEffect(() => {
    postAnalysisSuggestions()
      .then((r) => {
        if (r) {
          setSuggestions(r.suggestions)
          setWeatherConclusion(r.weather_conclusion)
          setAiNote(r.note || '')
        }
      })
      .catch(() => {})
  }, [])

  return (
    <div style={{ padding: 16 }}>
      <Row justify="space-between" align="middle" style={{ marginBottom: 12 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          经营趋势（an-trend）
        </Typography.Title>
        <Segmented options={PERIODS.map((p) => ({ label: p.label, value: p.key }))} value={period} onChange={(v) => setPeriod(v as never)} />
      </Row>

      {status === 'error' && error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      {status === 'loading' && <Skeleton active paragraph={{ rows: 6 }} />}

      <Row gutter={16}>
        <Col xs={24} md={16}>
          <Card title="营收 / 毛利趋势（按日）" size="small">
            <TrendLine points={trend.map((t) => ({ date: t.date, revenue: t.revenue }))} />
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card size="small">
            <Statistic title="区间营收" value={totalRev} precision={0} prefix="¥" />
            <Statistic title="区间订单" value={totalOrders} style={{ marginTop: 8 }} />
            {efficiency && (
              <Statistic title="客单价" value={efficiency.avg_ticket} precision={2} prefix="¥" style={{ marginTop: 8 }} />
            )}
          </Card>
        </Col>
      </Row>

      <Card title="各色周表现（营收对比）" size="small" style={{ marginTop: 16 }}>
        <WeeklyBars points={trend.map((t) => ({ date: t.date, revenue: t.revenue }))} />
      </Card>

      <Card title="AI 下周经营建议（M1-T5 · 仅建议，需确认才触达）" size="small" style={{ marginTop: 16 }}>
        {aiNote && <Alert type="warning" showIcon message={aiNote} style={{ marginBottom: 8 }} />}
        <List
          size="small"
          dataSource={suggestions}
          renderItem={(s) => (
            <List.Item>
              <List.Item.Meta
                title={s.title}
                description={s.content}
              />
              <Tag color={s.priority === '高' ? 'red' : s.priority === '中' ? 'orange' : 'default'}>
                {s.priority}
              </Tag>
            </List.Item>
          )}
        />
        {weatherConclusion && (
          <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
            天气关联：{weatherConclusion}
          </Typography.Paragraph>
        )}
      </Card>
    </div>
  )
}
