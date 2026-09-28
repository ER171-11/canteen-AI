import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Form,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  message,
} from 'antd'
import dayjs, { Dayjs } from 'dayjs'
import { fetchAdminDishes, fetchWorkorders, postAction } from '../../api'
import type { SopStep, WorkOrder } from '../../api/types'
import { useAuthStore } from '../../store/auth'
import ColorBadge from './components/ColorBadge'
import MockAlert from './components/MockAlert'
import { colorMeta } from './colorMeta'
import { MOCK_WORKORDERS } from './mock'
import { COLORS } from '../../theme'

const STATUS_TAG: Record<string, { color: string; text: string }> = {
  待开始: { color: 'default', text: '待开始' },
  制作中: { color: COLORS.yellow, text: '制作中' },
  进行中: { color: COLORS.yellow, text: '进行中' },
  待传: { color: COLORS.purple, text: '待传' },
  已完成: { color: COLORS.green, text: '已完成' },
}

function isActiveStatus(status: string): boolean {
  return status === '进行中' || status === '制作中' || status === '待传'
}

function isDoneStatus(status: string): boolean {
  return status === '已完成'
}

function stepDoneAt(
  stepsState: WorkOrder['steps_state'],
  stepNo: number,
): { done_at?: string; operator?: string } | undefined {
  if (!stepsState) return undefined
  return stepsState[String(stepNo)] ?? stepsState[String(Number(stepNo))]
}

/** 下一未完成步下标；全部完成返回 -1 */
function nextIncompleteIdx(steps: SopStep[], stepsState: WorkOrder['steps_state']): number {
  return steps.findIndex((s) => !stepDoneAt(stepsState, s.step_no)?.done_at)
}

function formatTs(ts?: string): string {
  if (!ts) return ''
  const d = dayjs(ts)
  return d.isValid() ? d.format('HH:mm') : ts
}

function WorkorderCard({
  wo,
  canWrite,
  clockingId,
  onClock,
}: {
  wo: WorkOrder
  canWrite: boolean
  clockingId: string | null
  onClock: (wo: WorkOrder, stepNo: number) => void
}) {
  const meta = colorMeta(wo.color)
  const tag = STATUS_TAG[wo.status] ?? { color: 'default', text: wo.status }
  const steps = wo.steps ?? []
  /** 有 steps_state（含空对象）走打卡态；否则回退旧高亮 */
  const useStateTimeline = wo.steps_state != null
  const nextIdx = useStateTimeline ? nextIncompleteIdx(steps, wo.steps_state) : -1
  const fallbackCurrentIdx = !useStateTimeline && isActiveStatus(wo.status) ? 0 : -1
  const sopTotal = wo.sop_total ?? (steps.length || undefined)
  const doneCount = useStateTimeline
    ? steps.filter((s) => stepDoneAt(wo.steps_state, s.step_no)?.done_at).length
    : isDoneStatus(wo.status)
      ? steps.length
      : 0

  return (
    <Card
      size="small"
      style={{ borderTop: `3px solid ${meta.hex}`, height: '100%' }}
      title={
        <Space>
          <ColorBadge color={wo.color} />
          <span>{wo.name}</span>
        </Space>
      }
      extra={<Tag color={tag.color}>{tag.text}</Tag>}
    >
      <Space split="·" wrap style={{ marginBottom: 12 }}>
        <Typography.Text>数量 {wo.qty} 份</Typography.Text>
        {wo.actual_yield != null && (
          <Typography.Text>
            出成 {wo.actual_yield} / 计划 {wo.qty}
          </Typography.Text>
        )}
        {sopTotal != null && sopTotal > 0 && (
          <Typography.Text type="secondary">
            SOP {doneCount}/{sopTotal} 步
          </Typography.Text>
        )}
        <Typography.Text type="secondary">
          计划开始 {wo.planned_start ?? '-'}
        </Typography.Text>
        <Typography.Text type="secondary">{wo.id}</Typography.Text>
      </Space>
      {steps.length > 0 && (
        <Timeline
          items={steps.map((s, i) => {
            const st = stepDoneAt(wo.steps_state, s.step_no)
            const done = !!st?.done_at || (!useStateTimeline && isDoneStatus(wo.status))
            const isCurrent = useStateTimeline
              ? nextIdx === i && !isDoneStatus(wo.status)
              : fallbackCurrentIdx === i
            const color = done
              ? COLORS.green
              : isCurrent
                ? COLORS.yellow
                : 'gray'
            return {
              color,
              children: (
                <div>
                  <span
                    style={
                      isCurrent ? { fontWeight: 700, color: COLORS.primary } : undefined
                    }
                  >
                    {s.stage}
                    {s.duration_min != null && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {' '}
                        {s.duration_min}min
                      </Typography.Text>
                    )}
                    {done && st?.done_at && (
                      <Tag color={COLORS.green} style={{ marginLeft: 6 }}>
                        已打卡
                      </Tag>
                    )}
                    {isCurrent && !done && (
                      <Tag color={COLORS.yellow} style={{ marginLeft: 6 }}>
                        当前
                      </Tag>
                    )}
                  </span>
                  {st?.done_at && (
                    <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                      {st.operator ? `${st.operator} · ` : ''}
                      {formatTs(st.done_at) || st.done_at}
                    </div>
                  )}
                  {isCurrent && canWrite && !done && (
                    <Button
                      size="small"
                      type="link"
                      style={{ padding: 0, height: 'auto', marginTop: 4 }}
                      loading={clockingId === `${wo.id}:${s.step_no}`}
                      onClick={() => onClock(wo, s.step_no)}
                    >
                      打卡
                    </Button>
                  )}
                </div>
              ),
            }
          })}
        />
      )}
    </Card>
  )
}

