import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  Modal,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { Dayjs } from 'dayjs'
import { fetchFoodsafeDisinfect, logFoodsafeDisinfect } from '../../api'
import type { DisinfectResp, DisinfectState } from '../../api/types'
import { useAuthStore } from '../../store/auth'
import { COLORS } from '../../theme'

type AreaRow = {
  area: string
  status: string
  overdue: boolean
  color: string
}

const DEFAULT_AREAS = ['后厨操作台', '冷藏柜', '前厅餐具', '卫生间', '刀具砧板']
const METHODS = ['酒精擦拭', '含氯消毒液', '高温蒸汽', '紫外线', '洗碗机']

export default function DisinfectPage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const [date, setDate] = useState<Dayjs>(dayjs())
  const [span, setSpan] = useState(7)
  const [data, setData] = useState<DisinfectResp | null>(null)
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()

  const load = useCallback(() => {
    setLoading(true)
    fetchFoodsafeDisinfect({ date: date.format('YYYY-MM-DD'), span })
      .then((r) => {
        setData(r)
        setIsMock(false)
      })
      .catch(() => {
        setData(null)
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [date, span])

  useEffect(() => {
    load()
  }, [load])

  const todayRows: AreaRow[] = useMemo(() => {
    const doneSet = new Set(
      (data?.days ?? []).find((d) => d.date === date.format('YYYY-MM-DD'))?.done_areas ?? [],
    )
    const overdueSet = new Set((data?.overdue ?? []).map((o) => o.area))
    const pendingSet = new Set((data?.pending ?? []).map((o) => o.area))
    return (data?.areas ?? []).map((a) => {
      if (doneSet.has(a)) return { area: a, status: '已完成', overdue: false, color: COLORS.green }
      if (overdueSet.has(a)) return { area: a, status: '超时', overdue: true, color: COLORS.red }
      if (pendingSet.has(a)) return { area: a, status: '待执行', overdue: false, color: COLORS.yellow }
      return { area: a, status: '未做', overdue: false, color: COLORS.red }
    })
  }, [data, date])

  const cols: ColumnsType<AreaRow> = [
    { title: '区域', dataIndex: 'area' },
    {
      title: '今日状态',
      dataIndex: 'status',
      width: 140,
      render: (v, r) => <Tag color={r.color}>{r.overdue ? `${v}（需补做）` : v}</Tag>,
    },
    {
      title: '操作',
      key: 'op',
      width: 110,
      render: (_, r) => {
        if (!canWrite) return <span style={{ color: COLORS.gray }}>只读</span>
        if (r.status === '已完成') return <span style={{ color: COLORS.gray }}>已完成</span>
        return (
          <Button
            size="small"
            type="primary"
            onClick={() => {
              form.resetFields()
              form.setFieldsValue({ area: r.area, result: '已完成', date: dayjs() })
              setOpen(true)
            }}
          >
            登记消毒
          </Button>
        )
      },
    },
  ]

  const rateColor = (r: number | null | undefined) =>
    r == null ? COLORS.gray : r >= 100 ? COLORS.green : r >= 90 ? COLORS.yellow : COLORS.red

  const submit = async () => {
    const v = await form.validateFields()
    setBusy(true)
    try {
      const res = await logFoodsafeDisinfect({
        date: (v.date as Dayjs).format('YYYY-MM-DD'),
        area: v.area,
        method: v.method || undefined,
        operator: v.operator || undefined,
        result: v.result || '已完成',
      })
      if (res.ok) {
        message.success(res.note || '消毒登记已入队，待审批中心确认')
        setOpen(false)
        load()
      } else message.error(res.error || '登记失败')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '登记失败')
    } finally {
      setBusy(false)
    }
  }

  const overdue = data?.overdue ?? []
  const pending = (data?.pending ?? []).filter(
    (p: DisinfectState) => !overdue.some((o) => o.area === p.area),
  )

  return (
    <div>
      {isMock && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="后端 /api/foodsafe/disinfect 未连通，当前为本地样例数据"
        />
      )}

      {overdue.length > 0 && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={`今日消毒超时 ${overdue.length} 个区域（需补做）`}
          description={overdue.map((o) => o.area).join('、')}
        />
      )}

      <Card
        title={`消毒达标率（${span} 日窗口 · 区域覆盖口径）`}
        extra={
          <Space wrap>
            <Select
              style={{ width: 110 }}
              value={span}
              onChange={(v) => setSpan(v)}
              options={[7, 14, 30].map((d) => ({ value: d, label: `${d} 日` }))}
            />
            <DatePicker value={date} allowClear={false} onChange={(d) => d && setDate(d)} />
            <Tooltip title={canWrite ? undefined : '当前角色无写权限，仅可查看'}>
              <Button
                type="primary"
                disabled={!canWrite}
                onClick={() => {
                  form.resetFields()
                  form.setFieldsValue({ date: dayjs(), result: '已完成', area: data?.areas?.[0] })
                  setOpen(true)
                }}
              >
                消毒登记
              </Button>
            </Tooltip>
            <Button size="small" onClick={load}>
              刷新
            </Button>
          </Space>
        }
      >
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="应做区域" value={data?.areas?.length ?? 0} />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic
                title="今日完成"
                value={data?.today_done ?? 0}
                valueStyle={{ color: COLORS.green }}
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic
                title="今日未完成"
                value={data?.today_missed?.length ?? 0}
                valueStyle={{ color: (data?.today_missed?.length ?? 0) ? COLORS.red : COLORS.green }}
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic
                title={`${span} 日达标率`}
                value={data?.avg_rate ?? 0}
                suffix="%"
                valueStyle={{ color: rateColor(data?.avg_rate) }}
              />
            </Card>
          </Col>
        </Row>

        {(pending.length > 0 || overdue.length > 0) && (
          <Space wrap style={{ marginBottom: 16 }}>
            {pending.map((p) => (
              <Tag key={`p-${p.area}`} color={COLORS.yellow}>
                {p.area} · 待执行
              </Tag>
            ))}
            {overdue.map((o) => (
              <Tag key={`o-${o.area}`} color={COLORS.red}>
                {o.area} · 超时
              </Tag>
            ))}
          </Space>
        )}

        <Card size="small" title="每日达标率趋势" style={{ marginBottom: 16 }}>
          {(data?.days ?? []).map((d) => (
            <Row key={d.date} align="middle" gutter={8} style={{ marginBottom: 6 }}>
              <Col flex="96px">
                <Typography.Text type="secondary">{dayjs(d.date).format('MM-DD')}</Typography.Text>
              </Col>
              <Col flex="auto">
                <Progress
                  percent={d.rate ?? 0}
                  strokeColor={rateColor(d.rate)}
                  size="small"
                  format={(p) => `${p}%`}
                />
              </Col>
              <Col flex="150px" style={{ textAlign: 'right' }}>
                {d.missed.length > 0 ? (
                  <Tag color={COLORS.red}>漏 {d.missed.length} 区</Tag>
                ) : (
                  <Tag color={COLORS.green}>全覆盖</Tag>
                )}
              </Col>
            </Row>
          ))}
        </Card>

        <Card size="small" title={`今日区域明细（${date.format('YYYY-MM-DD')}）`}>
          <Table<AreaRow>
            rowKey="area"
            columns={cols}
            dataSource={todayRows}
            loading={loading}
            pagination={false}
            size="small"
          />
        </Card>
      </Card>

      <Modal
        title="消毒登记"
        open={open}
        onCancel={() => setOpen(false)}
        confirmLoading={busy}
        destroyOnHidden
        onOk={submit}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="area" label="区域" rules={[{ required: true, message: '请填写区域' }]}>
            <Select
              showSearch
              placeholder="选择或输入区域"
              options={(data?.areas ?? DEFAULT_AREAS).map((a) => ({ value: a, label: a }))}
            />
          </Form.Item>
          <Form.Item name="method" label="消毒方式">
            <Select
              allowClear
              placeholder="选填"
              options={METHODS.map((m) => ({ value: m, label: m }))}
            />
          </Form.Item>
          <Form.Item
            name="result"
            label="结果"
            rules={[{ required: true, message: '请选择结果' }]}
          >
            <Select
              options={['已完成', '待执行'].map((m) => ({ value: m, label: m }))}
            />
          </Form.Item>
          <Form.Item name="date" label="日期" rules={[{ required: true, message: '请选择日期' }]}>
            <DatePicker style={{ width: '100%' }} allowClear={false} />
          </Form.Item>
          <Form.Item name="operator" label="操作人">
            <Input placeholder="选填，默认当前账号" />
          </Form.Item>
          <Alert type="info" showIcon message="登记后进入审批中心确认，确认通过才写回店内库。" />
        </Form>
      </Modal>
    </div>
  )
}
