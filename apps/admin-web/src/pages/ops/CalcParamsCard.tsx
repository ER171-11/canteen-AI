import { useEffect, useMemo, type ReactNode } from 'react'
import { Button, Card, Col, Divider, Form, InputNumber, Row, Space, Typography } from 'antd'
import type { AnalysisParams } from '../../api'
import type { BaobenKpi, BaobenParams } from '../../api/types'
import { COLORS } from '../../theme'

/**
 * 结构测算 · 经营参数（只读测算层）
 * 源：旧版 `#tab-calc` 一、经营参数（HTML:368-384，参数定义 :3820-3836、回显 :3965-3975）
 * 口径：本卡只产生 `/api/modules/analysis` 的 query 覆盖，**不写库**（不碰配方/库存/菜品主数据）。
 */

type ParamField = {
  key: keyof BaobenParams
  label: string
  unit?: string
  /** 按百分比显示与录入（提交时 ÷100），对齐旧版 P_VAR 的 pct 列 */
  pct?: boolean
  step?: number
  max?: number
}

type ParamGroup = { id: string; title: string; hint: string; fields: ParamField[] }

/** 分组与标签严格对齐旧版 P_FIX / P_VAR / P_OP（HTML:3820-3836），含顺序 */
const CALC_PARAM_GROUPS: ParamGroup[] = [
  {
    id: 'fix',
    title: '固定成本（不随营业额变化）',
    hint: '房租 = 面积×租金单价；摊销 = 投入 ÷ 摊销月数',
    fields: [
      { key: 'area', label: '营业面积', unit: '㎡', step: 10 },
      { key: 'rent_psm', label: '租金单价', unit: '元/㎡', step: 1 },
      { key: 'prop_fee', label: '物业费', unit: '元/㎡', step: 1 },
      { key: 'staff', label: '人员编制', unit: '人', step: 1 },
      { key: 'labor_per', label: '人均月综合成本', unit: '元', step: 100 },
      { key: 'fit', label: '装修投入', unit: '元', step: 10000 },
      { key: 'fit_m', label: '装修摊销月数', unit: '月', step: 1 },
      { key: 'eq', label: '设备家具投入', unit: '元', step: 10000 },
      { key: 'eq_m', label: '设备摊销月数', unit: '月', step: 1 },
      { key: 'util_fix', label: '能耗（固定部分）', unit: '元/月', step: 100 },
      { key: 'other', label: '其他固定费用', unit: '元/月', step: 100 },
    ],
  },
  {
    id: 'var',
    title: '变动成本率（随营业额变化）',
    hint: '外卖综合费率 = 外卖占比 × 平台佣金率',
    fields: [
      { key: 'bev_ratio', label: '酒水占营收比', pct: true, step: 0.5 },
      { key: 'bev_cost', label: '酒水成本率', pct: true, step: 0.5 },
      { key: 'pack', label: '包材/一次性用品率', pct: true, step: 0.1 },
      { key: 'takeout', label: '外卖占营收比', pct: true, step: 0.5 },
      { key: 'comm', label: '外卖平台佣金率', pct: true, step: 0.5 },
      { key: 'mkt', label: '营销推广费率', pct: true, step: 0.1 },
      { key: 'util_var', label: '能耗变动费率', pct: true, step: 0.1 },
      { key: 'misc', label: '洗涤维修杂费率', pct: true, step: 0.1 },
      { key: 'fee', label: '支付手续费率', pct: true, step: 0.1 },
    ],
  },
  {
    id: 'op',
    title: '运营与测算口径',
    hint: '每客平均点菜用于把菜品份数折算为客流',
    fields: [
      { key: 'dish_per_guest', label: '每客平均点菜', unit: '份', step: 0.05 },
      { key: 'days', label: '月营业天数', unit: '天', step: 1, max: 31 },
      { key: 'seats', label: '可容纳餐位', unit: '个', step: 1 },
      { key: 'target_profit', label: '目标月净利润', unit: '元', step: 1000 },
    ],
  },
]

const fmt = (n?: number | null, d = 2) =>
  n == null || !Number.isFinite(Number(n))
    ? '—'
    : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d })

const pct = (ratio?: number | null, d = 1) =>
  ratio == null || !Number.isFinite(Number(ratio))
    ? '—'
    : `${(Number(ratio) * 100).toFixed(d)}%`

function EchoRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <Row justify="space-between" style={{ fontSize: 12, lineHeight: '22px' }}>
      <Col>
        <Typography.Text type={strong ? undefined : 'secondary'} strong={strong}>
          {label}
        </Typography.Text>
      </Col>
      <Col>
        <Typography.Text strong={strong}>{value}</Typography.Text>
      </Col>
    </Row>
  )
}

