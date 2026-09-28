import { useEffect, useMemo, useState } from 'react'
import { rk } from '../../utils/rowKey'
import { Card, Empty, Select, Space, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { fetchSnapshot } from '../../api'
import type { IngItem, StockLogItem } from '../../api/types'
import MockAlert from '../kitchen/components/MockAlert'
import { MOCK_LOGS } from './mock'
import { COLORS } from '../../theme'

const TYPE_COLOR: Record<string, string> = {
  期初: 'default',
  采购入库: COLORS.green,
  销售出库: 'orange',
  盘点调整: 'blue',
  手工调整: COLORS.purple,
}

export default function LedgerPage() {
  const [logs, setLogs] = useState<StockLogItem[]>([])
  const [ings, setIngs] = useState<IngItem[]>([])
  const [ingFilter, setIngFilter] = useState<string>()
  const [typeFilter, setTypeFilter] = useState<string>()
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchSnapshot()
      .then((snap) => {
        setIngs(snap.data?.ings ?? [])
        const raw = snap.data?.logs
        if (Array.isArray(raw) && raw.length > 0) setLogs(raw)
        else setLogs([])
      })
      .catch(() => {
        setLogs(MOCK_LOGS)
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  const ingName = useMemo(() => {
    const m = new Map(ings.map((g) => [g.id, g.name]))
    return (id?: string) => (id ? m.get(id) ?? id : '(未知)')
  }, [ings])

  const types = useMemo(
    () => [...new Set(logs.map((l) => l.type).filter(Boolean))] as string[],
    [logs],
  )

  const filtered = useMemo(() => {
    let list = [...logs]
    if (ingFilter) list = list.filter((l) => l.ing === ingFilter)
    if (typeFilter) list = list.filter((l) => l.type === typeFilter)
    return list.sort((a, b) => {
      const sa = String(b.date ?? b.t ?? b.seq)
      const sb = String(a.date ?? a.t ?? a.seq)
      return sa.localeCompare(sb)
    })
  }, [logs, ingFilter, typeFilter])

  const columns: ColumnsType<StockLogItem> = [
    { title: '日期', dataIndex: 'date', width: 110, render: (v, r) => v ?? r.t ?? '-' },
    {
      title: '原料',
      key: 'ing',
      width: 140,
      render: (_, r) => ingName(r.ing),
    },
    {
      title: '类型',
      dataIndex: 'type',
      width: 110,
      render: (v: string | undefined) => (
        <Tag color={TYPE_COLOR[v ?? ''] ?? 'default'}>{v ?? '-'}</Tag>
      ),
    },
    {
      title: '数量',
      dataIndex: 'qty',
      width: 100,
      align: 'right',
      render: (v: number | undefined) => {
        const n = v ?? 0
        const sign = n > 0 ? '+' : ''
        return (
          <span style={{ color: n < 0 ? COLORS.red : COLORS.green }}>
            {sign}
            {n}
          </span>
        )
      },
    },
    {
      title: '结存',
      dataIndex: 'bal',
      width: 90,
      align: 'right',
      render: (v) => (v == null ? '-' : v),
    },
    { title: '参考', dataIndex: 'ref', ellipsis: true, render: (v) => v ?? '-' },
  ]

  const empty = !loading && filtered.length === 0 && !isMock

  return (
    <div>
      {isMock && <MockAlert endpoint="/api/snapshot/latest · data.logs" />}
      <Card
        title="库存流水"
        extra={
          <Space>
            <Select
              allowClear
              placeholder="原料"
              style={{ width: 180 }}
              options={ings.map((g) => ({ value: g.id, label: g.name }))}
              value={ingFilter}
              onChange={setIngFilter}
            />
            <Select
              allowClear
              placeholder="类型"
              style={{ width: 140 }}
              options={types.map((t) => ({ value: t, label: t }))}
              value={typeFilter}
              onChange={setTypeFilter}
            />
          </Space>
        }
      >
        {empty ? (
          <Empty description="暂无库存流水。流水由进货单、销售与盘点重放生成" />
        ) : (
          <Table<StockLogItem>
            rowKey={rk}
            columns={columns}
            dataSource={filtered.slice(0, 400)}
            loading={loading}
            pagination={{ pageSize: 25, showTotal: (t) => `展示 ${t} 条（最多 400）` }}
          />
        )}
      </Card>
    </div>
  )
}
