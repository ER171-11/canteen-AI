import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  AutoComplete,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Empty,
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
import {
  actShiftSwap,
  fetchStaffSchedule,
  fetchStaffSwaps,
  fetchStaffTrain,
  requestShiftSwap,
} from '../../api'
import type {
  StaffScheduleResp,
  StaffScheduleRow,
  SwapItem,
  SwapStatus,
} from '../../api/types'
import { useAuthStore } from '../../store/auth'
import { COLORS } from '../../theme'

const SHIFT_COLOR: Record<string, string> = {
  A: COLORS.blue,
  B: COLORS.purple,
  C: COLORS.orange,
  休: COLORS.gray,
}

const STATUS_META: Record<SwapStatus, { text: string; color: string }> = {
  pending_peer: { text: '待接手人同意', color: COLORS.yellow },
  pending_manager: { text: '待店长审批', color: COLORS.blue },
  applied: { text: '已生效', color: COLORS.green },
  rejected: { text: '已驳回', color: COLORS.red },
}

function FallbackAlert() {
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      message="后端 /api/staff/* 未连通，当前为本地样例数据"
    />
  )
}

export default function SchedulePage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const [week, setWeek] = useState(dayjs())
  const [sched, setSched] = useState<StaffScheduleResp | null>(null)
  const [swaps, setSwaps] = useState<SwapItem[]>([])
  const [blocked, setBlocked] = useState<Set<string>>(new Set())
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()

  const load = useCallback(() => {
    setLoading(true)
    const w = week.format('YYYY-MM-DD')
    Promise.all([
      fetchStaffSchedule(w),
      fetchStaffSwaps(),
      fetchStaffTrain().catch(() => null),
    ])
      .then(([s, sw, tr]) => {
        setSched(s)
        setSwaps(sw.items ?? [])
        const red = new Set<string>(
          (tr?.certs ?? []).filter((c) => c.blocked).map((c) => c.staff_name),
        )
        setBlocked(red)
        setIsMock(false)
      })
      .catch(() => {
        setSwaps([])
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [week])

  useEffect(() => {
    load()
  }, [load])

  const staffOpts = useMemo(
    () =>
      (sched?.staff ?? []).map((s) => ({
        value: s.staff_id ?? s.staff_name,
        label: s.staff_name,
      })),
    [sched],
  )

  const columns: ColumnsType<StaffScheduleRow> = useMemo(() => {
    const dayCols: ColumnsType<StaffScheduleRow> = (sched?.days ?? []).map((d) => ({
      title: `${dayjs(d).format('MM-DD')} 周${'一二三四五六日'[dayjs(d).day() === 0 ? 6 : dayjs(d).day() - 1]}`,
      key: d,
      width: 74,
      align: 'center',
      render: (_, r) => {
        const code = r.cells?.[d] ?? '-'
        return code === '-' ? (
          <span style={{ color: COLORS.gray }}>-</span>
        ) : (
          <Tag color={SHIFT_COLOR[code] ?? COLORS.blue} style={{ margin: 0 }}>
            {code}
          </Tag>
        )
      },
    }))
    return [
      {
        title: '员工',
        key: 'staff',
        width: 150,
        fixed: 'left',
        render: (_, r) => (
          <Space size={4}>
            <span>{r.staff_name}</span>
            {blocked.has(r.staff_name) && (
              <Tooltip title="健康证 7 天内到期或已过期，排班禁岗">
                <Tag color={COLORS.red} style={{ margin: 0 }}>
                  禁岗
                </Tag>
              </Tooltip>
            )}
          </Space>
        ),
      },
      { title: '岗位', dataIndex: 'role', width: 80, render: (v) => v ?? '-' },
      ...dayCols,
      {
        title: '工时',
        dataIndex: 'hours',
        width: 80,
        align: 'right',
        sorter: (a, b) => a.hours - b.hours,
        render: (v: number) => <b>{v}h</b>,
      },
    ]
  }, [sched, blocked])

  const swapColumns: ColumnsType<SwapItem> = [
    {
      title: '班次',
      key: 'shift',
      width: 150,
      render: (_, r) => (
        <Space size={4}>
          <Tag>{r.shift}</Tag>
          <span style={{ color: COLORS.gray }}>{r.date}</span>
        </Space>
      ),
    },
    {
      title: '申请人 → 接手人',
      key: 'who',
      render: (_, r) => (
        <span>
          {r.from_name ?? r.from_staff}
          <span style={{ color: COLORS.gray }}> → </span>
          {r.to_name ?? r.to_staff}
        </span>
      ),
    },
    { title: '事由', dataIndex: 'reason', width: 140, render: (v) => v ?? '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 120,
      render: (v: SwapStatus) => {
        const m = STATUS_META[v] ?? { text: v, color: COLORS.gray }
        return <Tag color={m.color}>{m.text}</Tag>
      },
    },
    {
      title: 'rev',
      key: 'rev',
      width: 70,
      render: (_, r) => <span style={{ color: COLORS.gray }}>{r.base_rev ?? '-'}</span>,
    },
    {
      title: '操作',
      key: 'op',
      width: 190,
      render: (_, r) => {
        if (!canWrite) return <span style={{ color: COLORS.gray }}>只读</span>
        if (r.status === 'pending_peer') {
          return (
            <Space size={4}>
              <Button size="small" type="primary" onClick={() => doAct(r, 'accept')}>
                同意接手
              </Button>
              <Button size="small" danger onClick={() => doReject(r)}>
                驳回
              </Button>
            </Space>
          )
        }
        if (r.status === 'pending_manager') {
          return (
            <Space size={4}>
              <Button size="small" type="primary" onClick={() => doAct(r, 'approve')}>
                店长审批
              </Button>
              <Button size="small" danger onClick={() => doReject(r)}>
                驳回
              </Button>
            </Space>
          )
        }
        if (r.status === 'applied') {
          return (
            <span style={{ color: COLORS.gray }}>
              已写回 {r.write_actions?.length ?? 0} 条待确认
            </span>
          )
        }
        return <span style={{ color: COLORS.gray }}>{r.reject_reason ?? '-'}</span>
      },
    },
  ]

  const doAct = async (r: SwapItem, action: 'accept' | 'approve') => {
    setBusy(true)
    try {
      const res = await actShiftSwap(r.id, action, { rev: r.base_rev ?? undefined })
      if (res.ok) {
        message.success(
          action === 'accept'
            ? '已同意，转店长审批'
            : `审批通过，已写回 ${res.write_actions?.length ?? 0} 条 → 审批中心确认`,
        )
        load()
      } else {
        message.error(res.error || '操作失败')
      }
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const doReject = async (r: SwapItem) => {
    setBusy(true)
    try {
      const res = await actShiftSwap(r.id, 'reject', { reason: '店长驳回' })
      if (res.ok) {
        message.success('已驳回')
        load()
      } else message.error(res.error || '驳回失败')
    } catch {
      message.error('驳回失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      {isMock && <FallbackAlert />}
      <Card
        title="周排班 · 工时汇总"
        extra={
          <Space>
            <DatePicker
              picker="week"
              value={week}
              allowClear={false}
              onChange={(v) => v && setWeek(v)}
            />
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
                发起换班
              </Button>
            </Tooltip>
            <Button size="small" onClick={load}>
              刷新
            </Button>
          </Space>
        }
      >
        <Space size={40} style={{ marginBottom: 12 }}>
          <Statistic title="在岗人数" value={sched?.totals.people ?? 0} />
          <Statistic title="本周总工时" value={sched?.totals.hours ?? 0} suffix="h" />
          <Statistic title="班次人次" value={sched?.totals.shifts ?? 0} />
          {blocked.size > 0 && (
            <Statistic
              title="禁岗人数"
              value={blocked.size}
              valueStyle={{ color: COLORS.red }}
            />
          )}
        </Space>
        <Table<StaffScheduleRow>
          rowKey={(r) => r.staff_id ?? r.staff_name}
          columns={columns}
          dataSource={sched?.staff ?? []}
          loading={loading}
          pagination={false}
          size="small"
          scroll={{ x: 900 }}
        />
      </Card>

      <Card
        title={`换班审批流 · 双确认（${swaps.filter((s) => s.status.startsWith('pending')).length} 待处理）`}
        style={{ marginTop: 16 }}
      >
        <Descriptions size="small" column={3} style={{ marginBottom: 12 }}>
          <Descriptions.Item label="流程">
            A 发起 → B 同意 → 店长审批 → 写回入队
          </Descriptions.Item>
          <Descriptions.Item label="乐观锁">全程带 rev，过期即 409</Descriptions.Item>
          <Descriptions.Item label="写回">
            staff.shift_upsert ×2 → 审批中心确认
          </Descriptions.Item>
        </Descriptions>
        {swaps.length === 0 && !loading ? (
          <Empty description="暂无换班申请" />
        ) : (
          <Table<SwapItem>
            rowKey="id"
            columns={swapColumns}
            dataSource={swaps}
            loading={loading || busy}
            pagination={{ pageSize: 10 }}
            size="small"
          />
        )}
      </Card>

      <Modal
        title="发起换班申请"
        open={open}
        onCancel={() => setOpen(false)}
        confirmLoading={busy}
        destroyOnHidden
        onOk={async () => {
          const v = await form.validateFields()
          setBusy(true)
          try {
            const from = sched?.staff.find(
              (s) => (s.staff_id ?? s.staff_name) === v.from_staff,
            )
            const to = sched?.staff.find((s) => (s.staff_id ?? s.staff_name) === v.to_staff)
            const res = await requestShiftSwap({
              date: v.date.format('YYYY-MM-DD'),
              shift: v.shift,
              from_staff: from?.staff_id ?? v.from_staff,
              from_name: from?.staff_name,
              to_staff: to?.staff_id ?? v.to_staff,
              to_name: to?.staff_name,
              start_time: v.shift === '早班' ? '09:00' : v.shift === '中班' ? '11:00' : '14:00',
              end_time: v.shift === '早班' ? '17:00' : v.shift === '中班' ? '21:00' : '23:00',
              role: from?.role ?? undefined,
              reason: v.reason,
            })
            if (res.ok) {
              message.success('已发起，等待接手人同意')
              setOpen(false)
              load()
            } else message.error(res.error || '发起失败')
          } catch (e: unknown) {
            const err = e as { response?: { data?: { error?: string } } }
            message.error(err.response?.data?.error || '发起失败')
          } finally {
            setBusy(false)
          }
        }}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="from_staff" label="申请人（原值班）" rules={[{ required: true, message: '请选择申请人' }]}>
            <Select options={staffOpts} showSearch placeholder="选择申请人" />
          </Form.Item>
          <Form.Item name="to_staff" label="接手人" rules={[{ required: true, message: '请选择接手人' }]}>
            <AutoComplete
              options={staffOpts}
              placeholder="选择接手人"
              filterOption={(i, o) => String(o?.label ?? '').includes(i)}
            />
          </Form.Item>
          <Form.Item name="date" label="日期" rules={[{ required: true, message: '请选择日期' }]}>
            <DatePicker style={{ width: '100%' }} allowClear={false} />
          </Form.Item>
          <Form.Item name="shift" label="班次" rules={[{ required: true, message: '请选择班次' }]}>
            <Select options={['早班', '中班', '晚班'].map((s) => ({ value: s, label: s }))} />
          </Form.Item>
          <Form.Item name="reason" label="事由">
            <Input.TextArea rows={2} placeholder="如：家中有事" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
