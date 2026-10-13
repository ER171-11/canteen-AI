import { Descriptions, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { CostCard, CostCardLine, RecipeItem } from '../../../api/types'
import { COLORS } from '../../../theme'

/*
 * 标准配方卡（对齐《金丰菜品标准卡 standard receipe card》）：
 *   表头 = 菜品名称 / 批次基准 / 成本 / 售价 / 成本率
 *   明细表列 = 编号 | 配料名称 | 损耗率 | 原料价格 | 配料毛重 | 配料净重 | 单位 | 共计
 *   用量口径 = 每批净重（面粉 500g = 1 批，取自 docx/DB 原文，不折算）
 *   损耗率 = 1 − 出成率；毛重 = 净重 ÷ 出成率；共计 = 毛重 × 均价
 */

/** 配料类别展示顺序（对齐 docx：面主料/主料/辅料/调料） */
const PART_ORDER = ['面主料', '主料', '辅料', '调料']

type CardRow = CostCardLine & { key: string; group?: boolean }

function buildRows(lines: CostCardLine[]): CardRow[] {
  const byPart = new Map<string, CostCardLine[]>()
  for (const l of lines) {
    const p = l.part || '其他'
    if (!byPart.has(p)) byPart.set(p, [])
    byPart.get(p)!.push(l)
  }
  const parts = [
    ...PART_ORDER.filter((p) => byPart.has(p)),
    ...[...byPart.keys()].filter((p) => !PART_ORDER.includes(p)),
  ]
  const rows: CardRow[] = []
  for (const p of parts) {
    rows.push({ key: `g-${p}`, group: true, name: p, part: p })
    for (const l of byPart.get(p)!) {
      rows.push({ ...l, key: `${p}-${rows.length}-${l.name}` })
    }
  }
  return rows
}

/** 数字去尾零（500 → 500、83.68 → 83.68） */
function num(v: number | null | undefined, digits = 4): string {
  if (v == null || !isFinite(v)) return '—'
  return String(parseFloat(v.toFixed(digits)))
}

const money = (v: number | null | undefined, digits = 2) =>
  v == null || !isFinite(v) ? '—' : `¥${Number(v).toFixed(digits)}`

export default function StandardRecipeCard({
  recipe,
  card,
}: {
  recipe: RecipeItem
  card: CostCard
}) {
  const rows = buildRows(card.bom_lines ?? [])
  const portionPieces = card.portion_pieces ?? 15
  const batchPieces = card.batch_pieces ?? null
  const portionCost =
    card.portion_cost ?? (card.unit_cost != null ? card.unit_cost * portionPieces : null)
  const costRatio =
    card.price != null && card.price > 0 && portionCost != null
      ? (portionCost / card.price) * 100
      : null
  const params = (recipe.params ?? {}) as Record<string, unknown>
  const note = String(params['色源说明'] ?? '').trim() || recipe.subtitle || '—'

  const columns: ColumnsType<CardRow> = [
    {
      title: (
        <span>
          编号<small style={{ color: '#999' }}> code</small>
        </span>
      ),
      dataIndex: 'ing',
      width: 72,
      render: (v: string | null | undefined, r) => (r.group ? '' : v || '—'),
    },
    {
      title: (
        <span>
          配料名称<small style={{ color: '#999' }}> Product name</small>
        </span>
      ),
      dataIndex: 'name',
      render: (v: string, r) =>
        r.group ? <strong>{v}</strong> : v,
    },
    {
      title: (
        <span>
          损耗率<small style={{ color: '#999' }}> Waste %</small>
        </span>
      ),
      dataIndex: 'waste_pct',
      width: 96,
      align: 'right',
      render: (v: number | null | undefined, r) =>
        r.group ? '' : v == null ? '—' : `${num(v, 2)}%`,
    },
    {
      title: (
        <span>
          原料价格<small style={{ color: '#999' }}> Price</small>
        </span>
      ),
      dataIndex: 'price_per_unit',
      width: 128,
      align: 'right',
      render: (v: number | null | undefined, r) =>
        r.group ? '' : v == null ? '—' : `${num(v, 3)}/${r.unit || 'g'}`,
    },
    {
      title: (
        <span>
          配料毛重<small style={{ color: '#999' }}> Gross W</small>
        </span>
      ),
      dataIndex: 'gross_g',
      width: 100,
      align: 'right',
      render: (v: number | null | undefined, r) =>
        r.group ? '' : v == null ? '—' : `${num(v, 2)} g`,
    },
    {
      title: (
        <span>
          配料净重<small style={{ color: '#999' }}> Net W</small>
        </span>
      ),
      dataIndex: 'qty_g',
      width: 100,
      align: 'right',
      render: (v: number | null | undefined, r) =>
        r.group ? '' : v == null ? '—' : `${num(v, 2)} g`,
    },
    {
      title: (
        <span>
          单位<small style={{ color: '#999' }}> Unit</small>
        </span>
      ),
      dataIndex: 'unit',
      width: 64,
      align: 'center',
      render: (v: string | undefined, r) => (r.group ? '' : v || 'g'),
    },
    {
      title: (
        <span>
          共计<small style={{ color: '#999' }}> Total</small>
        </span>
      ),
      dataIndex: 'line_cost',
      width: 96,
      align: 'right',
      render: (v: number | null | undefined, r) =>
        r.group ? '' : r.matched ? money(v) : '—',
    },
  ]

  const steps = recipe.steps ?? []

  return (
    <div>
      <Descriptions
        bordered
        size="small"
        column={3}
        title={
          <span style={{ fontSize: 13 }}>
            标准配方卡 · 每批用量（面粉 500g = 1 批，不折算）
          </span>
        }
        style={{ marginBottom: 12 }}
      >
        <Descriptions.Item label="菜品名称" span={2}>
          {recipe.name}
        </Descriptions.Item>
        <Descriptions.Item label="批次基准">
          1 批{batchPieces ? ` · 一批出成 ${batchPieces} 个` : ''} · 一份 {portionPieces} 只
        </Descriptions.Item>
        <Descriptions.Item label="配方总成本">
          {money(card.batch_cost)}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {' '}
            /批
          </Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label="份成本">
          {money(portionCost)}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {' '}
            /{portionPieces} 只
          </Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label="成本率">
          {costRatio != null ? (
            <Tag color={costRatio > 45 ? COLORS.red : COLORS.green}>
              {costRatio.toFixed(1)}%
            </Tag>
          ) : (
            '—'
          )}
        </Descriptions.Item>
        <Descriptions.Item label="菜品售价">{money(card.price)}</Descriptions.Item>
        <Descriptions.Item label="事项" span={2}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            出品速度 — · 上菜速度 — · 保质期 —
          </Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label="备注" span={3}>
          {note}
        </Descriptions.Item>
      </Descriptions>

      <Table<CardRow>
        size="small"
        bordered
        rowKey="key"
        columns={columns}
        dataSource={rows}
        pagination={false}
        onRow={(r) => ({
          style: r.group ? { background: '#fafafa', fontWeight: 600 } : undefined,
        })}
      />

      <Typography.Title level={5} style={{ marginTop: 16 }}>
        METHOD · 制作方法
      </Typography.Title>
      {steps.length > 0 ? (
        <ol style={{ paddingLeft: 20, margin: 0 }}>
          {steps.map((s, i) => (
            <li key={i} style={{ marginBottom: 4 }}>
              {s}
            </li>
          ))}
        </ol>
      ) : (
        <span style={{ color: '#999' }}>未配置</span>
      )}
    </div>
  )
}
