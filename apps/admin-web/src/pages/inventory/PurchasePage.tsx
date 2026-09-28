import { useEffect, useMemo, useState } from 'react'
import { rk } from '../../utils/rowKey'
import { Card, Empty, Select, Space, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { Link } from 'react-router-dom'
import { fetchSnapshot } from '../../api'
import type { IngItem, InventoryDoc } from '../../api/types'
import MockAlert from '../kitchen/components/MockAlert'
import { MOCK_ORDERS } from './mock'
import { docDebt, docPaid, formatLinesSummary } from './utils'
import { COLORS } from '../../theme'

export default function PurchasePage() {
  const [docs, setDocs] = useState<InventoryDoc[]>([])
  const [ings, setIngs] = useState<IngItem[]>([])
  const [supplier, setSupplier] = useState<string>()
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [fromSnapshot, setFromSnapshot] = useState(true)

  useEffect(() => {
    fetchSnapshot()
      .then((snap) => {
        setIngs(snap.data?.ings ?? [])
        const orders = snap.data?.orders
        if (Array.isArray(orders)) {
          setDocs(orders)
          setFromSnapshot(true)
          setIsMock(false)
        } else {
          setDocs([])
          setFromSnapshot(true)
        }
      })
      .catch(() => {
        setDocs(MOCK_ORDERS)
        setFromSnapshot(false)
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  const ingName = useMemo(() => {
    const m = new Map(ings.map((g) => [g.id, g.name]))
    return (id: string) => m.get(id) ?? id ?? '?'
  }, [ings])

  const suppliers = useMemo(
    () => [...new Set(docs.map((d) => d.supplier).filter(Boolean))] as string[],
    [docs],
  )

  const filtered = useMemo(
    () =>
      docs
        .filter((d) => !supplier || d.supplier === supplier)
        .sort((a, b) => String(b.date).localeCompare(String(a.date))),
    [docs, supplier],
  )

  const columns: ColumnsType<InventoryDoc> = [
    { title: '单号', dataIndex: 'no', width: 150, render: (v) => v ?? '-' },
    { title: '日期', dataIndex: 'date', width: 110 },
    { title: '供应商', dataIndex: 'supplier', width: 140, ellipsis: true },
    {
      title: '明细',
      key: 'lines',
      ellipsis: true,
      render: (_, r) => formatLinesSummary(r.lines, ingName),
    },
    {
      title: '应付',
      dataIndex: 'payable',
      width: 100,
      align: 'right',
      render: (v) => (v == null ? '-' : `¥${v}`),
    },
    {
      title: '已付',
      key: 'paid',
      width: 100,
      align: 'right',
      render: (_, r) => `¥${docPaid(r)}`,
    },
    {
      title: '欠款',
      key: 'debt',
      width: 90,
      align: 'right',
      render: (_, r) => {
        const d = docDebt(r)
        return d > 0.01 ? <span style={{ color: COLORS.red }}>¥{d}</span> : '—'
      },
    },
    {
      title: '收货进度',
      key: 'recv',
      width: 110,
      render: (_, r) => {
        const lines = r.lines ?? []
        if (!lines.length) return '-'
        const q = lines.reduce((a, l) => a + (Number(l.qty) || 0), 0)
        const g = lines.reduce((a, l) => a + (Number(l.recvQty) || 0), 0)
        const pct = q > 0 ? Math.round((g / q) * 100) : 0
        return (
          <span>
            {g}/{q} · {pct}%
          </span>
        )
      },
    },
    {
      title: '结算',
      key: 'settle',
      width: 90,
      render: (_, r) =>
        docDebt(r) > 0.01 ? (
          <Tag color={COLORS.yellow}>有欠款</Tag>
        ) : (
          <Tag color={COLORS.green}>已结清</Tag>
        ),
    },
  ]

  const empty =
    fromSnapshot && !isMock && docs.length === 0 && !loading

  return (
    <div>
      {isMock && <MockAlert endpoint="/api/snapshot/latest · data.orders" />}
      <Card
        title="采购单（CG）"
        extra={
          <Space>
            <span>共 {filtered.length} 张</span>
            <Select
              allowClear
              placeholder="供应商"
              style={{ width: 160 }}
              options={suppliers.map((s) => ({ value: s, label: s }))}
              value={supplier}
              onChange={setSupplier}
            />
          </Space>
        }
      >
        {empty ? (
          <Empty
            description={
              <span>
                暂无采购单。可先到{' '}
                <Link to="/inventory/restock">补货建议</Link> 生成草稿，或由店内下单后同步到快照。
              </span>
            }
          />
        ) : (
          <Table<InventoryDoc>
            rowKey={rk}
            columns={columns}
            dataSource={filtered}
            loading={loading}
            pagination={{ pageSize: 15 }}
          />
        )}
      </Card>
    </div>
  )
}
