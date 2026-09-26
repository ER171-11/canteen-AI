import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Card,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Button,
  Tooltip,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  fetchActions,
  confirmAction,
  rejectAction,
  fetchActionStatus,
  fetchSnapshot,
} from '../api'
import type { ActionItem, ActionStatus } from '../api/types'
import { useAuthStore } from '../store/auth'
import { COLORS } from '../theme'

/** 审批四态标签（兼容英文枚举与 BFF 中文状态） */
const STATUS_TAG: Record<string, { color: string; text: string }> = {
  pending: { color: COLORS.yellow, text: '排队中' },
  queued: { color: COLORS.yellow, text: '排队中' },
  confirmed: { color: COLORS.green, text: '待执行' },
  rejected: { color: COLORS.red, text: '已驳回' },
  done: { color: COLORS.purple, text: '已执行' },
  排队中: { color: COLORS.yellow, text: '排队中' },
  queued_cn: { color: COLORS.yellow, text: '排队中' },
  待执行: { color: COLORS.green, text: '待执行' },
  已驳回: { color: COLORS.red, text: '已驳回' },
  已执行: { color: COLORS.purple, text: '已执行' },
  已过期: { color: 'default', text: '已过期' },
}

const OPEN = new Set(['queued', '排队中', 'pending'])
/** 终态：轮询到此为止 */
const TERMINAL = new Set(['已执行', '已驳回', '已过期', 'done', 'rejected', 'expired'])

/** 轮询已确认单直到终态（消费器异步落库），最长约 20s */
async function pollUntilTerminal(id: string): Promise<string> {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      const s = await fetchActionStatus(id)
      const st = String(s.status ?? '')
      if (TERMINAL.has(st)) return st
    } catch {
      /* 网络抖动继续等 */
    }
  }
  return ''
}

