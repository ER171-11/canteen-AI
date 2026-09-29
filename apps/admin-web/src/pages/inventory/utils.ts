import type { IngItem, InventoryDoc, InventoryLine } from '../../api/types'
import { COLORS } from '../../theme'

/** safe=0/缺失时按 est×2 兜底安全线 */
export function safetyLine(ing: IngItem): number {
  if (ing.safe && ing.safe > 0) return ing.safe
  return (ing.est ?? 0) * 2
}

export function stockStatus(ing: IngItem): { text: string; color: string } {
  const line = safetyLine(ing)
  if (line <= 0) return { text: '充足', color: COLORS.green }
  const r = (ing.stock ?? 0) / line
  if (r < 0.3) return { text: '告急', color: COLORS.red }
  if (r < 0.75) return { text: '偏低', color: COLORS.yellow }
  return { text: '充足', color: COLORS.green }
}

/** 补货建议量（库存单位）：低于安全线时补至安全线 */
export function suggestRestockQty(ing: IngItem): number {
  const line = safetyLine(ing)
  if (line <= 0) return 0
  const cur = ing.stock ?? 0
  if (cur >= line) return 0
  return Math.ceil((line - cur) * 100) / 100
}

/** 数字格式化（对齐旧版 fmt(n,d=2)：null/非数显示「—」，千分位） */
export function fmtNum(n: number | null | undefined, d = 2): string {
  return n == null || !Number.isFinite(n)
    ? '—'
    : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d })
}

/** 库存总值（对齐旧版 stockValue()：Σ 当前库存 × 均价，保留 2 位） */
export function stockValue(ings: IngItem[]): number {
  const sum = ings.reduce((a, g) => a + (Number(g.stock) || 0) * (Number(g.avg) || 0), 0)
  return Math.round((sum + Number.EPSILON) * 100) / 100
}

export function docPaid(doc: InventoryDoc): number {
  return (doc.payments ?? []).reduce((a, p) => a + (Number(p.amount) || 0), 0)
}

export function docDebt(doc: InventoryDoc): number {
  return Math.max(0, Math.round(((doc.payable ?? 0) - docPaid(doc)) * 100) / 100)
}

export function lineAmount(l: InventoryLine): number {
  if (l.amount != null) return Number(l.amount)
  return Math.round((Number(l.qty) || 0) * (Number(l.price) || 0) * 100) / 100
}

export function formatLinesSummary(
  lines: InventoryLine[] | undefined,
  ingName: (id: string) => string,
): string {
  if (!lines?.length) return '-'
  return lines
    .map((l) => {
      const name = ingName(String(l.ing ?? ''))
      const amt = lineAmount(l)
      return `${name} ${l.qty ?? 0} × ¥${l.price ?? 0} = ¥${amt}`
    })
    .join('；')
}
