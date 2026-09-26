import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, message, Space, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { Link } from 'react-router-dom'
import { fetchSnapshot, postAction } from '../../api'
import type { IngItem } from '../../api/types'
import { useAuthStore } from '../../store/auth'
import MockAlert from '../kitchen/components/MockAlert'
import { MOCK_INGS } from './mock'
import { safetyLine, stockStatus, suggestRestockQty } from './utils'
import { COLORS } from '../../theme'

interface RestockRow extends IngItem {
  suggestQty: number
  safety: number
}

export default function RestockPage() {
  const role = useAuthStore((s) => s.role)
  const account = useAuthStore((s) => s.account)
  const [items, setItems] = useState<IngItem[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    fetchSnapshot()
      .then((snap) => setItems(snap.data?.ings ?? []))
      .catch(() => {
        setItems(MOCK_INGS)
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  const rows: RestockRow[] = useMemo(() => {
    return items
      .filter((g) => g.on !== false)
      .map((g) => ({
        ...g,
        safety: safetyLine(g),
        suggestQty: suggestRestockQty(g),
      }))
      .filter((g) => g.suggestQty > 0)
      .sort((a, b) => b.suggestQty - a.suggestQty)
  }, [items])

  useEffect(() => {
    setSelected(rows.map((r) => r.id))
  }, [rows])

  const columns: ColumnsType<RestockRow> = [
    { title: '原料', dataIndex: 'name' },
    { title: '分类', dataIndex: 'cat', width: 100, render: (v) => v ?? '-' },
    {
      title: '当前库存',
      key: 'stock',
      width: 110,
      align: 'right',
      render: (_, r) => `${r.stock ?? 0} ${r.unit ?? ''}`,
    },
    {
      title: '安全线',
      dataIndex: 'safety',
      width: 90,
      align: 'right',
    },
    {
      title: '状态',
      key: 'st',
      width: 80,
      render: (_, r) => {
        const s = stockStatus(r)
        return <Tag color={s.color}>{s.text}</Tag>
      },
    },
    {
      title: '建议补货量',
      dataIndex: 'suggestQty',
      width: 120,
      align: 'right',
      render: (v, r) => `${v} ${r.unit ?? ''}`,
    },
  ]

  const onSubmit = async () => {
    const picked = rows.filter((r) => selected.includes(r.id))
    if (!picked.length) {
      message.warning('没有需要提交的补货项')
      return
    }
    setSubmitting(true)
    try {
      const res = await postAction({
        type: 'stock.replenish',
        operator: role ?? account ?? '管理员',
        payload: {
          source: 'admin-web/inventory/restock',
          items: picked.map((r) => ({
            ing_id: r.id,
            name: r.name,
            qty: r.suggestQty,
            unit: r.unit,
            safety: r.safety,
            stock: r.stock,
          })),
        },
      })
      message.success(
        res.dedup
          ? `已入队（幂等）：${res.id}，请到审批中心确认`
          : `补货确认已入队：${res.id}，请到审批中心确认执行`,
      )
    } catch {
      message.error('提交失败，请检查 BFF 与登录态')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      {isMock && <MockAlert endpoint="/api/snapshot/latest · data.ings" />}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="只读建议：按安全库存线计算缺口；提交后进入 actions 队列，由审批中心 confirm/execute，不会直连店内 8765。"
        action={
          <Link to="/platform/actions">审批中心</Link>
        }
      />
      <Card
        title="补货建议"
        extra={
          <Space>
            <span>{rows.length} 项需补货</span>
            <Button
              type="primary"
              loading={submitting}
              disabled={!rows.length}
              onClick={onSubmit}
            >
              提交补货确认
            </Button>
          </Space>
        }
      >
        <Table<RestockRow>
          rowKey="id"
          columns={columns}
          dataSource={rows}
          loading={loading}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: (keys) => setSelected(keys as string[]),
          }}
          pagination={{ pageSize: 20 }}
          locale={{
            emptyText: (
              <span style={{ color: COLORS.green }}>当前库存均高于安全线，无需补货</span>
            ),
          }}
        />
      </Card>
    </div>
  )
}
