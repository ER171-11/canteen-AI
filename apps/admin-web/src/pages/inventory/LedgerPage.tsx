import { useEffect, useMemo, useState } from 'react'
import { rk } from '../../utils/rowKey'
import { allValueOf, fromAll, withAll } from '../../utils/filterAll'
import { Card, Empty, Select, Space, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { fetchSnapshot } from '../../api'
import type { IngItem, StockLogItem } from '../../api/types'
import MockAlert from '../kitchen/components/MockAlert'
import { fmtNum, stockValue } from './utils'
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
        setLogs([])
        setIngs([])
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

  // 库存现值：按「当前库存 × 均价」倒序（对齐旧版 renderStock() 的排序与列）
  const stockCur = useMemo(
    () =>
      [...ings].sort(
        (a, b) =>
          (Number(b.stock) || 0) * (Number(b.avg) || 0) -
          (Number(a.stock) || 0) * (Number(a.avg) || 0),
      ),
    [ings],
  )

  const valueColumns: ColumnsType<IngItem> = [
    {
      title: '原料',
      key: 'name',
      render: (_, r) => (
        <>
          {r.name} <span style={{ color: '#999', fontSize: 12 }}>[{r.cat ?? '-'}]</span>
        </>
      ),
    },
    {
      title: '当前库存',
      key: 'stock',
      width: 120,
      align: 'right',
      render: (_, r) => `${fmtNum(r.stock, 2)} ${r.unit ?? ''}`,
    },
    {
      title: '均价',
      key: 'avg',
      width: 100,
      align: 'right',
      render: (_, r) => fmtNum(r.avg),
    },
    {
      title: '库存总值',
      key: 'val',
      width: 120,
      align: 'right',
      render: (_, r) => fmtNum((Number(r.stock) || 0) * (Number(r.avg) || 0)),
    },
  ]

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
        title="库存现值"
        style={{ marginBottom: 16 }}
        extra={
          <span style={{ color: '#888', fontSize: 12 }}>
            {`库存总值：${fmtNum(stockValue(ings))} 元 · 共 ${ings.length} 种原料`}
          </span>
        }
      >
        <Table<IngItem>
          rowKey="id"
          columns={valueColumns}
          dataSource={stockCur}
          loading={loading}
          size="small"
          pagination={false}
          scroll={{ y: 320 }}
          rowClassName={(r) => ((r.stock ?? 0) < (r.safe ?? 0) ? 'ing-neg-row' : '')}
        />
      </Card>
      <Card
        title="库存流水"
        extra={
          <Space>
            {/* 首项固定「全部…」：不筛选=看全部流水，且随时一键退回全部 */}
            <Select
              allowClear
              placeholder="原料"
              style={{ width: 180 }}
              options={withAll(
                ings.map((g) => ({ value: g.id, label: g.name })),
                '全部原料',
              )}
              value={allValueOf(ingFilter)}
              onChange={(v) => setIngFilter(fromAll<string>(v))}
            />
            <Select
              allowClear
              placeholder="类型"
              style={{ width: 140 }}
              options={withAll(
                types.map((t) => ({ value: t, label: t })),
                '全部类型',
              )}
              value={allValueOf(typeFilter)}
              onChange={(v) => setTypeFilter(fromAll<string>(v))}
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