export default function CalcParamsCard({
  effParams,
  kpi,
  loading,
  onApply,
  onReset,
}: {
  /** 后端回显的生效店参（键名同 query，可直接回填表单） */
  effParams?: BaobenParams
  kpi?: BaobenKpi
  loading?: boolean
  onApply: (params: AnalysisParams) => void
  onReset: () => void
}) {
  const [form] = Form.useForm<Record<string, number | null>>()
  const watched = Form.useWatch([], form) as Record<string, number | null> | undefined

  // 生效店参（权威来源为后端回显，不维护第二份本地默认值）
  useEffect(() => {
    if (effParams) form.setFieldsValue(effParams as Record<string, number | null>)
  }, [effParams, form])

  // 未重算提示：旧版是「输入即重算」，新版按快照回源，故必须显式提醒「改了还没算」
  const dirty = useMemo(() => {
    if (!watched || !effParams) return false
    return CALC_PARAM_GROUPS.some((g) =>
      g.fields.some((f) => {
        const cur = watched[f.key]
        const eff = effParams[f.key]
        if (cur == null || eff == null) return false
        return Math.abs(Number(cur) - (f.pct ? Number(eff) * 100 : Number(eff))) > 1e-9
      }),
    )
  }, [watched, effParams])

  const submit = async () => {
    const v = await form.validateFields()
    const patch: AnalysisParams = {}
    for (const g of CALC_PARAM_GROUPS) {
      for (const f of g.fields) {
        const raw = v[f.key]
        if (raw == null) continue
        const n = Number(raw)
        if (!Number.isFinite(n)) continue
        patch[f.key] = f.pct ? n / 100 : n
      }
    }
    onApply(patch)
  }

  const seats = effParams?.seats
  const turnover =
    seats && kpi?.guests != null && Number(seats) > 0 ? Number(kpi.guests) / Number(seats) : null

  const groupEcho: Record<string, ReactNode> = {
    var: (
      <>
        <Divider style={{ margin: '10px 0 6px' }} />
        <EchoRow label="变动成本率合计" value={pct(kpi?.var_rate, 2)} strong />
        <EchoRow label="边际贡献率" value={pct(kpi?.contribution_margin, 2)} strong />
        <EchoRow label="月固定成本合计" value={`${fmt(kpi?.fixed_month)} 元`} strong />
      </>
    ),
    op: (
      <>
        <Divider style={{ margin: '10px 0 6px' }} />
        <EchoRow label="日均点菜份数" value={`${fmt(kpi?.dish_qty, 1)} 份`} />
        <EchoRow label="日均客流" value={`${fmt(kpi?.guests, 0)} 人`} />
        <EchoRow label="人均消费（含酒水）" value={`${fmt(kpi?.avg_ticket)} 元`} />
        <EchoRow label="保本综合翻台" value={turnover != null ? `${turnover.toFixed(2)} 次` : '—'} />
      </>
    ),
  }

  return (
    <Card
      size="small"
      title="一、经营参数（固定成本 / 变动成本率 / 运营口径）"
      loading={loading}
      extra={
        <Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            只读测算，不写入配方/库存
          </Typography.Text>
          <Button size="small" onClick={onReset}>
            恢复默认参数
          </Button>
          <Button size="small" type="primary" loading={loading} onClick={submit}>
            按参数重算
          </Button>
        </Space>
      }
    >
      {/* 横排：标签左、输入右，与旧版参数行的紧凑排布一致（HTML:369-378） */}
      <Form form={form} layout="horizontal" size="small">
        <Row gutter={[16, 8]}>
          {CALC_PARAM_GROUPS.map((g) => (
            <Col xs={24} lg={8} key={g.id}>
              <Typography.Text strong style={{ fontSize: 13 }}>
                {g.title}
              </Typography.Text>
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {g.hint}
                </Typography.Text>
              </div>
              <div style={{ marginTop: 8 }}>
                {g.fields.map((f) => (
                  <Form.Item
                    key={f.key}
                    name={f.key}
                    label={f.label}
                    style={{ marginBottom: 6 }}
                    labelCol={{ flex: '132px' }}
                    wrapperCol={{ flex: '1 1 auto' }}
                  >
                    <InputNumber
                      min={0}
                      max={f.max}
                      step={f.step}
                      style={{ width: '100%' }}
                      // 单位用 suffix（addonAfter 在 antd v5 已弃用，控制台会告警）
                      suffix={<span style={{ fontSize: 12, color: '#9ca3af' }}>{f.pct ? '%' : f.unit}</span>}
                    />
                  </Form.Item>
                ))}
              </div>
              {groupEcho[g.id]}
            </Col>
          ))}
        </Row>
      </Form>
      <Divider style={{ margin: '12px 0 8px' }} />
      <Space size={12} wrap>
        <Typography.Text type={dirty ? 'warning' : 'secondary'} style={{ fontSize: 12 }}>
          {dirty
            ? '参数已改，尚未重算：点右上「按参数重算」后保本线与图表才按新参数刷新'
            : `当前生效店参来自 BFF 回显：面积 ${effParams?.area ?? '—'}㎡ · 员工 ${effParams?.staff ?? '—'} 人 · 餐位 ${effParams?.seats ?? '—'} 个 · ${effParams?.days ?? '—'} 天 · 目标月利润 ${fmt(effParams?.target_profit, 0)} 元`}
        </Typography.Text>
        {dirty && (
          <span
            style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: COLORS.red }}
          />
        )}
      </Space>
    </Card>
  )
}
