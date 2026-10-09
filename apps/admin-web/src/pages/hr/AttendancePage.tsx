import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  AutoComplete,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
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
import { fetchStaffClock, fetchStaffConfig, postAction, saveStaffConfig } from '../../api'
import type { AttendanceRow, StaffClockResp } from '../../api/types'
import { useAuthStore } from '../../store/auth'
import { COLORS } from '../../theme'

function FallbackAlert() {
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      message="后端 /api/staff/clock 未连通，当前为本地样例数据"
    />
  )
}

function statusColor(s: string) {
  if (/^迟到/.test(s)) return COLORS.red
  if (/^准点/.test(s)) return COLORS.green
  if (/^缺勤/.test(s)) return COLORS.red
  if (/补录/.test(s)) return COLORS.blue
  return COLORS.yellow
}

export default function AttendancePage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const [date, setDate] = useState(dayjs())
  const [data, setData] = useState<StaffClockResp | null>(null)
  const [th, setTh] = useState({ late_min: 10, absent_min: 30 })
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [openTh, setOpenTh] = useState(false)
  const [form] = Form.useForm()
  const [thForm] = Form.useForm()

  const load = useCallback(() => {
    setLoading(true)
    const d = date.format('YYYY-MM-DD')
    Promise.all([fetchStaffClock(d), fetchStaffConfig().catch(() => null)])
      .then(([c, cfg]) => {
        setData(c)
        setTh(c.thresholds ?? cfg?.attendance ?? { late_min: 10, absent_min: 30 })
        setIsMock(false)
      })
      .catch(() => {
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [date])

  useEffect(() => {
    load()
  }, [load])

  const staffOpts = useMemo(
    () =>
      (data?.rows ?? []).map((r) => ({
        value: r.staff_id ?? r.staff_name,
        label: r.staff_name,
      })),
    [data],
  )

  const columns: ColumnsType<AttendanceRow> = [
    {
      title: '员工',
      key: 'staff',
      width: 130,
      render: (_, r) => (
        <Space size={4}>
          <span>{r.staff_name}</span>
          {r.makeup && <Tag color={COLORS.blue}>补录</Tag>}
        </Space>
      ),
    },
    { title: '岗位', dataIndex: 'role', width: 80, render: (v) => v ?? '-' },
    {
      title: '排班',
      key: 'shift',
      width: 160,
      render: (_, r) => (
        <span>
          <Tag>{r.shift ?? '-'}</Tag>
          <span style={{ color: COLORS.gray }}>
            {r.start_time ?? '-'}–{r.end_time ?? '-'}
          </span>
        </span>
      ),
    },
    {
      title: '实到打卡',
      dataIndex: 'clock_ts',
      width: 150,
      render: (v) => v ?? <span style={{ color: COLORS.gray }}>未打卡</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 120,
      render: (v: string) => <Tag color={statusColor(v ?? '')}>{v || '-'}</Tag>,
    },
    {
      title: '迟到分钟',
      dataIndex: 'late_min',
      width: 100,
      align: 'right',
      render: (v: number | null, r) =>
        /^迟到/.test(r.status) && v != null ? (
          <span style={{ color: COLORS.red }}>{v} 分</span>
        ) : (
          <span style={{ color: COLORS.gray }}>-</span>
        ),
    },
  ]

  return (
    <div>
      {isMock && <FallbackAlert />}
      <Card
        title="打卡状态机 · 应到 / 实到 / 迟到 / 缺勤"
        extra={
          <Space>
            <DatePicker
              value={date}
              allowClear={false}
              onChange={(v) => v && setDate(v)}
            />
            <Tooltip title={canWrite ? undefined : '当前角色无写权限，仅可查看'}>
              <Button
                onClick={() => {
                  thForm.setFieldsValue(th)
                  setOpenTh(true)
                }}
                disabled={!canWrite}
              >
                阈值设置
              </Button>
            </Tooltip>
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
        <Space size={32} style={{ marginBottom: 12 }} wrap>
          <Statistic title="应到" value={data?.expected ?? 0} />
          <Statistic title="实到" value={data?.clocked ?? 0} valueStyle={{ color: COLORS.green }} />
          <Statistic title="准点" value={data?.on_time ?? 0} />
          <Statistic
            title="迟到"
            value={data?.late ?? 0}
            valueStyle={{ color: COLORS.yellow }}
          />
          <Statistic
            title="缺勤"
            value={data?.absent ?? 0}
            valueStyle={{ color: COLORS.red }}
          />
          <Statistic title="补录" value={data?.makeup ?? 0} />
          <Statistic
            title="当前阈值"
            value={th.late_min}
            suffix={`分迟到 / ${th.absent_min} 分缺勤`}
            valueStyle={{ fontSize: 18, color: COLORS.gray }}
          />
        </Space>
        <Table<AttendanceRow>
          rowKey={(r) => r.staff_id ?? r.staff_name}
          columns={columns}
          dataSource={data?.rows ?? []}
          loading={loading}
          pagination={false}
          size="small"
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
            const hit = data?.rows.find((r) => (r.staff_id ?? r.staff_name) === v.staff_name)
            await postAction({
              type: 'staff.clock',
              payload: {
                staff_id: hit?.staff_id ?? undefined,
                staff_name: hit?.staff_name ?? v.staff_name,
                kind: v.kind,
                time: v.time.format('YYYY-MM-DD HH:mm'),
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
              placeholder="从当日排班选或输入姓名"
              filterOption={(i, o) => String(o?.label ?? '').includes(i)}
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
          <Form.Item name="note" label="补录说明">
            <Input.TextArea rows={2} placeholder="如：设备故障未打卡" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="迟到 / 缺勤阈值设置"
        open={openTh}
        onCancel={() => setOpenTh(false)}
        confirmLoading={busy}
        destroyOnHidden
        onOk={async () => {
          const v = await thForm.validateFields()
          setBusy(true)
          try {
            const res = await saveStaffConfig({
              late_min: v.late_min,
              absent_min: v.absent_min,
            })
            setTh(res.attendance)
            message.success(
              `阈值已更新：超 ${res.attendance.late_min} 分迟到、超 ${res.attendance.absent_min} 分缺勤`,
            )
            setOpenTh(false)
            load()
          } catch (e: unknown) {
            const err = e as { response?: { data?: { error?: string } } }
            message.error(err.response?.data?.error || '保存失败')
          } finally {
            setBusy(false)
          }
        }}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="判定口径"
          description="实际打卡晚于排班开始时间：≤ 迟到阈值记准点；超过迟到阈值但未超过缺勤阈值记「迟到 N 分」；超过缺勤阈值记缺勤。"
        />
        <Form form={thForm} layout="vertical" preserve={false}>
          <Form.Item
            name="late_min"
            label="迟到阈值（分钟）"
            rules={[{ required: true, message: '请输入迟到阈值' }]}
          >
            <InputNumber min={0} max={120} style={{ width: '100%' }} addonAfter="分钟" />
          </Form.Item>
          <Form.Item
            name="absent_min"
            label="缺勤阈值（分钟）"
            rules={[{ required: true, message: '请输入缺勤阈值' }]}
          >
            <InputNumber min={1} max={480} style={{ width: '100%' }} addonAfter="分钟" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
