import { useEffect, useMemo, useState } from 'react'
import { rk } from '../../utils/rowKey'
import {
  AutoComplete,
  Button,
  Card,
  DatePicker,
  Form,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { type Dayjs } from 'dayjs'
import { fetchModulesStaff, postAction } from '../../api'
import type { ShiftItem } from '../../api/types'
import { useAuthStore } from '../../store/auth'
import MockAlert from '../kitchen/components/MockAlert'
import { MOCK_STAFF } from '../../mock/modules'

function staffName(r: ShiftItem) {
  return String(r.staff_name ?? r.name ?? r.staff ?? r.staff_id ?? '-')
}

export default function SchedulePage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const [rows, setRows] = useState<ShiftItem[]>([])
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [rev, setRev] = useState<string | number | undefined>()
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()

  const load = () => {
    setLoading(true)
    fetchModulesStaff()
      .then((r) => {
        setRows(r.shifts ?? [])
        setRev(r.rev)
        setIsMock(false)
      })
      .catch(() => {
        setRows(MOCK_STAFF.shifts)
        setRev('mock')
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  const staffOpts = useMemo(() => {
    const seen = new Set<string>()
    const out: Array<{ value: string; label: string }> = []
    for (const r of rows) {
      const n = staffName(r)
      if (n !== '-' && !seen.has(n)) {
        seen.add(n)
        out.push({ value: n, label: n })
      }
    }
    return out
  }, [rows])

  const columns: ColumnsType<ShiftItem> = useMemo(
    () => [
      { title: '员工', key: 'name', render: (_, r) => staffName(r) },
      { title: '角色', dataIndex: 'role', width: 100, render: (v) => v ?? '-' },
      { title: '日期', dataIndex: 'date', width: 120, render: (v) => v ?? '-' },
      { title: '班次', dataIndex: 'shift', width: 90, render: (v) => <Tag>{String(v ?? '-')}</Tag> },
      {
        title: '时段',
        key: 'span',
        width: 140,
        render: (_, r) =>
          r.start_time || r.end_time ? `${r.start_time ?? ''}–${r.end_time ?? ''}` : '-',
      },
    ],
    [],
  )

  return (
    <div>
      {isMock && <MockAlert endpoint="/api/modules/staff" />}
      <Card
        title={`排班登记 · rev=${rev ?? '-'}`}
        extra={
          <Space>
            <Tooltip title={canWrite ? undefined : '当前角色无写权限，仅可查看'}>
              <Button
                type="primary"
                disabled={!canWrite}
                onClick={() => {
                  form.resetFields()
                  form.setFieldsValue({ date: dayjs(), shift: '早班' })
                  setOpen(true)
                }}
              >
                登记换班
              </Button>
            </Tooltip>
            <Button size="small" onClick={load}>
              刷新
            </Button>
          </Space>
        }
      >
        <Table<ShiftItem>
          rowKey={rk}
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={{ pageSize: 20 }}
        />
      </Card>

      <Modal
        title="登记换班"
        open={open}
        onCancel={() => setOpen(false)}
        confirmLoading={busy}
        destroyOnHidden
        onOk={async () => {
          const v = await form.validateFields()
          setBusy(true)
          try {
            const hit = rows.find((r) => staffName(r) === v.staff_name)
            await postAction({
              type: 'staff.shift_upsert',
              payload: {
                staff_id: hit?.staff_id ?? undefined,
                staff_name: v.staff_name,
                date: (v.date as Dayjs).format('YYYY-MM-DD'),
                shift: v.shift,
                role: hit?.role ?? undefined,
              },
              operator: 'admin',
            })
            message.success('换班已入队 → 审批中心确认')
            setOpen(false)
            load()
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
            name="staff_name"
            label="员工"
            rules={[{ required: true, message: '请选择或输入员工' }]}
          >
            <AutoComplete
              options={staffOpts}
              placeholder="从排班名单选或输入姓名"
              filterOption={(input, opt) =>
                String(opt?.label ?? '').includes(input)
              }
            />
          </Form.Item>
          <Form.Item name="date" label="日期" rules={[{ required: true, message: '请选择日期' }]}>
            <DatePicker style={{ width: '100%' }} allowClear={false} />
          </Form.Item>
          <Form.Item name="shift" label="班次" rules={[{ required: true, message: '请选择班次' }]}>
            <Select
              options={['早班', '中班', '晚班'].map((s) => ({ value: s, label: s }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
