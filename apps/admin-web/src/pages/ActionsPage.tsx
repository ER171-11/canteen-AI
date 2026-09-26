import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Card,
  Select,
  Space,
  Table,
  Tag,
  Button,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { fetchActions, confirmAction, rejectAction } from '../api'
import type { ActionItem, ActionStatus } from '../api/types'
import { COLORS } from '../theme'
import { fetchSnapshot } from '../api'

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

const OPEN = new Set(['queued', '排队中', '待执行', 'pending', 'confirmed'])

export default function ActionsPage() {
  const [items, setItems] = useState<ActionItem[]>([])
  const [status, setStatus] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [offline, setOffline] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

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

  const onConfirm = async (row: ActionItem) => {
    setBusyId(row.id)
    try {
      const snap = await fetchSnapshot().catch(() => null)
      const rev = snap?.rev != null ? String(snap.rev) : undefined
      await confirmAction(row.id, { operator: 'admin', rev })
      message.success(`已通过 ${row.id}`)
      load(status)
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : '确认失败')
    } finally {
      setBusyId(null)
    }
  }

  const onReject = async (row: ActionItem) => {
    setBusyId(row.id)
    try {
      await rejectAction(row.id, { reason: '管理端驳回' })
      message.success(`已驳回 ${row.id}`)
      load(status)
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : '驳回失败')
    } finally {
      setBusyId(null)
    }
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
            <Button
              size="small"
              type="primary"
              disabled={!open || busyId === row.id || row.status === '待执行'}
              loading={busyId === row.id}
              onClick={() => onConfirm(row)}
            >
              通过
            </Button>
            <Button
              size="small"
              danger
              disabled={!open || busyId === row.id}
              loading={busyId === row.id}
              onClick={() => onReject(row)}
            >
              驳回
            </Button>
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
      <Table<ActionItem>
        rowKey="id"
        columns={columns}
        dataSource={items}
        loading={loading}
        pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
      />
    </Card>
  )
}
