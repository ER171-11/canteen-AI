import type { InventoryDoc, InventoryLine } from '../../../api/types'
import { docDebt, docPaid } from '../utils'

/**
 * 结算单数据层：只读汇总，不写任何库。
 * 移植自旧版 numToCn(:2105) / settleNo(:2128) / buildSettleData(:2129) / fmt,r2,r3(:668-672)。
 */

export const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100
export const r3 = (n: number): number => Math.round((n + Number.EPSILON) * 1000) / 1000

/** 与旧版 fmt(:668) 同口径：千分位 + 固定小数位，非法值显示 — */
export function fmt(n: unknown, d = 2): string {
  const v = Number(n)
  if (n == null || !Number.isFinite(v)) return '—'
  return v.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d })
}

export const today = (): string => new Date().toISOString().slice(0, 10)

/** 单据编号：JS- + 收货单号（旧版 settleNo:2128） */
export function settleNo(doc: InventoryDoc): string {
  return 'JS-' + String(doc.no ?? doc.id ?? '')
}

/**
 * 阿拉伯数字 → 人民币大写（支持到亿，含角分）。
 * 逐字符移植自旧版 numToCn(:2105-2127)，勿「优化」——这里的正则替换顺序是有讲究的。
 */
export function numToCn(money: number | string): string {
  let n = Math.abs(Number(money) || 0)
  if (!Number.isFinite(n)) return ''
  n = Math.round(n * 100) / 100
  const digits = '零壹贰叁肆伍陆柒捌玖'
  const unit: string[][] = [
    ['元', '万', '亿'],
    ['', '拾', '佰', '仟'],
  ]
  const frac = ['角', '分']
  let s = ''
  for (let i = 0; i < frac.length; i++) {
    s += (digits[Math.floor(n * 10 * Math.pow(10, i)) % 10] + frac[i]).replace(/零./, '')
  }
  s = s || '整'
  n = Math.floor(n)
  for (let i = 0; i < unit[0].length && n > 0; i++) {
    let p = ''
    for (let j = 0; j < unit[1].length && n > 0; j++) {
      p = digits[n % 10] + unit[1][j] + p
      n = Math.floor(n / 10)
    }
    s = p.replace(/(零.)*零$/, '').replace(/^$/, '零') + unit[0][i] + s
  }
  return s
    .replace(/(零.)*零元/, '元')
    .replace(/(零.)+/g, '零')
    .replace(/^整$/, '零元整')
}

export interface SettleLine {
  no: number
  name: string
  buyUnit: string
  qty: number
  price: number
  amount: number
}

export interface SettleData {
  lines: SettleLine[]
  count: number
  totalQty: number
  /** 明细合计 Σ lines[].amount（让利前金额） */
  gross: number
  /** 整单优惠/抹零（≥0，payable = gross − discount） */
  discount: number
  payable: number
  paid: number
  debt: number
}

/** 原料解析：给不出时按旧版回落到「（原料已删除）」 */
export interface IngLookup {
  (id: string): { name: string; buy: string } | undefined
}

/** 与旧版 buildSettleData(:2129-2136) 同口径 */
export function buildSettleData(doc: InventoryDoc, lookup: IngLookup): SettleData {
  const lines: SettleLine[] = (doc.lines ?? []).map((l: InventoryLine, i: number) => {
    const g = lookup(String(l.ing ?? ''))
    return {
      no: i + 1,
      name: g ? g.name : '（原料已删除）',
      buyUnit: g ? g.buy : '',
      qty: Number(l.qty) || 0,
      price: Number(l.price) || 0,
      amount: r2(Number(l.amount != null ? l.amount : (Number(l.qty) || 0) * (Number(l.price) || 0))),
    }
  })
  const gross = r2(lines.reduce((a, b) => a + b.amount, 0))
  const payable = r2(Number(doc.payable) || 0)
  const discount =
    doc.discount != null
      ? r2(Math.max(0, Number(doc.discount)))
      : r2(Math.max(0, gross - payable))
  return {
    lines,
    count: lines.length,
    totalQty: r3(lines.reduce((a, b) => a + b.qty, 0)),
    gross,
    discount,
    payable,
    paid: docPaid(doc),
    debt: docDebt(doc),
  }
}

/** CSV 转义 + UTF-8 BOM + CRLF（旧版 csv():5293）——无 BOM 时 Excel 打开中文必乱码 */
export function csv(rows: Array<Array<unknown>>): string {
  return (
    '\ufeff' +
    rows
      .map((r) =>
        r
          .map((v) => {
            const s = v == null ? '' : String(v)
            return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
          })
          .join(','),
      )
      .join('\r\n')
  )
}

/** HTML 文本转义 */
export function esc(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
