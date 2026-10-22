import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { fetchStaffRoster, submitAndConfirmAction } from '../../api'
import type { StaffRosterItem } from '../../api/types'
import { useAuthStore } from '../../store/auth'
import { COLORS } from '../../theme'

const ROLE_OPTIONS = ['厨师', '厨师长', '店长', '收银', '服务员', '切配', '洗碗工', '保洁'].map(
  (r) => ({ value: r, label: r }),
)

export default function StaffRosterPage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const account = useAuthStore((s) => s.account)
  const role = useAuthStore((s) => s.role)
  const [rows, setRows] = useState<StaffRosterItem[]>([])
  const [loading, setLoading] = useState(true)
  const [isMock, setIsMock] = useState(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form] = Form.useForm()

  const load = useCallback(() => {
    setLoading(true)
    fetchStaffRoster()
      .then((r) => {
        setRows(r.staff ?? [])
        setIsMock(false)
      })
      .catch(() => setIsMock(true))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const activeCount = useMemo(() => rows.filter((r) => r.status !== '离职').length, [rows])
  const offCount = rows.length - activeCount

  const columns: ColumnsType<StaffRosterItem> = [
    { title: '工号', dataIndex: 'staff_id', width: 120, render: (v) => v ?? '-' },
    { title: '姓名', dataIndex: 'staff_name', width: 100, fixed: 'left' },
    { title: '岗位', dataIndex: 'role', width: 90, render: (v) => v ?? '-' },
    { title: '电话', dataIndex: 'phone', width: 130, render: (v) => v ?? '-' },
    { title: '入职日期', dataIndex: 'hire_date', width: 110, render: (v) => v ?? '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (v) =>
        v === '离职' ? (
          <Tag color={COLORS.red}>离职</Tag>
        ) : (
          <Tag color={COLORS.green}>{v || '在岗'}</Tag>
        ),
    },
    { title: '备注', dataIndex: 'remark', ellipsis: true, render: (v) => v ?? '-' },
  ]

  const doSubmit = async () => {
    const v = await form.validateFields()
    setBusy(true)
    try {
      const res = await submitAndConfirmAction({
        type: 'staff.upsert',
        operator: account || role || 'admin',
        payload: {
          staff_id: v.staff_id?.trim() || undefined,
          staff_name: v.staff_name.trim(),
          role: v.role || undefined,
          phone: v.phone?.trim() || undefined,
          hire_date: v.hire_date ? dayjs(v.hire_date).format('YYYY-MM-DD') : undefined,
          status: v.status || '在岗',
          remark: v.remark?.trim() || undefined,
        },
      })
      if (res?.ok) {
        message.success('已入队并确认，等待店内落库后刷新即可见（可在审批中心查看执行）')
        setOpen(false)
        load()
      } else message.error((res && res.error) || '添加失败')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '添加失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      {isMock && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="后端 /api/staff/roster 未连通，当前无法加载员工花名册"
        />
      )}
      <Card
        title="员工花名册"
        extra={
          <Space>
            <Tooltip title={canWrite ? undefined : '当前角色无写权限，仅可查看'}>
              <Button
                type="primary"
                disabled={!canWrite}
                onClick={() => {
                  form.resetFields()
                  form.setFieldsValue({ status: '在岗' })
                  setOpen(true)
                }}
              >
                添加员工
              </Button>
            </Tooltip>
            <Button size="small" onClick={load}>
              刷新
            </Button>
          </Space>
        }
      >
        <Space size={40} style={{ marginBottom: 12 }}>
          <Statistic title="在册人数" value={rows.length} />
          <Statistic title="在岗" value={activeCount} valueStyle={{ color: COLORS.green }} />
          <Statistic title="离职" value={offCount} valueStyle={{ color: COLORS.gray }} />
        </Space>
        <Table<StaffRosterItem>
          rowKey={(r) => r.staff_id ?? r.staff_name}
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={rows.length > 10 ? { pageSize: 10 } : false}
          size="small"
          scroll={{ x: 800 }}
        />
      </Card>

      <Modal
        title="添加员工"
        open={open}
        onCancel={() => setOpen(false)}
        confirmLoading={busy}
        destroyOnHidden
        okText="入队确认"
        onOk={doSubmit}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="工号留空将自动生成；提交后经审批中心确认 → 店内落库，刷新本页即可见。"
        />
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="staff_name"
            label="姓名"
            rules={[{ required: true, message: '请输入姓名' }]}
          >
            <Input placeholder="员工姓名" maxLength={20} />
          </Form.Item>
          <Form.Item name="staff_id" label="工号">
            <Input placeholder="留空自动生成（如 ST3F9A2B1）" maxLength={20} />
          </Form.Item>
          <Form.Item name="role" label="岗位">
            <Select showSearch allowClear placeholder="选择岗位" options={ROLE_OPTIONS} />
          </Form.Item>
          <Form.Item name="phone" label="联系电话">
            <Input placeholder="手机号" maxLength={20} />
          </Form.Item>
          <Form.Item name="hire_date" label="入职日期">
            <DatePicker style={{ width: '100%' }} allowClear />
          </Form.Item>
          <Form.Item name="status" label="状态" initialValue="在岗">
            <Select
              options={[
                { value: '在岗', label: '在岗' },
                { value: '离职', label: '离职' },
              ]}
            />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} placeholder="选填" maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
