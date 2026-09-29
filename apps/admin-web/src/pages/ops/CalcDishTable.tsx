import { useMemo, useState } from 'react'
import { Card, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { BaobenDishRow, BaobenType } from '../../api/types'

/**
 * 结构测算 · 逐菜结构表（只读）
 * 源：旧版 `renderCalcTable`（HTML:4043-4072）、类型分组统计 `calcTypeStats`（HTML:3915-3922）、
 *     表头排序 `calcSortedIdx`（HTML:4021-4036）。
 * 行集对齐旧版 `syncCalc()`（HTML:3870-3878）：店内上架菜品；成本/售价沿用合并口径
 * （店内为准，缺失回落保本价盘）。勾选（模拟下架）与行内改价/改量属 FP-CALC-11/12，本表不含编辑控件。
 */

/** 旧版类型标签底色（HTML:10、:76-77） */
const TYPE_COLOR: Record<string, string> = {
  引流: '#E8734A',
  爆品: '#D93025',
  利润: '#1E8E5A',
  形象: '#6B4C9A',
  常规: '#3D7EA6',
}

/** 旧版 --ok / --bad（HTML:11） */
const OK = '#1E8E5A'
const BAD = '#D93025'

const fmt = (n?: number | null, d = 2) =>
  n == null || !Number.isFinite(Number(n))
    ? '—'
    : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d })

const pct = (ratio?: number | null, d = 0) =>
  ratio == null || !Number.isFinite(Number(ratio))
    ? '—'
    : `${(Number(ratio) * 100).toFixed(d)}%`

const num = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? 0 : Number(v))
const costOf = (r: BaobenDishRow) => num(r.cost)
const priceOf = (r: BaobenDishRow) => num(r.price)
const qtyOf = (r: BaobenDishRow) => num(r.qty)
const revOf = (r: BaobenDishRow) => priceOf(r) * qtyOf(r)
const gpOf = (r: BaobenDishRow) => (priceOf(r) - costOf(r)) * qtyOf(r)
/** 成本率 / 毛利率：无售价时旧版按 0% 显示（HTML:4056） */
const crOf = (r: BaobenDishRow) => (priceOf(r) ? costOf(r) / priceOf(r) : 0)
const gmOf = (r: BaobenDishRow) => 1 - crOf(r)
/** 排序用哨兵：无售价 成本率 9 / 毛利率 -9（旧版 calcSortedIdx，HTML:4021-4036） */
const crSortOf = (r: BaobenDishRow) => (priceOf(r) ? costOf(r) / priceOf(r) : 9)
const gmSortOf = (r: BaobenDishRow) => (priceOf(r) ? 1 - costOf(r) / priceOf(r) : -9)

type SortKey = 'n' | 't' | 'c' | 'p' | 'cr' | 'gm' | 'q' | 'rev' | 'gp'

const SORT_KEYS: SortKey[] = ['n', 't', 'c', 'p', 'cr', 'gm', 'q', 'rev', 'gp']

interface Row extends BaobenDishRow {
  __key: string
  __group?: boolean
  __label?: string
}