export default function WorkorderPage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const account = useAuthStore((s) => s.account)
  const role = useAuthStore((s) => s.role)
  const [date, setDate] = useState<Dayjs>(dayjs())
  const [items, setItems] = useState<WorkOrder[]>([])
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [clockingId, setClockingId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [skuOpts, setSkuOpts] = useState<Array<{ value: string; label: string }>>([])
  const [form] = Form.useForm()

  const load = useCallback((d: Dayjs) => {
    setLoading(true)
    fetchWorkorders(d.format('YYYY-MM-DD'))
      .then((resp) => {
        setItems(resp.workorders ?? [])
        setIsMock(false)
      })
      .catch(() => {
        setItems(MOCK_WORKORDERS)
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load(date)
  }, [date, load])

  const onClock = async (wo: WorkOrder, stepNo: number) => {
    const key = `${wo.id}:${stepNo}`
    setClockingId(key)
    try {
      await postAction({
        type: 'workorder.step_clock',
        payload: { id: wo.id, step_no: stepNo },
        operator: role ?? account ?? 'admin',
      })
      message.success(`步骤 ${stepNo} 打卡已入队 → 请到审批中心确认`)
      load(date)
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '打卡提交失败')
    } finally {
      setClockingId(null)
    }
  }

  const openCreate = () => {
    form.resetFields()
    form.setFieldsValue({
      qty: 30,
      planned_start: dayjs(`${date.format('YYYY-MM-DD')}T10:00`),
    })
    setCreateOpen(true)
    fetchAdminDishes()
      .then((r) =>
        setSkuOpts(
          (r.items ?? [])
            .filter((d) => d.id && d.name)
            .map((d) => ({ value: d.id, label: `${d.name}（${d.id}）` })),
        ),
      )
      .catch(() => setSkuOpts([]))
  }

  return (
    <div>
      <Card
        title="工单排产"
        extra={
          <Space>
            <DatePicker
              value={date}
              allowClear={false}
              onChange={(d) => d && setDate(d)}
            />
            <Tooltip title={canWrite ? undefined : '当前角色无写权限，仅可查看'}>
              <Button type="primary" disabled={!canWrite} onClick={openCreate}>
                新建工单
              </Button>
            </Tooltip>
          </Space>
        }
      >
        {isMock && <MockAlert endpoint="/api/sop/workorder" />}
        <Spin spinning={loading}>
          {items.length === 0 && !loading ? (
            <Empty description="当日暂无工单" />
          ) : (
            <Row gutter={[16, 16]}>
              {items.map((wo) => (
                <Col xs={24} md={12} xl={8} key={wo.id}>
                  <WorkorderCard
                    wo={wo}
                    canWrite={canWrite && !isMock}
                    clockingId={clockingId}
                    onClock={onClock}
                  />
                </Col>
              ))}
            </Row>
          )}
        </Spin>
      </Card>

      <Modal
        title="新建工单"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        confirmLoading={busy}
        destroyOnHidden
        onOk={async () => {
          const v = await form.validateFields()
          setBusy(true)
          try {
            const sku = skuOpts.find((o) => o.value === v.sku_id)
            await postAction({
              type: 'workorder.create',
              payload: {
                date: date.format('YYYY-MM-DD'),
                sku_id: v.sku_id,
                name: sku ? sku.label.replace(/（.*）$/, '') : undefined,
                qty: v.qty,
                planned_start: (v.planned_start as Dayjs).format('YYYY-MM-DDTHH:mm'),
                status: '待开始',
              },
              operator: 'admin',
            })
            message.success('工单已入队 → 请到审批中心确认')
            setCreateOpen(false)
            load(date)
          } catch (e: unknown) {
            const err = e as { response?: { data?: { error?: string } } }
            message.error(err.response?.data?.error || '提交失败')
          } finally {
            setBusy(false)
          }
        }}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="sku_id"
            label="菜品（SKU）"
            rules={[{ required: true, message: '请选择菜品' }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="从菜品库选择"
              options={skuOpts}
              notFoundContent="菜品库为空或 BFF 未连接"
            />
          </Form.Item>
          <Form.Item
            name="qty"
            label="数量（份）"
            rules={[{ required: true, message: '请填写数量' }]}
          >
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="planned_start"
            label="计划开始时间"
            rules={[{ required: true, message: '请选择计划时间' }]}
          >
            <DatePicker showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
