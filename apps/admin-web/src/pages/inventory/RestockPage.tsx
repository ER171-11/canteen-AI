import { useEffect, useState } from 'react'
import { Alert, Button, Card, message, Space, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { Link } from 'react-router-dom'
import { fetchRestockSuggest, fetchSnapshot, postAction } from '../../api'
import type { IngItem } from '../../api/types'
import { useAuthStore } from '../../store/auth'
import MockAlert from '../kitchen/components/MockAlert'
import { MOCK_INGS } from './mock'
import { safetyLine, stockStatus, suggestRestockQty } from './utils'
import { COLORS } from '../../theme'

interface RestockRow extends IngItem {
  suggestQty: number
  safety: number
  reason?: string
  urgency?: string
}

const URGENCY_TAG: Record<string, { color: string; text: string }> = {
  critical: { color: COLORS.red, text: '告急' },
  low: { color: COLORS.yellow, text: '偏低' },
  watch: { color: 'default', text: '关注' },
}

export default function RestockPage() {
  const role = useAuthStore((s) => s.role)
  const account = useAuthStore((s) => s.account)
  const canWrite = useAuthStore((s) => s.canWrite)
  const [rows, setRows] = useState<RestockRow[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [isMock, setIsMock] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  /** 本地兜底算法（服务端端点不可用/无快照时用） */
  const localRows = (items: IngItem[]): RestockRow[] =>
    items
      .filter((g) => g.on !== false)
      .map((g) => ({
        ...g,
        safety: safetyLine(g),
        suggestQty: suggestRestockQty(g),
      }))
      .filter((g) => g.suggestQty > 0)
      .sort((a, b) => b.suggestQty - a.suggestQty)

  useEffect(() => {
    /* 优先服务端 /api/inventory/restock-suggest（est/plans 口径），失败回退本地安全线算法 */
    fetchRestockSuggest()
      .then((resp) => {
        if (resp.ok && !resp.mock && Array.isArray(resp.items) && resp.items.length > 0) {
          setRows(
            resp.items
              .map((it) => ({
                id: it.ingredientId,
                name: it.name ?? it.ingredientId,
                unit: it.unit,
                stock: it.qty,
                safety: it.safe ?? 0,
                suggestQty: it.suggestQty ?? 0,
                reason: it.reason,
                urgency: it.urgency,
              }))
              .filter((r) => r.suggestQty > 0),
          )
          setBanner(null)
        } else {
          setBanner(resp.banner || '服务端暂无补货建议，已回退本地安全线算法')
          return fetchSnapshot().then((snap) => setRows(localRows(snap.data?.ings ?? [])))
        }
        setIsMock(false)
        return undefined
      })
      .catch(() => {
        fetchSnapshot()
          .then((snap) => {
            setRows(localRows(snap.data?.ings ?? []))
            setBanner('服务端补货端点不可用，已回退本地安全线算法')
          })
          .catch(() => {
            setRows(localRows(MOCK_INGS))
            setIsMock(true)
          })
      })
      .finally(() => setLoading(false))
  }, [])

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
      render: (v) => v || '-',
    },
    {
      title: '状态',
      key: 'st',
      width: 80,
      render: (_, r) => {
        if (r.urgency) {
          const t = URGENCY_TAG[r.urgency] ?? URGENCY_TAG.watch
          return <Tag color={t.color}>{t.text}</Tag>
        }
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
    {
      title: '依据',
      dataIndex: 'reason',
      ellipsis: true,
      render: (v) => v ?? '-',
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
      {isMock && <MockAlert endpoint="/api/inventory/restock-suggest" />}
      {banner && !isMock && (
        <Alert type="info" showIcon style={{ marginBottom: 16 }} message={banner} />
      )}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="只读建议：优先服务端 est/plans 口径，端点不可用时回退本地安全线计算；提交后进入 actions 队列，由审批中心 confirm/execute，不会直连店内 8765。"
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
              disabled={!rows.length || !canWrite}
              title={canWrite ? undefined : '当前角色无写权限，仅可查看'}
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
