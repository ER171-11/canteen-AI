import { useMemo, useState } from 'react'
import {
  Button,
  Card,
  Checkbox,
  InputNumber,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { BaobenDishRow, BaobenType, CalcQMode } from '../../api/types'
import { QMODE_OPTIONS, rowOvKey, SIM_BASIS_LABEL, type BulkAction, type CalcSimCtl } from './calcSim'

/**
 * 结构测算 · 逐菜结构表（模拟态可编辑推演）
 * 源：旧版 `renderCalcTable`（HTML:4043-4072）、类型分组统计 `calcTypeStats`（HTML:3915-3922）、
 *     表头排序 `calcSortedIdx`（HTML:4021-4036）、内联编辑（HTML:4260-4311）。
 *
 * 三段职责划分（见 `docs/decisions/ADR-007-结构测算模拟层只读推演.md`）：
 * 1) 行集口径：本店在售菜品（旧版 `syncCalc()` HTML:3870，`basis='shop_dishes'`）；
 * 2) 行值（成本/售价/日销量/上下架）一律上抛 `sim.ctl`，由页面转成 `POST /api/modules/analysis/sim`
 *    的 `rows` 覆盖；本表**不持有第二份公式**（成本率/营收/毛利额全部来自后端回传行）；
 * 3) 纯展示层：排序、类型筛选、分组行。
 * 本表零写库：所有编辑只改内存覆盖，不写菜品主数据、不写配方与库存。
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

const BULK_PRICE: Array<{ act: BulkAction; label: string }> = [
  { act: 'p-10', label: '-10%' },
  { act: 'p-5', label: '-5%' },
  { act: 'p5', label: '+5%' },
  { act: 'p10', label: '+10%' },
]

interface Row extends BaobenDishRow {
  __key: string
  __group?: boolean
  __label?: string
}

export default function CalcDishTable({
  rows,
  types,
  loading,
  sim,
}: {
  rows: BaobenDishRow[]
  types: BaobenType[]
  loading?: boolean
  sim: CalcSimCtl
}) {
  // 默认按「日营收」降序（旧版 SC_SORT='rev' / SC_SORTDESC=true，HTML:3847）
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'rev', desc: true })
  // 类型筛选（旧版 SC_FILTER='全部'，HTML:3847 / calcTabs HTML:4038-4042）
  const [filter, setFilter] = useState<string>('全部')
  // 批量动作作用域（旧版 #bulkScope 默认 __all，HTML:396）
  const [bulkScope, setBulkScope] = useState<string>('__all')

  const active = sim.active
  const lock = active && !!sim.busy

  const setNum = (r: BaobenDishRow, field: 'c' | 'p' | 'q', v: number | null) => {
    const key = rowOvKey(r)
    if (v == null || !Number.isFinite(v) || v < 0) {
      // 非法输入：清掉该字段覆盖（保留同键其它字段）
      const prev = { ...(sim.overrides[key] ?? {}) }
      delete prev[field]
      sim.onOverride(key, Object.keys(prev).length ? prev : null)
      return
    }
    sim.onOverride(key, { ...(sim.overrides[key] ?? {}), [field]: v })
  }

  const hasOv = (r: BaobenDishRow) => !!sim.overrides[rowOvKey(r)]

  /** 排序 + 类型筛选后插分组行（旧版 `calcSortedIdx` + `renderCalcTable`，HTML:4021-4055） */
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
    const scoped = filter === '全部' ? rows : rows.filter((r) => (r.cat || '常规') === filter)
    const list = [...scoped].sort((a, b) => {
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
        // 分组行统计口径：旧版按「在售」菜统计（HTML:4047 `calcTypeStats(SD.filter(d=>d.on))`）
        const on = rows.filter((x) => (x.cat || '常规') === k && x.on !== false)
        const s = on.reduce(
          (a, x) => ({ n: a.n + 1, rev: a.rev + revOf(x), cost: a.cost + costOf(x) * qtyOf(x) }),
          { n: 0, rev: 0, cost: 0 },
        )
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
  }, [rows, sort, filter, types])

  const orderOf = (k: SortKey) => (sort.key === k ? (sort.desc ? 'descend' : 'ascend') : null)
  /** 分组行：占满 11 列（勾选+菜名+类型+成本+售价+成本率+毛利率+销量+营收+毛利+操作） */
  const cellOf = (r: Row) => ({ colSpan: r.__group ? 0 : 1 })

  /** 行内数字输入（成本/售价/日销量），步长逐字照抄旧版（HTML:4062-4066） */
  const numEditor = (field: 'c' | 'p' | 'q', step: number, r: BaobenDishRow, cur: number) => (
    <InputNumber
      size="small"
      controls={false}
      min={0}
      step={step}
      disabled={!active || lock}
      style={{ width: '100%' }}
      value={cur}
      onChange={(v) => setNum(r, field, v as number | null)}
    />
  )

  const columns: ColumnsType<Row> = [
    {
      key: 'on',
      title: '上架',
      width: 48,
      align: 'center',
      onCell: cellOf,
      render: (_, r) => (
        <Tooltip title={active ? '取消勾选即模拟「下架该菜」，用于测试精简菜单(SKU)对保本点的影响' : '进入模拟态后可调整'}>
          <Checkbox
            disabled={!active || lock}
            checked={r.on !== false}
            onChange={(e) => sim.onOverride(rowOvKey(r), { on: e.target.checked })}
          />
        </Tooltip>
      ),
    },
    {
      key: 'n',
      title: '菜品名称',
      dataIndex: 'name',
      sorter: true,
      sortOrder: orderOf('n'),
      onCell: (r) => ({ colSpan: r.__group ? 10 : 1 }),
      render: (_, r) =>
        r.__group ? (
          <span>{r.__label}</span>
        ) : (
          <Space size={4}>
            <b style={{ textDecoration: r.on === false ? 'line-through' : undefined }}>{r.name}</b>
            {r.on === false && <Tag color="default">已下架</Tag>}
            {hasOv(r) && <Tag color="gold">已改</Tag>}
          </Space>
        ),
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
      width: 104,
      align: 'right',
      sorter: true,
      sortOrder: orderOf('c'),
      onCell: cellOf,
      render: (_, r) => (r.__group ? null : numEditor('c', 0.5, r, costOf(r))),
    },
    {
      key: 'p',
      title: '售价',
      width: 96,
      align: 'right',
      sorter: true,
      sortOrder: orderOf('p'),
      onCell: cellOf,
      render: (_, r) => (r.__group ? null : numEditor('p', 1, r, priceOf(r))),
    },
    {
      key: 'cr',
      title: '成本率',
      width: 84,
      align: 'right',
      sorter: true,
      sortOrder: orderOf('cr'),
      onCell: cellOf,
      render: (_, r) => pct(crOf(r), 0),
    },
    {
      key: 'gm',
      title: '毛利率',
      width: 84,
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
      // 旧版表头随口径改名（HTML:4046 `日销量·近N天均`）
      title: active && sim.qmode !== 'est' ? `日销量·近${sim.qdays ?? 30}天均` : '日销量',
      width: 112,
      align: 'right',
      sorter: true,
      sortOrder: orderOf('q'),
      onCell: cellOf,
      render: (_, r) =>
        r.__group ? null : (
          <Tooltip
            title={
              sim.qmode === 'est'
                ? '估算值（菜品主数据 q）'
                : r.src === 'real'
                  ? `近 ${sim.qdays ?? 30} 天共 ${fmt(r.sq, 2)} 份 · 日均 ${fmt(qtyOf(r), 2)} 份`
                  : `估算值（近 ${sim.qdays ?? 30} 天无销量${sim.qfallback ? '，已回落估算' : '，兜底关闭按 0 计'}）`
            }
          >
            {numEditor('q', 0.1, r, qtyOf(r))}
          </Tooltip>
        ),
    },
    {
      key: 'rev',
      title: '日营收',
      width: 104,
      align: 'right',
      sorter: true,
      sortOrder: orderOf('rev'),
      onCell: cellOf,
      render: (_, r) => fmt(revOf(r)),
    },
    {
      key: 'gp',
      title: '日毛利额',
      width: 104,
      align: 'right',
      sorter: true,
      sortOrder: orderOf('gp'),
      onCell: cellOf,
      render: (_, r) => fmt(gpOf(r)),
    },
    {
      key: 'op',
      title: '操作',
      width: 68,
      align: 'center',
      onCell: cellOf,
      render: (_, r) =>
        r.__group ? null : (
          <Button
            size="small"
            type="link"
            disabled={!active || lock || !hasOv(r)}
            onClick={() => sim.onOverride(rowOvKey(r), null)}
          >
            重置
          </Button>
        ),
    },
  ]

  const qlabel = sim.qmodeLabel || QMODE_OPTIONS.find((o) => o.value === sim.qmode)?.label || ''
  const qs = sim.qstat
  const typeChips: Array<{ k: string; name: string; n: number }> = [
    { k: '全部', name: '全部', n: rows.length },
    ...types
      .filter((t) => t.k)
      .map((t) => ({
        k: String(t.k),
        name: String(t.name || t.k),
        n: rows.filter((r) => (r.cat || '常规') === t.k).length,
      })),
  ]

  return (
    <Card
      size="small"
      loading={loading}
      title={
        <Space size={8} wrap>
          <span>{`逐菜结构表（${rows.length} 道）`}</span>
          {active && <Tag color="orange">{SIM_BASIS_LABEL}</Tag>}
        </Space>
      }
      extra={
        <Space size={8} wrap>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            日销量口径
          </Typography.Text>
          <Select<CalcQMode>
            size="small"
            style={{ width: 186 }}
            value={sim.qmode}
            options={QMODE_OPTIONS}
            onChange={(v) => sim.onQmode(v)}
          />
          <Tooltip title="真实口径下该菜近 N 天销量为 0 时，自动回落菜品主数据估算值">
            <Checkbox
              checked={sim.qfallback}
              onChange={(e) => sim.onQfallback(e.target.checked)}
            >
              <span style={{ fontSize: 12 }}>无销量回落估算</span>
            </Checkbox>
          </Tooltip>
          {active ? (
            <Button size="small" onClick={sim.onStop} disabled={!!sim.busy}>
              退出模拟态
            </Button>
          ) : (
            <Button size="small" type="primary" onClick={sim.onStart}>
              进入模拟态
            </Button>
          )}
        </Space>
      }
    >
      <div
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        {typeChips.map((c) => (
          <Tag.CheckableTag
            key={c.k}
            checked={filter === c.k}
            onChange={() => setFilter(c.k)}
          >
            {`${c.name} ${c.n}`}
          </Tag.CheckableTag>
        ))}
        <span style={{ flex: 1 }} />
        <Select
          size="small"
          style={{ width: 128 }}
          value={bulkScope}
          disabled={!active || lock}
          onChange={setBulkScope}
          options={[
            { value: '__all', label: '全部菜品' },
            ...['引流', '爆品', '利润', '形象', '常规'].map((v) => ({ value: v, label: `${v}款` })),
          ]}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          调价
        </Typography.Text>
        {BULK_PRICE.map((b) => (
          <Button
            key={b.act}
            size="small"
            disabled={!active || lock}
            onClick={() => sim.onBulk(bulkScope, b.act)}
          >
            {b.label}
          </Button>
        ))}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          调量
        </Typography.Text>
        <Button size="small" disabled={!active || lock} onClick={() => sim.onBulk(bulkScope, 'q-20')}>
          -20%
        </Button>
        <Button size="small" disabled={!active || lock} onClick={() => sim.onBulk(bulkScope, 'q20')}>
          +20%
        </Button>
        <Button size="small" disabled={!active || lock} onClick={() => sim.onBulk(bulkScope, 'on')}>
          全部上架
        </Button>
        <Button size="small" disabled={!active || lock} onClick={() => sim.onBulk(bulkScope, 'reset')}>
          恢复默认
        </Button>
      </div>

      <Table<Row>
        size="small"
        rowKey="__key"
        columns={columns}
        dataSource={dataSource}
        pagination={false}
        locale={{ emptyText: '没有匹配的菜品' }}
        scroll={{ x: 1080 }}
        rowClassName={(r) => (r.__group ? 'calc-grp-row' : '')}
        onRow={(r) =>
          r.__group || r.on !== false || !active
            ? {}
            : { style: { opacity: 0.5 } }
        }
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
        {active ? (
          <>
            模拟态口径：<b>本店在售菜品</b>（成本/售价取店内菜品主数据，缺失与保本价盘合并补缺）· 日销量口径：
            <b>{qlabel}</b>
            {sim.qmode !== 'est' && qs
              ? `（近 ${sim.qdays ?? 30} 天总销量 ÷ ${sim.qdays ?? 30}） · ${qs.n_total ?? 0} 道中 ${
                  qs.n_real ?? 0
                } 道取真实销量、${qs.n_fallback ?? 0} 道无销量${
                  sim.qfallback ? '回落估算值' : '按 0 计（兜底已关闭）'
                }`
              : '（菜品主数据估算值）'}
            。所有调整仅为模拟测算，<b>不会写回菜品主数据、配方或库存</b>，也不入审批队列。
          </>
        ) : (
          <>
            当前为基线口径，且本页存在<b>一处既有的口径裂缝</b>：上方店级 KPI 走<b>保本价盘整表</b>，
            而本表行集是<b>本店在售菜品</b>——两者口径不同，故本表合计与上方 KPI 本就不相等，这不是本页算错。
            点右上「进入模拟态」后，本表与店级 KPI 会切到<b>同一口径</b>（都取本店在售菜品），数字随之跳变；
            届时食材成本 / 售价 / 日销量三列可直接编辑，取消勾选即模拟「下架该菜」。
          </>
        )}
      </Typography.Text>
    </Card>
  )
}
