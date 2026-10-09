import { useCallback, useEffect, useState } from 'react'
import { rk } from '../../utils/rowKey'
import {
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  message,
  Row,
  Space,
  Table,
  Tag,
  Tooltip,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { Dayjs } from 'dayjs'
import { fetchBooking, postAction } from '../../api'
import type { BookingItem, QueueItem } from '../../api/types'
import { useAuthStore } from '../../store/auth'
import MockAlert from '../kitchen/components/MockAlert'
import { COLORS } from '../../theme'

function guest(b: BookingItem) {
  return b.guest_name ?? b.name ?? '-'
}
function people(b: BookingItem) {
  return b.party_size ?? b.people ?? '-'
}
function tableOf(b: BookingItem) {
  return b.table_id ?? b.table_type ?? '-'
}

export default function BookingPage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const noWriteTip = '当前角色无写权限，仅可查看'
  const [date, setDate] = useState<Dayjs>(dayjs())
  const [bookings, setBookings] = useState<BookingItem[]>([])
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [rev, setRev] = useState<string | number | undefined>()
  const [createOpen, setCreateOpen] = useState(false)
  const [form] = Form.useForm()

  const load = useCallback((d = date.format('YYYY-MM-DD')) => {
    setLoading(true)
    fetchBooking(d)
      .then((r) => {
        setBookings(r.bookings ?? [])
        setQueue(r.queue ?? [])
        setRev(r.rev)
        setIsMock(false)
      })
      .catch(() => {
        setBookings([])
        setQueue([])
        setRev(undefined)
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [date])

  useEffect(() => {
    load()
  }, [load])

  const runAction = async (type: string, payload: Record<string, unknown>, okMsg: string) => {
    setBusy(true)
    try {
      await postAction({ type, payload, operator: 'admin' })
      message.success(`${okMsg} · 已入队，请到审批中心确认`)
      load()
      return true
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '提交失败')
      return false
    } finally {
      setBusy(false)
    }
  }

  const bCols: ColumnsType<BookingItem> = [
    { title: '时间', dataIndex: 'time', width: 90, render: (v, r) => v ?? r.time ?? '-' },
    { title: '客人', key: 'guest', render: (_, r) => guest(r) },
    { title: '人数', key: 'people', width: 70, render: (_, r) => people(r) },
    { title: '电话', dataIndex: 'phone', width: 130, render: (v) => v ?? '-' },
    { title: '桌型', key: 'table', render: (_, r) => tableOf(r) },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v) => {
        const s = String(v ?? '')
        const color = /待/.test(s) ? COLORS.yellow : /确认|已/.test(s) ? COLORS.green : 'default'
        return <Tag color={color}>{s || '-'}</Tag>
      },
    },
    {
      title: '操作',
      key: 'op',
      width: 100,
      render: (_, r) => (
        <Tooltip title={canWrite ? undefined : noWriteTip}>
          <Button
            type="link"
            size="small"
            disabled={!canWrite}
            loading={busy}
            onClick={() =>
              runAction(
                'booking.upsert',
                {
                  id: r.id,
                  guest_name: guest(r),
                  party_size: people(r),
                  phone: r.phone,
                  status: '已确认',
                  date: date.format('YYYY-MM-DD'),
                  time: r.time,
                },
                `确认预订 ${guest(r)}`,
              )
            }
          >
            确认
          </Button>
        </Tooltip>
      ),
    },
  ]

  const qCols: ColumnsType<QueueItem> = [
    {
      title: '号牌',
      key: 'no',
      width: 90,
      render: (_, r) => String(r.queue_no ?? r.no ?? '-'),
    },
    {
      title: '人数',
      key: 'people',
      width: 70,
      render: (_, r) => r.party_size ?? r.people ?? '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (v) => <Tag>{String(v ?? '-')}</Tag>,
    },
    {
      title: '操作',
      key: 'op',
      width: 90,
      render: (_, r) => (
        <Tooltip title={canWrite ? undefined : noWriteTip}>
          <Button
            type="link"
            size="small"
            disabled={!canWrite}
            loading={busy}
            onClick={() =>
              runAction(
                'queue.call',
                { queue_no: r.queue_no ?? r.no, status: '叫号' },
                `叫号 ${r.queue_no ?? r.no}`,
              )
            }
          >
            叫号
          </Button>
        </Tooltip>
      ),
    },
  ]

  return (
    <div>
      {isMock && <MockAlert endpoint="/api/modules/booking" />}
      <Card
        title="预订排队"
        extra={
          <Space>
            <Tooltip title={canWrite ? undefined : noWriteTip}>
              <Button
                type="primary"
                disabled={!canWrite}
                onClick={() => {
                  form.resetFields()
                  form.setFieldsValue({ party_size: 4, time: '18:00', table_type: '4人桌' })
                  setCreateOpen(true)
                }}
              >
                新建预订
              </Button>
            </Tooltip>
            <DatePicker value={date} onChange={(d) => d && setDate(d)} allowClear={false} />
          </Space>
        }
      >
        <Row gutter={16}>
          <Col xs={24} lg={14}>
            <Table<BookingItem>
              rowKey={rk}
              title={() => `预订 · ${date.format('YYYY-MM-DD')} · rev=${rev ?? '-'}`}
              columns={bCols}
              dataSource={bookings}
              loading={loading}
              pagination={false}
              size="small"
            />
          </Col>
          <Col xs={24} lg={10}>
            <Table<QueueItem>
              rowKey={rk}
              title={() => '当前排队'}
              columns={qCols}
              dataSource={queue}
              loading={loading}
              pagination={false}
              size="small"
            />
          </Col>
        </Row>
      </Card>

      <Modal
        title="新建预订"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        confirmLoading={busy}
        destroyOnHidden
        onOk={async () => {
          const v = await form.validateFields()
          const ok = await runAction(
            'booking.upsert',
            {
              guest_name: v.guest_name,
              phone: v.phone,
              party_size: v.party_size,
              table_type: v.table_type,
              time: v.time,
              status: '待确认',
              date: date.format('YYYY-MM-DD'),
            },
            '新建预订',
          )
          if (ok) setCreateOpen(false)
        }}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="guest_name"
            label="姓名"
            rules={[{ required: true, message: '请填写客人姓名' }]}
          >
            <Input placeholder="客人姓名" />
          </Form.Item>
          <Form.Item
            name="phone"
            label="电话"
            rules={[
              { required: true, message: '请填写联系电话' },
              { pattern: /^1\d{10}$/, message: '请填写 11 位手机号' },
            ]}
          >
            <Input placeholder="11 位手机号" maxLength={11} />
          </Form.Item>
          <Form.Item
            name="time"
            label="到店时间"
            rules={[{ required: true, message: '请填写到店时间' }]}
          >
            <Input placeholder="HH:mm，如 18:00" />
          </Form.Item>
          <Form.Item
            name="party_size"
            label="人数"
            rules={[{ required: true, message: '请填写人数' }]}
          >
            <InputNumber min={1} max={50} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="table_type"
            label="桌型"
            rules={[{ required: true, message: '请选择桌型' }]}
          >
            <Select
              options={['2人桌', '4人桌', '6人桌', '8人桌', '包间'].map((t) => ({
                value: t,
                label: t,
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
