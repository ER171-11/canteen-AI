import type { IngItem, InventoryDoc, InventoryLine } from '../../api/types'
import { COLORS } from '../../theme'

/**
 * W3 产品超链接（供应商资质证照 / 原料质检报告）：链接地址 → 可点击 href。
 * 只放行 http(s) 与站内绝对路径；裸域名补 https；其余（file:、javascript: 等）返回 null 按纯文本展示。
 */
export function safeHref(url?: string | null): string | null {
  const u = String(url ?? '').trim()
  if (!u) return null
  if (/^https?:\/\//i.test(u) || u.startsWith('/')) return u
  if (/^[\w.-]+\.[a-z]{2,}(\/|$|\?)/i.test(u)) return `https://${u}`
  return null
}

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

/* ---------------- 采购单状态（对齐旧版 orderLineSt/orderSt/orderStTag/orderRecvProg，旧 HTML:1688-1713） ---------------- */

export type OrderLineState = 'normal' | 'closed' | 'canceled'
export type OrderState = 'normal' | 'void' | 'draft' | 'closed'

/** 行状态：显式 st=canceled/closed 优先；否则「收齐即结案」（qty>0 且 recvQty≥qty） */
export function orderLineSt(l: InventoryLine | null | undefined): OrderLineState {
  const st = String(l?.st ?? '')
  if (st === 'canceled' || st === 'closed') return st
  const q = Number(l?.qty) || 0
  const got = Number(l?.recvQty) || 0
  return q > 0 && got >= q - 1e-6 ? 'closed' : 'normal'
}

/** 单状态：显式 void/draft/closed 优先；否则全部行收齐/作废 → 已结案，否则收货中 */
export function orderSt(p: InventoryDoc | null | undefined): OrderState {
  if (!p) return 'normal'
  const status = String(p.status ?? '')
  if (status === 'void') return 'void'
  if (status === 'draft') return 'draft'
  if (status === 'closed') return 'closed'
  const ls = p.lines ?? []
  if (ls.length && !ls.some((l) => orderLineSt(l) === 'normal')) return 'closed'
  return 'normal'
}

/** 状态标签（对齐旧版 orderStTag()） */
export function orderStMeta(st: OrderState): { text: string; color: string } {
  switch (st) {
    case 'closed':
      return { text: '已结案', color: COLORS.green }
    case 'void':
      return { text: '已作废', color: COLORS.gray }
    case 'draft':
      return { text: '草稿', color: COLORS.blue }
    default:
      return { text: '收货中', color: COLORS.orange }
  }
}

/** 行收货进度：q=下单量(采购单位) g=已收量（对齐旧版 orderRecvProg()） */
export function orderRecvProg(p: InventoryDoc): { q: number; g: number; pct: number } {
  let q = 0
  let g = 0
  for (const l of p.lines ?? []) {
    const a = Number(l.qty) || 0
    q += a
    g += Math.min(a, Number(l.recvQty) || 0)
  }
  const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
  return { q: r2(q), g: r2(g), pct: q > 0 ? Math.round((g / q) * 100) : 0 }
}
