import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Card,
  Col,
  List,
  Row,
  Space,
  Spin,
  Statistic,
  Tag,
  Typography,
} from 'antd'
import { useNavigate } from 'react-router-dom'
import { fetchReportDaily } from '../api'
import type { AlertItem, ReportDaily, TodoItem } from '../api/types'
import { resolveDeepLink } from '../config/menu'
import { COLORS } from '../theme'

/** BFF 未上线时的内置演示数据（页面有显著提示） */
const MOCK_REPORT: ReportDaily = {
  date: new Date().toISOString().slice(0, 10),
  banner: '今日经营平稳，五色饺子出品合格率 96%',
  kpis: [
    { key: 'revenue', label: '营业额', value: 12860, unit: '元', delta: '+8.2%', trend: 'up' },
    { key: 'orders', label: '订单数', value: 326, unit: '单', delta: '+5.1%', trend: 'up' },
    { key: 'avg_price', label: '客单价', value: 39.4, unit: '元', delta: '+1.8%', trend: 'up' },
    { key: 'gross_margin', label: '毛利率', value: '62.5', unit: '%', delta: '-0.6%', trend: 'down' },
    { key: 'new_members', label: '新增会员', value: 18, unit: '人', delta: '+12.5%', trend: 'up' },
    { key: 'delivery_ratio', label: '外卖占比', value: '34', unit: '%', delta: '+2.0%', trend: 'up' },
    { key: 'stock_alerts', label: '库存预警', value: 3, unit: '项', delta: '+1', trend: 'down' },
    { key: 'praise_rate', label: '好评率', value: '97.2', unit: '%', delta: '+0.4%', trend: 'up' },
  ],
  todos: [
    { id: 't1', title: '审核今日采购单 PO-20260924-03', source: '进销存' },
    { id: 't2', title: '确认晚市工单排产', source: '菜品厨房' },
    { id: 't3', title: '处理 2 条外卖差评', source: '堂食外卖' },
  ],
  alerts: [
    { id: 'a1', title: '菠菜汁库存低于安全线', level: 'critical', detail: '账面 1.2kg / 安全库存 3kg' },
    { id: 'a2', title: '留样盒 LY-104 将于 4h 后到期', level: 'warn' },
    { id: 'a3', title: '员工张三健康证 30 天内到期', level: 'info' },
  ],
}

const LEVEL_TAG: Record<string, { color: string; text: string }> = {
  critical: { color: COLORS.red, text: '紧急' },
  warn: { color: COLORS.yellow, text: '预警' },
  info: { color: COLORS.purple, text: '提示' },
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

export default function DashboardPage() {
  const navigate = useNavigate()
  const [report, setReport] = useState<ReportDaily | null>(null)
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchReportDaily()
      .then((data) => {
        const n = normalizeReport(data)
        setReport(n)
        setIsMock(!!n.mock)
      })
      .catch(() => {
        setReport(normalizeReport(MOCK_REPORT))
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  const age = useMemo(() => ageMinutes(report?.generated_at), [report?.generated_at])
  const stale = age != null && age > 15

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
        <Typography.Title level={4} style={{ color: '#fff', margin: 0 }}>
          经营看板 · {report.date}
        </Typography.Title>
        <div style={{ marginTop: 8, opacity: 0.92 }}>
          {report.banner ?? '五福临门，今日加油！'}
        </div>
        {report.kitchen && (
          <div style={{ marginTop: 8, fontSize: 13, opacity: 0.9 }}>
            今日工单 {report.kitchen.workorders_done ?? 0}/{report.kitchen.workorders_total ?? 0}
          </div>
        )}
      </div>

      <Row gutter={[16, 16]}>
        {(report.kpis ?? []).slice(0, 8).map((kpi) => (
          <Col xs={12} sm={12} md={6} key={kpi.key}>
            <Card>
              <Statistic title={kpi.label} value={kpi.value} suffix={kpi.unit} />
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
    </div>
  )
}