export default function CalcDishTable({
  rows,
  types,
  loading,
}: {
  rows: BaobenDishRow[]
  types: BaobenType[]
  loading?: boolean
}) {
  // 默认按「日营收」降序（旧版 SC_SORT='rev' / SC_SORTDESC=true，HTML:3847）
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'rev', desc: true })

  /** 类型分组统计（旧版 calcTypeStats：营收 Σp·q、成本 Σc·q、成本率按营收加权） */
  const groupStats = useMemo(() => {
    const m: Record<string, { n: number; rev: number; cost: number }> = {}
    for (const r of rows) {
      const k = r.cat || '常规'
      m[k] = m[k] ?? { n: 0, rev: 0, cost: 0 }
      m[k].n += 1
      m[k].rev += revOf(r)
      m[k].cost += costOf(r) * qtyOf(r)
    }
    return m
  }, [rows])

  /** 排序后插分组行（旧版在排序结果上按类型变化处插 grppar 行，HTML:4049-4055） */
  const dataSource = useMemo(() => {
    const val: Record<SortKey, (r: BaobenDishRow) => number> = {
      n: () => 0,
      t: () => 0,
      c: costOf,
      p: priceOf,
      cr: crSortOf,
      gm: gmSortOf,
      q: qtyOf,
      rev: revOf,
      gp: gpOf,
    }
    const list = [...rows].sort((a, b) => {
      if (sort.key === 'n' || sort.key === 't') {
        const va = sort.key === 'n' ? String(a.name ?? '') : String(a.cat ?? '')
        const vb = sort.key === 'n' ? String(b.name ?? '') : String(b.cat ?? '')
        return sort.desc ? vb.localeCompare(va, 'zh') : va.localeCompare(vb, 'zh')
      }
      const f = val[sort.key]
      return sort.desc ? f(b) - f(a) : f(a) - f(b)
    })
    const out: Row[] = []
    let cur: string | null = null
    list.forEach((r, i) => {
      const k = r.cat || '常规'
      if (k !== cur) {
        cur = k
        const s = groupStats[k] ?? { n: 0, rev: 0, cost: 0 }
        out.push({
          __key: `g-${k}-${i}`,
          __group: true,
          name: '',
          cat: k,
          __label: `${types.find((t) => t.k === k)?.name || k} · ${s.n} 道 · 日营收 ${fmt(
            s.rev,
          )} 元 · 成本率 ${pct(
            s.rev ? s.cost / s.rev : 0,
            0,
          )} · 日毛利 ${fmt(s.rev - s.cost)} 元`,
        })
      }
      out.push({ ...r, __key: `r-${k}-${i}` })
    })
    return out
  }, [rows, sort, groupStats, types])

  const orderOf = (k: SortKey) => (sort.key === k ? (sort.desc ? 'descend' : 'ascend') : null)
  /** 分组行：只占首列（colspan=9），其余列隐藏 */
  const cellOf = (r: Row) => ({ colSpan: r.__group ? 0 : 1 })

  const columns: ColumnsType<Row> = [
    {
      key: 'n',
      title: '菜品名称',
      dataIndex: 'name',
      sorter: true,
      sortOrder: orderOf('n'),
      onCell: (r) => ({ colSpan: r.__group ? 9 : 1 }),
      render: (_, r) => (r.__group ? <span>{r.__label}</span> : <b>{r.name}</b>),
    },
    {
      key: 't',
      title: '类型',
      dataIndex: 'cat',
      width: 90,
      sorter: true,
      sortOrder: orderOf('t'),
      onCell: cellOf,
      render: (v: string | null | undefined) => (
        <Tag color={TYPE_COLOR[v ?? ''] ?? 'default'}>{v ?? '常规'}</Tag>
      ),
    },
    {
      key: 'c',
      title: '食材成本',
      width: 100,
      align: 'right',
      sorter: true,
      sortOrder: orderOf('c'),
      onCell: cellOf,
      render: (_, r) => fmt(costOf(r)),
    },
    {
      key: 'p',
      title: '售价',
      width: 90,
      align: 'right',
      sorter: true,
      sortOrder: orderOf('p'),
      onCell: cellOf,
      render: (_, r) => (priceOf(r) ? fmt(priceOf(r)) : '—'),
    },
    {
      key: 'cr',
      title: '成本率',
      width: 90,
      align: 'right',
      sorter: true,
      sortOrder: orderOf('cr'),
      onCell: cellOf,
      render: (_, r) => pct(crOf(r), 0),
    },
    {
      key: 'gm',
      title: '毛利率',
      width: 90,
      align: 'right',
      sorter: true,
      sortOrder: orderOf('gm'),
      onCell: cellOf,
      // 旧版着色阈值：≥60% 绿、≥45% 默认、否则红（HTML:4065）
      render: (_, r) => {
        const gm = gmOf(r)
        return <span style={{ color: gm >= 0.6 ? OK : gm >= 0.45 ? 'inherit' : BAD }}>{pct(gm, 0)}</span>
      },
    },
    {
      key: 'q',
      title: '日销量',
      width: 100,
      align: 'right',
      sorter: true,
      sortOrder: orderOf('q'),
      onCell: cellOf,
      render: (_, r) => `${fmt(qtyOf(r), 0)} 份`,
    },
    {
      key: 'rev',
      title: '日营收',
      width: 110,
      align: 'right',
      sorter: true,
      sortOrder: orderOf('rev'),
      onCell: cellOf,
      render: (_, r) => fmt(revOf(r)),
    },
    {
      key: 'gp',
      title: '日毛利额',
      width: 110,
      align: 'right',
      sorter: true,
      sortOrder: orderOf('gp'),
      onCell: cellOf,
      render: (_, r) => fmt(gpOf(r)),
    },
  ]

  return (
    <Card
      title={`逐菜结构表（${rows.length} 道 · 静态价盘）`}
      size="small"
      loading={loading}
      extra={
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          只读 · 点表头排序
        </Typography.Text>
      }
    >
      <Table<Row>
        size="small"
        rowKey="__key"
        columns={columns}
        dataSource={dataSource}
        pagination={false}
        locale={{ emptyText: '没有匹配的菜品' }}
        scroll={{ x: 880 }}
        rowClassName={(r) => (r.__group ? 'calc-grp-row' : '')}
        onChange={(_p, _f, s) => {
          const raw = Array.isArray(s) ? s[0] : s
          const key = String((raw as { columnKey?: string } | undefined)?.columnKey ?? '')
          if (!SORT_KEYS.includes(key as SortKey)) return
          const k = key as SortKey
          // 旧版：同列再点翻转方向；换列一律从降序开始（HTML:4021-4036）
          setSort((prev) => (prev.key === k ? { key: k, desc: !prev.desc } : { key: k, desc: true }))
        }}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
        成本口径：店内成本估优先、缺失回落保本价盘；日销量为保本价盘估算口径
        （真实销量口径切换见 FP-CALC-08，待补）。
      </Typography.Text>
    </Card>
  )
}