export default function ActionsPage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const noWriteTip = '当前角色无写权限，仅可查看'
  const [items, setItems] = useState<ActionItem[]>([])
  const [status, setStatus] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [offline, setOffline] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)
  const [selected, setSelected] = useState<React.Key[]>([])
  const [rejectReason, setRejectReason] = useState('')

  const load = useCallback((s?: string) => {
    setLoading(true)
    fetchActions(s as ActionStatus | undefined)
      .then((list) => {
        setItems(list)
        setOffline(false)
      })
      .catch(() => {
        setItems([])
        setOffline(true)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load(status)
  }, [status, load])

  const doConfirm = async (row: ActionItem) => {
    const snap = await fetchSnapshot().catch(() => null)
    const rev = snap?.rev != null ? String(snap.rev) : undefined
    await confirmAction(row.id, { operator: 'admin', rev })
    /* 已确认（待执行）后轮询执行结果直至终态 */
    const final = await pollUntilTerminal(row.id)
    return final
  }

  const onConfirm = async (row: ActionItem) => {
    setBusyId(row.id)
    try {
      const final = await doConfirm(row)
      message.success(final ? `已执行完成 ${row.id}（${final}）` : `已通过 ${row.id}，等待消费器执行`)
      load(status)
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : '确认失败')
    } finally {
      setBusyId(null)
    }
  }

  const onReject = async (row: ActionItem, reason: string) => {
    setBusyId(row.id)
    try {
      await rejectAction(row.id, { reason: reason.trim() || '管理端驳回' })
      message.success(`已驳回 ${row.id}`)
      load(status)
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : '驳回失败')
    } finally {
      setBusyId(null)
    }
  }

  const openRows = items.filter((r) => OPEN.has(String(r.status)))
  const selectedRows = openRows.filter((r) => selected.includes(r.id))

  const onBatch = async (kind: 'confirm' | 'reject') => {
    if (!selectedRows.length) return
    setBatchBusy(true)
    let ok = 0
    let fail = 0
    for (const row of selectedRows) {
      try {
        if (kind === 'confirm') {
          await doConfirm(row)
        } else {
          await rejectAction(row.id, { reason: rejectReason.trim() || '管理端批量驳回' })
        }
        ok++
      } catch {
        fail++
      }
    }
    message[fail ? 'warning' : 'success'](
      `批量${kind === 'confirm' ? '通过' : '驳回'}：成功 ${ok} 条${fail ? `，失败 ${fail} 条` : ''}`,
    )
    setSelected([])
    setRejectReason('')
    setBatchBusy(false)
    load(status)
  }

  const columns: ColumnsType<ActionItem> = [
    { title: 'ID', dataIndex: 'id', width: 140, ellipsis: true },
    { title: '类型', dataIndex: 'type', width: 140 },
    {
      title: '标题',
      dataIndex: 'title',
      render: (v: string | undefined, r) =>
        v ?? (r.payload ? `${r.type} ${JSON.stringify(r.payload)}` : r.type),
      ellipsis: true,
    },
    {
      title: '发起人',
      dataIndex: 'initiator',
      width: 100,
      render: (v: string | undefined, r) => v ?? r.operator ?? '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string) => {
        const tag = STATUS_TAG[s] ?? { color: 'default', text: s }
        return <Tag color={tag.color}>{tag.text}</Tag>
      },
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      width: 180,
      render: (v) => (v ? new Date(v).toLocaleString('zh-CN') : '-'),
    },
    {
      title: '操作',
      key: 'op',
      width: 180,
      render: (_, row) => {
        const open = OPEN.has(String(row.status))
        return (
          <Space>
            <Tooltip title={canWrite ? undefined : noWriteTip}>
              <Button
                size="small"
                type="primary"
                disabled={!open || !canWrite || busyId === row.id || batchBusy}
                loading={busyId === row.id}
                onClick={() => onConfirm(row)}
              >
                通过
              </Button>
            </Tooltip>
            <Tooltip title={canWrite ? undefined : noWriteTip}>
              <span>
                <Popconfirm
                  title="驳回该申请"
                  description={
                    <Input.TextArea
                      rows={2}
                      style={{ width: 240 }}
                      placeholder="驳回原因（可选，默认：管理端驳回）"
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                    />
                  }
                  okText="确认驳回"
                  cancelText="取消"
                  onConfirm={() => {
                    onReject(row, rejectReason)
                    setRejectReason('')
                  }}
                  onCancel={() => setRejectReason('')}
                  disabled={!open || !canWrite || busyId === row.id}
                >
                  <Button
                    size="small"
                    danger
                    disabled={!open || !canWrite || busyId === row.id || batchBusy}
                    loading={busyId === row.id}
                  >
                    驳回
                  </Button>
                </Popconfirm>
              </span>
            </Tooltip>
          </Space>
        )
      },
    },
  ]

  return (
    <Card
      title="审批中心（动作队列）"
      extra={
        <Select
          allowClear
          placeholder="按状态筛选"
          style={{ width: 140 }}
          value={status}
          onChange={(v) => setStatus(v)}
          options={[
            { value: 'queued', label: '排队中' },
            { value: '待执行', label: '待执行' },
            { value: '已执行', label: '已执行' },
            { value: '已驳回', label: '已驳回' },
            { value: '已过期', label: '已过期' },
          ]}
        />
      }
    >
      {offline && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="BFF 未连接（/api/actions 不可用），暂无数据。"
        />
      )}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="与原生 App 共用 /api/actions：老板手机拍板入队后此处同源可见。「通过」queued→待执行（需匹配快照 rev），由 queue_consumer 落库；「驳回」直接关闭。配置变更同样经此队列。"
      />
      {canWrite && (
        <Space style={{ marginBottom: 12 }} wrap>
          <Popconfirm
            title={`批量通过 ${selectedRows.length} 条申请？`}
            okText="通过"
            cancelText="取消"
            disabled={!selectedRows.length || batchBusy}
            onConfirm={() => onBatch('confirm')}
          >
            <Button type="primary" disabled={!selectedRows.length} loading={batchBusy}>
              批量通过{selectedRows.length ? `（${selectedRows.length}）` : ''}
            </Button>
          </Popconfirm>
          <Popconfirm
            title={`批量驳回 ${selectedRows.length} 条申请？`}
            description={
              <Input.TextArea
                rows={2}
                style={{ width: 240 }}
                placeholder="驳回原因（可选，默认：管理端批量驳回）"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
              />
            }
            okText="确认驳回"
            cancelText="取消"
            disabled={!selectedRows.length || batchBusy}
            onConfirm={() => onBatch('reject')}
          >
            <Button danger disabled={!selectedRows.length} loading={batchBusy}>
              批量驳回{selectedRows.length ? `（${selectedRows.length}）` : ''}
            </Button>
          </Popconfirm>
        </Space>
      )}
      <Table<ActionItem>
        rowKey="id"
        columns={columns}
        dataSource={items}
        loading={loading}
        rowSelection={
          canWrite
            ? {
                selectedRowKeys: selected,
                onChange: (keys) => setSelected(keys),
                getCheckboxProps: (r) => ({ disabled: !OPEN.has(String(r.status)) }),
              }
            : undefined
        }
        pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
      />
    </Card>
  )
}
