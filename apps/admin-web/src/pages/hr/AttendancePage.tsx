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
import type { ClockItem } from '../../api/types'
import { useAuthStore } from '../../store/auth'
import MockAlert from '../kitchen/components/MockAlert'
import { MOCK_STAFF } from '../../mock/modules'
import { COLORS } from '../../theme'

function staffName(r: ClockItem) {
  return String(r.staff_name ?? r.name ?? r.staff ?? r.staff_id ?? '-')
}

export default function AttendancePage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const [rows, setRows] = useState<ClockItem[]>([])
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()

  const load = () => {
    setLoading(true)
    fetchModulesStaff()
      .then((r) => {
        setRows(r.clock ?? [])
        setIsMock(false)
      })
      .catch(() => {
        setRows(MOCK_STAFF.clock)
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

  const columns: ColumnsType<ClockItem> = [
    { title: '员工', key: 'name', render: (_, r) => staffName(r) },
    { title: '时间', key: 'ts', render: (_, r) => String(r.ts ?? r.time ?? '-') },
    { title: '类型', dataIndex: 'kind', width: 90, render: (v) => v ?? '上班' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v) => {
        const s = String(v ?? '')
        const color = /迟到/.test(s) ? COLORS.red : /准点/.test(s) ? COLORS.green : COLORS.yellow
        return <Tag color={color}>{s || '-'}</Tag>
      },
    },
  ]

  return (
    <div>
      {isMock && <MockAlert endpoint="/api/modules/staff" />}
      <Card
        title="打卡补录"
        extra={
          <Space>
            <Tooltip title={canWrite ? undefined : '当前角色无写权限，仅可查看'}>
              <Button
                type="primary"
                disabled={!canWrite}
                onClick={() => {
                  form.resetFields()
                  form.setFieldsValue({ kind: '上班', time: dayjs() })
                  setOpen(true)
                }}
              >
                补打卡
              </Button>
            </Tooltip>
            <Button size="small" onClick={load}>
              刷新
            </Button>
          </Space>
        }
      >
        <Table<ClockItem>
          rowKey={rk}
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={{ pageSize: 20 }}
        />
      </Card>

      <Modal
        title="补打卡"
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
              type: 'staff.clock',
              payload: {
                staff_id: hit?.staff_id ?? undefined,
                staff_name: v.staff_name,
                kind: v.kind,
                time: (v.time as Dayjs).format('YYYY-MM-DD HH:mm'),
                status: '补录',
              },
              operator: 'admin',
            })
            message.success('补打卡已入队 → 审批中心确认')
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
              placeholder="从打卡记录选或输入姓名"
              filterOption={(input, opt) =>
                String(opt?.label ?? '').includes(input)
              }
            />
          </Form.Item>
          <Form.Item name="kind" label="类型" rules={[{ required: true, message: '请选择类型' }]}>
            <Select options={['上班', '下班'].map((s) => ({ value: s, label: s }))} />
          </Form.Item>
          <Form.Item
            name="time"
            label="打卡时间"
            rules={[{ required: true, message: '请选择打卡时间' }]}
          >
            <DatePicker
              showTime={{ format: 'HH:mm' }}
              format="YYYY-MM-DD HH:mm"
              style={{ width: '100%' }}
              allowClear={false}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
