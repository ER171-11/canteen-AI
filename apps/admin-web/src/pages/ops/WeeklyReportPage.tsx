import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import {
  fetchAdminDishes,
  fetchAnalysis,
  postAction,
  simulateAnalysis,
  type AnalysisParams,
} from '../../api'
import type {
  AnalysisResp,
  AnalysisSimResp,
  CalcQMode,
  CalcSimRowOverride,
  Dish,
  MatrixRow,
} from '../../api/types'
import MockAlert from '../kitchen/components/MockAlert'
import { useAuthStore } from '../../store/auth'
import { COLORS } from '../../theme'
import CalcParamsCard from './CalcParamsCard'
import CalcCharts from './CalcCharts'
import CalcDishTable from './CalcDishTable'
import CalcTypeCards from './CalcTypeCards'
import { rowOvKey, SIM_BASIS_LABEL, type BulkAction } from './calcSim'

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

  /* ---------------- 结构测算「模拟态」只读推演（FP-CALC-08/11/12/13，见 ADR-007） ----------------
   * 基线：`GET /api/modules/analysis`（店级 KPI 走保本价盘整表口径）。
   * 模拟态：`POST /api/modules/analysis/sim`（行集切到本店在售菜品，即旧版 calcModel 的 SD 口径），
   *   故进入模拟态时店级 KPI 会跳变 —— 页面必须挂「模拟态 · 本店在售菜品口径」徽标。
   * 本页**不持第二份公式**：成本率/日营收/毛利额一律取后端回传行，避免前端公式漂移。 */
  const [params, setParams] = useState<AnalysisParams>({})
  const [simOn, setSimOn] = useState(false)
  const [simBusy, setSimBusy] = useState(false)
  const [simNonce, setSimNonce] = useState(0)
  const [qmode, setQmode] = useState<CalcQMode>('real30')
  const [qfallback, setQfallback] = useState(true)
  const [overrides, setOverrides] = useState<Record<string, CalcSimRowOverride>>({})
  const [sim, setSim] = useState<AnalysisSimResp | null>(null)
  const simSeq = useRef(0)

  // 推演请求去抖 300ms：行内连点数字输入只发一次（旧版是内存即时重算，新版按端点回源）
  useEffect(() => {
    if (!simOn) return undefined
    const seq = ++simSeq.current
    const t = window.setTimeout(() => {
      setSimBusy(true)
      simulateAnalysis({ params, qmode, qfallback, rows: overrides })
        .then((r) => {
          if (seq !== simSeq.current) return // 过期响应丢弃
          setSim(r)
        })
        .catch(() => {
          if (seq !== simSeq.current) return
          setSimOn(false)
          setSim(null)
          message.error('模拟推演失败（BFF 离线或端点未部署），已退回基线口径')
        })
        .finally(() => {
          if (seq === simSeq.current) setSimBusy(false)
        })
    }, 300)
    return () => window.clearTimeout(t)
  }, [simOn, params, qmode, qfallback, overrides, simNonce])

  const trend7 = useMemo(() => (data?.trend ?? []).slice(-7), [data])
  const matrix = useMemo(() => data?.matrix ?? [], [data])
  const simSummary = sim?.baoben_summary ?? null
  const kpi = (simOn ? simSummary?.kpi : data?.baoben_summary?.kpi) ?? {}
  const types = (simOn ? simSummary?.types : data?.baoben_summary?.types) ?? []
  const effParams = (simOn ? simSummary?.params : data?.baoben_summary?.params) ?? undefined
  const scenes = (simOn ? simSummary?.scenes : data?.baoben_summary?.scenes) ?? []
  const calcDishes = (simOn ? sim?.calc_dishes : data?.calc_dishes) ?? []
  const adviceList = (simOn ? simSummary?.advice : data?.baoben_summary?.advice) ?? []

  /** 模拟态控制句柄（下发给逐菜结构表；本表只上抛动作，不持状态） */
  const simCtl = {
    active: simOn,
    overrides,
    qmode,
    qfallback,
    qmodeLabel: sim?.qmode_label,
    qdays: sim?.qdays,
    qstat: sim?.qstat,
    busy: simBusy,
    onStart: () => setSimOn(true),
    onStop: () => {
      setSimOn(false)
      setSim(null)
      setOverrides({})
    },
    onOverride: (key: string, patch: CalcSimRowOverride | null) =>
      setOverrides((prev) => {
        const next = { ...prev }
        if (patch == null) delete next[key]
        else next[key] = { ...(prev[key] ?? {}), ...patch }
        return next
      }),
    /** 批量调价/调量/上架/恢复默认：以当前生效行值为基数（旧版 data-bulk，HTML:4296-4311） */
    onBulk: (scope: string, action: BulkAction) =>
      setOverrides((prev) => {
        const next = { ...prev }
        for (const r of calcDishes) {
          if (scope !== '__all' && (r.cat || '常规') !== scope) continue
          const k = rowOvKey(r)
          if (action === 'reset') {
            delete next[k]
            continue
          }
          const patch: CalcSimRowOverride = { ...(next[k] ?? {}) }
          const p = Number(r.price) || 0
          const q = Number(r.qty) || 0
          if (action === 'on') patch.on = true
          else if (action === 'p-10') patch.p = Math.round(p * 0.9)
          else if (action === 'p-5') patch.p = Math.round(p * 0.95)
          else if (action === 'p5') patch.p = Math.round(p * 1.05)
          else if (action === 'p10') patch.p = Math.round(p * 1.1)
          else if (action === 'q-20') patch.q = Math.max(0, Number((q * 0.8).toFixed(1)))
          else if (action === 'q20') patch.q = Number((q * 1.2).toFixed(1))
          next[k] = patch
        }
        return next
      }),
    onQmode: (m: CalcQMode) => {
      setQmode(m)
      setSimOn(true) // 切换口径即进入模拟态（旧版切换即重算本页 SD）
    },
    onQfallback: (v: boolean) => {
      setQfallback(v)
      setSimOn(true)
    },
  }

  /** 参数重算：模拟态走推演端点（保留行覆盖），否则回源基线 GET */
  const applyParams = (p: AnalysisParams) => {
    setParams(p)
    if (!simOn) load(p)
    else setSimNonce((n) => n + 1)
  }

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
          <Space wrap>
            {data?.rev != null && <Tag color="blue">rev {data.rev}</Tag>}
            {simOn && (
              <Tooltip title="模拟态基准行集为本店在售菜品（旧版 calcModel 的 SD 口径），与基线「保本价盘整表」口径不同，店级 KPI 会随之跳变，非计算错误">
                <Tag color="orange">{SIM_BASIS_LABEL}</Tag>
              </Tooltip>
            )}
            {simOn && simBusy && <Tag color="processing">推演中…</Tag>}
            <Button
              size="small"
              onClick={() => {
                load(params)
                if (simOn) setSimNonce((n) => n + 1)
              }}
            >
              刷新
            </Button>
          </Space>
        }
      >
        <CalcParamsCard
          effParams={effParams}
          kpi={kpi}
          loading={loading}
          simActive={simOn}
          onApply={applyParams}
          onReset={() => {
            setParams({})
            setOverrides({})
            load()
            if (simOn) setSimNonce((n) => n + 1)
          }}
        />

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

      {/* 菜品结构 · 五类角色（FP-CALC-14；源：旧版 `#typeCards`、`renderCalcTypes` HTML:387/3978） */}
      <CalcTypeCards types={types} loading={loading} />

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
          <Card
            title={`菜品类型营收/毛利占比（${simOn ? SIM_BASIS_LABEL : '静态价盘'}）`}
            size="small"
            loading={loading}
          >
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
            {adviceList.length > 0 && (
              <Alert
                type="info"
                showIcon
                style={{ marginTop: 8 }}
                message={simOn ? '保本测算建议（模拟态 · 本店在售菜品口径）' : '保本价盘建议'}
                description={
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {adviceList.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                }
              />
            )}
          </Card>
        </Col>
      </Row>

      <div style={{ marginTop: 16 }}>
        <CalcDishTable rows={calcDishes} types={types} loading={loading} sim={simCtl} />
      </div>

      <div style={{ marginTop: 16 }}>
        <CalcCharts
          scenes={scenes}
          kpi={kpi}
          effParams={effParams}
          loading={loading}
          simActive={simOn}
          canSync={!offline}
          onSync={() => {
            // FP-CALC-07 同步菜品主数据：清空模拟覆盖，按最新快照/配方重置测算输入
            setOverrides({})
            loadDishes()
            load(params)
            if (simOn) setSimNonce((n) => n + 1)
          }}
        />
      </div>

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
