import { useEffect, useMemo, useState } from 'react'
import { Card, Empty, Select, Space, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { fetchSnapshot } from '../../api'
import type { IngItem, InventoryDoc } from '../../api/types'
import MockAlert from '../kitchen/components/MockAlert'
import { MOCK_RECV } from './mock'
import { docDebt, docPaid, formatLinesSummary } from './utils'
import { COLORS } from '../../theme'

function asDoc(r: unknown): InventoryDoc | null {
  if (!r || typeof r !== 'object') return null
  const d = r as InventoryDoc
  if (d.no || d.supplier || d.lines) return d
  return null
}

export default function InboundPage() {
  const [docs, setDocs] = useState<InventoryDoc[]>([])
  const [ings, setIngs] = useState<IngItem[]>([])
  const [supplier, setSupplier] = useState<string>()
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchSnapshot()
      .then((snap) => {
        setIngs(snap.data?.ings ?? [])
        const raw = snap.data?.recv ?? []
        const list = raw.map(asDoc).filter(Boolean) as InventoryDoc[]
        setDocs(list)
      })
      .catch(() => {
        setDocs(MOCK_RECV)
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
      title: '实付',
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
    {
      title: '备注',
      dataIndex: 'note',
      width: 120,
      ellipsis: true,
      render: (v) => v ?? '-',
    },
  ]

  return (
    <div>
      {isMock && <MockAlert endpoint="/api/snapshot/latest · data.recv" />}
      <Card
        title="进货入库（JH 进货单）"
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
        {filtered.length === 0 && !loading ? (
          <Empty description="暂无进货单，货到了请在店内系统或后续审批流新建 JH 进货单" />
        ) : (
          <Table<InventoryDoc>
            rowKey={(r, i) => String(r.id ?? r.no ?? i)}
            columns={columns}
            dataSource={filtered}
            loading={loading}
            pagination={{ pageSize: 15 }}
            rowClassName={(r) => (docDebt(r) > 0.01 ? 'ant-table-row-warning' : '')}
          />
        )}
      </Card>
    </div>
  )
}
