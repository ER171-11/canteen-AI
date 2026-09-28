import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Progress,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import { fetchAdminDishes, fetchAnalysis, postAction, type AnalysisParams } from '../../api'
import type { AnalysisResp, Dish, MatrixRow } from '../../api/types'
import MockAlert from '../kitchen/components/MockAlert'
import { useAuthStore } from '../../store/auth'
import { COLORS } from '../../theme'

const QUAD_META: Record<string, { name: string; color: string }> = {
  star: { name: '明星', color: '#E8442E' },
  puzzle: { name: '问题', color: '#F5A623' },
  cow: { name: '金牛', color: '#3A6EA5' },
  dog: { name: '瘦狗', color: '#8A8A8A' },
}

/** 爆品毛利率红线：低于该值建议调价 */
const STAR_MARGIN_FLOOR = 0.4

type Advice = {
  key: string
  level: 'critical' | 'warn' | 'info'
  text: string
  row: MatrixRow
  actions: Array<'price' | 'off'>
}

export default function WeeklyReportPage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const noWriteTip = '当前角色无写权限，仅可查看'
  const [data, setData] = useState<AnalysisResp | null>(null)
  const [offline, setOffline] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [dishMap, setDishMap] = useState<Map<string, Dish>>(new Map())
  const [priceRow, setPriceRow] = useState<MatrixRow | null>(null)
  const [paramForm] = Form.useForm()
  const [priceForm] = Form.useForm()

  const load = useCallback((params?: AnalysisParams) => {
    setLoading(true)
    fetchAnalysis(params)
      .then((d) => {
        setData(d)
        setOffline(false)
      })
      .catch(() => {
        setData(null)
        setOffline(true)
      })
      .finally(() => setLoading(false))
  }, [])

  const loadDishes = useCallback(() => {
    fetchAdminDishes()
      .then((resp) => {
        const m = new Map<string, Dish>()
        for (const d of resp.items ?? []) if (d.name) m.set(d.name, d)
        setDishMap(m)
      })
      .catch(() => setDishMap(new Map()))
  }, [])

  useEffect(() => {
    load()
    loadDishes()
  }, [load, loadDishes])

  const trend7 = useMemo(() => (data?.trend ?? []).slice(-7), [data])
  const matrix = useMemo(() => data?.matrix ?? [], [data])
  const kpi = data?.baoben_summary?.kpi ?? {}
  const types = data?.baoben_summary?.types ?? []
  const effParams = data?.baoben_summary?.params

  const quadStats = useMemo(() => {
    const acc: Record<string, { n: number; marginSum: number }> = {}
    for (const m of matrix) {
      const q = QUAD_META[m.quadrant ?? ''] ? String(m.quadrant) : 'dog'
      acc[q] = acc[q] ?? { n: 0, marginSum: 0 }
      acc[q].n += 1
      acc[q].marginSum += Number(m.margin) || 0
    }
    return Object.keys(QUAD_META).map((q) => ({
      q,
      n: acc[q]?.n ?? 0,
      avgMargin: acc[q]?.n ? acc[q].marginSum / acc[q].n : null,
    }))
  }, [matrix])

  /** 自动建议：瘦狗下架/调价 + 爆品低毛利调价 + BFF advice 文案 */
  const advices = useMemo(() => {
    const out: Advice[] = []
    const dogs = matrix.filter((m) => m.quadrant === 'dog')
    for (const m of dogs) {
      out.push({
        key: `dog-${m.name}`,
        level: 'critical',
        text: `瘦狗象限「${m.name}」（销量 ${m.volume ?? '-'} · 毛利 ${(((m.margin ?? 0) as number) * 100).toFixed(1)}%），建议下架或调价`,
        row: m,
        actions: ['price', 'off'],
      })
    }
    const weakStars = matrix.filter(
      (m) =>
        (m.quadrant === 'star' || m.dish_type === '爆品') &&
        m.margin != null &&
        Number(m.margin) < STAR_MARGIN_FLOOR,
    )
    for (const m of weakStars) {
      out.push({
        key: `star-${m.name}`,
        level: 'warn',
        text: `爆品「${m.name}」毛利率 ${((Number(m.margin) || 0) * 100).toFixed(1)}% 低于 ${(STAR_MARGIN_FLOOR * 100).toFixed(0)}%，建议调价`,
        row: m,
        actions: ['price'],
      })
    }
    return out
  }, [matrix])

  const enqueue = async (type: string, payload: Record<string, unknown>, ok: string) => {
    setBusy(true)
    try {
      await postAction({ type, payload, operator: 'admin' })
      message.success(`${ok}已入队，请到审批中心确认执行`)
      loadDishes()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '提交失败')
    } finally {
      setBusy(false)
    }
  }

  const openPrice = (row: MatrixRow) => {
    priceForm.setFieldsValue({ price: row.price, reason: '' })
    setPriceRow(row)
  }

  const trendMax = Math.max(1, ...trend7.map((t) => Number(t.revenue) || 0))
  const weekRev = trend7.reduce((s, t) => s + (Number(t.revenue) || 0), 0)
  const weekOrders = trend7.reduce((s, t) => s + (Number(t.orders) || 0), 0)

  return (
    <div>
      {offline && <MockAlert endpoint="/api/modules/analysis" />}
      <Card
        title="经营周报"
        extra={
          <Space>
            {data?.rev != null && <Tag color="blue">rev {data.rev}</Tag>}
            <Button size="small" onClick={() => load()}>
              刷新
            </Button>
          </Space>
        }
      >
        <Form
          form={paramForm}
          layout="inline"
          initialValues={{ area: 400, staff: 20, days: 30 }}
          onFinish={(v) =>
            load({
              area: v.area,
              staff: v.staff,
              days: v.days,
              target_profit: v.target_profit,
            })
          }
        >
          <Form.Item name="area" label="面积㎡">
            <InputNumber min={0} style={{ width: 90 }} />
          </Form.Item>
          <Form.Item name="staff" label="员工数">
            <InputNumber min={0} style={{ width: 80 }} />
          </Form.Item>
          <Form.Item name="days" label="营业天数">
            <InputNumber min={1} max={31} style={{ width: 80 }} />
          </Form.Item>
          <Form.Item name="target_profit" label="目标利润¥">
            <InputNumber min={0} style={{ width: 120 }} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading}>
              按店参重算
            </Button>
          </Form.Item>
        </Form>
        {effParams && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            当前生效店参：面积 {String(effParams.area ?? '-')}㎡ · 员工 {String(effParams.staff ?? '-')} ·{' '}
            {String(effParams.days ?? '-')} 天 · 餐位 {String(effParams.seats ?? '-')}
            （BFF 未识别 query 店参时展示静态价盘参数）
          </Typography.Text>
        )}

        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="近7日营收" value={weekRev.toFixed(0)} prefix="¥" />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="近7日订单" value={weekOrders} suffix="单" />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic
                title="日保本"
                value={kpi.be_day != null ? kpi.be_day.toFixed(0) : '-'}
                prefix="¥"
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic
                title="月利润预测"
                value={kpi.month_profit != null ? kpi.month_profit.toFixed(0) : '-'}
                prefix="¥"
              />
            </Card>
          </Col>
        </Row>
      </Card>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} md={10}>
          <Card title="近7日营收趋势" size="small" loading={loading}>
            {trend7.length === 0 ? (
              <Typography.Text type="secondary">暂无趋势数据</Typography.Text>
            ) : (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 160 }}>
                {trend7.map((t, i) => {
                  const v = Number(t.revenue) || 0
                  const h = Math.max(4, (v / trendMax) * 130)
                  return (
                    <div key={t.date ?? i} style={{ flex: 1, textAlign: 'center' }}>
                      <div style={{ fontSize: 11, color: '#666' }}>
                        {v >= 10000 ? `${(v / 10000).toFixed(1)}w` : v.toFixed(0)}
                      </div>
                      <div
                        title={`${t.date ?? t.week ?? ''} · ¥${v.toFixed(0)} · ${t.orders ?? 0} 单`}
                        style={{
                          height: h,
                          borderRadius: '4px 4px 0 0',
                          background: COLORS.aiGradient,
                        }}
                      />
                      <div style={{ fontSize: 11, color: '#999' }}>
                        {t.date ? t.date.slice(5) : (t.week ?? '-')}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </Card>
          <Card title="四象限分布" size="small" style={{ marginTop: 16 }} loading={loading}>
            <Row gutter={[8, 8]}>
              {quadStats.map((s) => (
                <Col span={12} key={s.q}>
                  <Card size="small" style={{ borderLeft: `4px solid ${QUAD_META[s.q].color}` }}>
                    <Statistic
                      title={`${QUAD_META[s.q].name}象限`}
                      value={s.n}
                      suffix="道"
                    />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      平均毛利 {s.avgMargin != null ? `${(s.avgMargin * 100).toFixed(1)}%` : '-'}
                    </Typography.Text>
                  </Card>
                </Col>
              ))}
            </Row>
          </Card>
        </Col>

        <Col xs={24} md={14}>
          <Card title="菜品类型营收/毛利占比（静态价盘）" size="small" loading={loading}>
            <Table
              size="small"
              rowKey={(r) => String(r.k ?? r.name)}
              dataSource={types}
              pagination={false}
              columns={[
                { title: '类型', dataIndex: 'name', render: (v, r) => v ?? r.k ?? '-' },
                { title: '道数', dataIndex: 'n', width: 60 },
                {
                  title: '营收占比',
                  dataIndex: 'rev_share',
                  width: 180,
                  render: (v: number | undefined) => (
                    <Progress percent={Number(v ?? 0)} size="small" strokeColor={COLORS.purple} />
                  ),
                },
                {
                  title: '毛利占比',
                  dataIndex: 'gp_share',
                  width: 180,
                  render: (v: number | undefined) => (
                    <Progress
                      percent={Number(v ?? 0)}
                      size="small"
                      strokeColor={COLORS.green}
                    />
                  ),
                },
                {
                  title: '成本率',
                  dataIndex: 'cost_rate',
                  width: 80,
                  render: (v) => (v != null ? `${Number(v).toFixed(1)}%` : '-'),
                },
              ]}
            />
          </Card>

          <Card
            title={`建议清单（${advices.length}）`}
            size="small"
            style={{ marginTop: 16 }}
            loading={loading}
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                执行经确认台入队，不直连店内库
              </Typography.Text>
            }
          >
            <List
              dataSource={advices}
              locale={{ emptyText: '本周无需干预项，经营健康' }}
              renderItem={(a) => {
                const dish = dishMap.get(a.row.name)
                return (
                  <List.Item
                    actions={[
                      a.actions.includes('price') && (
                        <Tooltip key="price" title={canWrite ? undefined : noWriteTip}>
                          <Button
                            size="small"
                            type="link"
                            disabled={!canWrite}
                            onClick={() => openPrice(a.row)}
                          >
                            执行·调价
                          </Button>
                        </Tooltip>
                      ),
                      a.actions.includes('off') && (
                        <Tooltip
                          key="off"
                          title={
                            !canWrite
                              ? noWriteTip
                              : dish
                                ? undefined
                                : '菜品库未按名称匹配到该菜，无法下架'
                          }
                        >
                          <Button
                            size="small"
                            type="link"
                            danger
                            disabled={!canWrite || !dish || !dish.on}
                            loading={busy}
                            onClick={() =>
                              dish &&
                              enqueue('dish.set_active', { id: dish.id, on: false }, `下架 ${a.row.name}`)
                            }
                          >
                            执行·下架
                          </Button>
                        </Tooltip>
                      ),
                    ].filter(Boolean) as React.ReactNode[]}
                  >
                    <Space size={8}>
                      <Tag color={a.level === 'critical' ? COLORS.red : COLORS.yellow}>
                        {a.level === 'critical' ? '建议处理' : '关注'}
                      </Tag>
                      <Typography.Text>{a.text}</Typography.Text>
                    </Space>
                  </List.Item>
                )
              }}
            />
            {(data?.baoben_summary?.advice ?? []).length > 0 && (
              <Alert
                type="info"
                showIcon
                style={{ marginTop: 8 }}
                message="保本价盘建议"
                description={
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {(data?.baoben_summary?.advice ?? []).map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                }
              />
            )}
          </Card>
        </Col>
      </Row>

      <Modal
        title={`调价 · ${priceRow?.name ?? ''}`}
        open={!!priceRow}
        onCancel={() => setPriceRow(null)}
        confirmLoading={busy}
        destroyOnHidden
        onOk={async () => {
          const v = await priceForm.validateFields()
          const row = priceRow
          if (!row) return
          const dish = dishMap.get(row.name)
          await enqueue(
            'dish.price',
            { id: dish?.id, name: row.name, price: v.price, reason: v.reason },
            `调价 ${row.name} → ¥${v.price}`,
          )
          setPriceRow(null)
        }}
      >
        <Form form={priceForm} layout="vertical" preserve={false}>
          <Form.Item label="当前售价">
            <Input disabled value={priceRow?.price != null ? `¥${priceRow.price}` : '-'} />
          </Form.Item>
          <Form.Item name="price" label="新售价" rules={[{ required: true, message: '请填写新售价' }]}>
            <InputNumber min={0} step={1} style={{ width: '100%' }} addonBefore="¥" />
          </Form.Item>
          <Form.Item name="reason" label="调价原因">
            <Input.TextArea rows={2} placeholder="周报建议：低毛利爆品 / 瘦狗优化…" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
