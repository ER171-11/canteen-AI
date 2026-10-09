import { useEffect, useState } from 'react'
import { Card, Col, Progress, Row, Skeleton, Statistic, Typography } from 'antd'
import { fetchAnalysisEfficiency, type AnalysisEfficiency } from '../../api'
import { COLORS } from '../../theme'

function Gauge({ title, value, suffix, hint }: { title: string; value: number | null; suffix: string; hint?: string }) {
  const pct = value == null ? 0 : Math.min(100, Math.max(0, value))
  return (
    <Card size="small" title={title}>
      <div style={{ textAlign: 'center' }}>
        <Progress type="dashboard" percent={+pct.toFixed(0)} strokeColor={COLORS.primary} />
        <Statistic value={value ?? '—'} suffix={suffix} style={{ marginTop: 8 }} />
        {hint && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {hint}
          </Typography.Text>
        )}
      </div>
    </Card>
  )
}

export default function AnalysisEffPage() {
  const [eff, setEff] = useState<AnalysisEfficiency | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetchAnalysisEfficiency()
      .then(setEff)
      .catch(() => setEff(null))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Card style={{ margin: 16 }}><Skeleton active /></Card>

  return (
    <div style={{ padding: 16 }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        效率仪表盘（an-eff）
      </Typography.Title>
      <Row gutter={16}>
        <Col xs={24} md={8}>
          <Gauge title="翻台率" value={eff?.turnover ?? null} suffix="次/桌/天" hint={`桌位容量 ${eff?.tables ?? '—'}`} />
        </Col>
        <Col xs={24} md={8}>
          <Gauge title="坪效" value={eff?.revenue_per_sqm ?? null} suffix="元/㎡/天" hint={`面积 ${eff?.area ?? '—'}㎡`} />
        </Col>
        <Col xs={24} md={8}>
          <Gauge title="人效" value={eff?.revenue_per_staff ?? null} suffix="元/人/天" hint={`在岗 ${eff?.staff ?? '—'} 人`} />
        </Col>
      </Row>
    </div>
  )
}
