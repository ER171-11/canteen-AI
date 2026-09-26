import { useEffect, useState } from 'react'
import { Button, Card, Col, DatePicker, message, Row, Space, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { Dayjs } from 'dayjs'
import { fetchBooking, postAction } from '../../api'
import type { BookingItem, QueueItem } from '../../api/types'
import MockAlert from '../kitchen/components/MockAlert'
import { MOCK_BOOKING } from '../../mock/modules'
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
  const [date, setDate] = useState<Dayjs>(dayjs())
  const [bookings, setBookings] = useState<BookingItem[]>([])
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [rev, setRev] = useState<string | number | undefined>()

  const load = (d = date.format('YYYY-MM-DD')) => {
    setLoading(true)
    fetchBooking(d)
      .then((r) => {
        setBookings(r.bookings ?? [])
        setQueue(r.queue ?? [])
        setRev(r.rev)
        setIsMock(false)
      })
      .catch(() => {
        setBookings(MOCK_BOOKING.bookings)
        setQueue(MOCK_BOOKING.queue)
        setRev('mock')
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [date])

  const runAction = async (type: string, payload: Record<string, unknown>, okMsg: string) => {
    setBusy(true)
    try {
      await postAction({ type, payload, operator: 'admin' })
      message.success(`${okMsg} · 已入队，请到审批中心确认`)
      load()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '提交失败')
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
        <Button
          type="link"
          size="small"
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
        <Button
          type="link"
          size="small"
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
            <Button
              type="primary"
              loading={busy}
              onClick={() =>
                runAction(
                  'booking.upsert',
                  {
                    guest_name: '散客',
                    party_size: 4,
                    phone: '13800000000',
                    status: '待确认',
                    date: date.format('YYYY-MM-DD'),
                    time: '18:00',
                    table_type: '4人桌',
                  },
                  '新建预订',
                )
              }
            >
              新建预订
            </Button>
            <DatePicker value={date} onChange={(d) => d && setDate(d)} allowClear={false} />
          </Space>
        }
      >
        <Row gutter={16}>
          <Col xs={24} lg={14}>
            <Table<BookingItem>
              rowKey={(r, i) => String(r.id ?? `${guest(r)}-${r.time}-${i}`)}
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
              rowKey={(r, i) => String(r.queue_no ?? r.no ?? i)}
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
    </div>
  )
}
