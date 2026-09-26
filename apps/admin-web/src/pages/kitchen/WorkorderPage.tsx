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
import type { WorkOrder } from '../../api/types'
import { useAuthStore } from '../../store/auth'
import ColorBadge from './components/ColorBadge'
import MockAlert from './components/MockAlert'
import { colorMeta } from './colorMeta'
import { MOCK_WORKORDERS } from './mock'
import { COLORS } from '../../theme'

const STATUS_TAG: Record<string, { color: string; text: string }> = {
  待开始: { color: 'default', text: '待开始' },
  进行中: { color: COLORS.yellow, text: '进行中' },
  已完成: { color: COLORS.green, text: '已完成' },
}

function WorkorderCard({ wo }: { wo: WorkOrder }) {
  const meta = colorMeta(wo.color)
  const tag = STATUS_TAG[wo.status] ?? { color: 'default', text: wo.status }

  /*
   * 当前 stage 高亮：已完成→全部绿；待开始→全部灰；
   * 进行中→高亮首个步骤为当前（契约未下发 current_stage，后续接入后替换）。
   */
  const currentIdx = wo.status === '进行中' ? 0 : -1

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
        <Typography.Text type="secondary">
          计划开始 {wo.planned_start ?? '-'}
        </Typography.Text>
        <Typography.Text type="secondary">{wo.id}</Typography.Text>
      </Space>
      {wo.steps && wo.steps.length > 0 && (
        <Timeline
          items={wo.steps.map((s, i) => ({
            color:
              wo.status === '已完成'
                ? COLORS.green
                : i === currentIdx
                  ? COLORS.yellow
                  : 'gray',
            children: (
              <span
                style={
                  i === currentIdx ? { fontWeight: 700, color: COLORS.primary } : undefined
                }
              >
                {s.stage}
                {s.duration_min != null && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {' '}
                    {s.duration_min}min
                  </Typography.Text>
                )}
                {i === currentIdx && (
                  <Tag color={COLORS.yellow} style={{ marginLeft: 6 }}>
                    当前
                  </Tag>
                )}
              </span>
            ),
          }))}
        />
      )}
    </Card>
  )
}

export default function WorkorderPage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const [date, setDate] = useState<Dayjs>(dayjs())
  const [items, setItems] = useState<WorkOrder[]>([])
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
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
                  <WorkorderCard wo={wo} />
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
        destroyOnClose
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
