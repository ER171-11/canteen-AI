import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Card,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Button,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { fetchActions } from '../api'
import type { ActionItem, ActionStatus } from '../api/types'
import { COLORS } from '../theme'

/** 审批四态标签（兼容英文枚举与 BFF 实际下发的中文状态） */
const STATUS_TAG: Record<string, { color: string; text: string }> = {
  pending: { color: COLORS.yellow, text: '待审批' },
  confirmed: { color: COLORS.green, text: '已通过' },
  rejected: { color: COLORS.red, text: '已驳回' },
  done: { color: COLORS.purple, text: '已执行' },
  待审批: { color: COLORS.yellow, text: '待审批' },
  已通过: { color: COLORS.green, text: '已通过' },
  已驳回: { color: COLORS.red, text: '已驳回' },
  已执行: { color: COLORS.purple, text: '已执行' },
}

export default function ActionsPage() {
  const [items, setItems] = useState<ActionItem[]>([])
  const [status, setStatus] = useState<ActionStatus | undefined>()
  const [loading, setLoading] = useState(false)
  const [offline, setOffline] = useState(false)

  const load = useCallback((s?: ActionStatus) => {
    setLoading(true)
    fetchActions(s)
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

  const columns: ColumnsType<ActionItem> = [
    { title: 'ID', dataIndex: 'id', width: 140, ellipsis: true },
    { title: '类型', dataIndex: 'type', width: 120 },
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
      render: () => (
        /*
         * 红线：所有写操作必须走 actions 队列由审批中心执行。
         * Sprint 0-2 阶段审批写入口未上线，按钮统一置灰。
         */
        <Space>
          <Tooltip title="待审批中心上线">
            <Button size="small" disabled>
              通过
            </Button>
          </Tooltip>
          <Tooltip title="待审批中心上线">
            <Button size="small" danger disabled>
              驳回
            </Button>
          </Tooltip>
        </Space>
      ),
    },
  ]

  return (
    <Card
      title="审批中心（只读）"
      extra={
        <Select
          allowClear
          placeholder="按状态筛选"
          style={{ width: 140 }}
          value={status}
          onChange={(v) => setStatus(v)}
          options={(['pending', 'confirmed', 'rejected', 'done'] as ActionStatus[]).map(
            (s) => ({
              value: s,
              label: STATUS_TAG[s].text,
            }),
          )}
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
