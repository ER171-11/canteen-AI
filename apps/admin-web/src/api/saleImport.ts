/*
 * api/saleImport.ts — 平台销售数据导入（FP-SALE-03/04/05/06）的 BFF 契约与请求入口。
 *
 * 与 api/recvImport.ts 同型：预览只读，写统一走 /api/actions（sale.import / sale.batch_void /
 * sale.amt_recalc / sale.alias_set / sale.alias_delete）。
 * 金额口径唯一出口在 BFF 侧 resolveSaleAmt —— 前端只传「原始文件 + 人工映射」，不本地算金额。
 */
import { client } from './client'

export interface SaleImportLine {
  dish: string
  dishName: string
  qty: number
  price: number
  amount: number
}

export interface SaleImportDoc {
  date: string
  srcNo: string
  lines: SaleImportLine[]
  sub: number
  discount: number
  receivable: number
  amtMode: string
}

export interface SaleImportPreview {
  ok: true
  format: string
  sheet?: string
  mode: 'detail' | 'sum'
  totalRows: number
  matched: number
  unmapped: number
  skipped: number
  /** 平台菜名里在本店「在售菜品」中匹配不到的名字（需人工映射，否则这些行被跳过） */
  unmatched: string[]
  docs: SaleImportDoc[]
  totalDocs: number
  totalReceivable: number
}

export interface SaleBatch {
  batch: string
  src: string
  srcName: string
  count: number
  receivable: number
  voided: number
  settled: boolean
  dateMin: string
  dateMax: string
  ts: string
}

export interface SaleAlias {
  name: string
  dish: string
  dishName: string
  mul: number
}

export interface SaleDishOption {
  id: string
  name: string
}

export interface SaleSrcOption {
  key: string
  name: string
  ch: string
}

/** 平台来源（前端常量，与 BFF lib/sales_import.js 的 SALE_SRC 对齐，供导入下拉用） */
export const SALE_SRCS: SaleSrcOption[] = [
  { key: 'mt', name: '美团外卖', ch: '美团外卖' },
  { key: 'other', name: '其他平台', ch: '外卖' },
]

/** 金额口径（前端常量，与 BFF 的 SALE_AMT_MODES 对齐，供重算下拉用） */
export const SALE_AMT_MODES: Record<string, string> = {
  A: '用户实付 + 商家实收（双全）',
  B: '仅用户实付',
  C: '仅商家实收',
  D: '原价 + 优惠/扣费',
  E: '仅单价×数量（兜底）',
}

/**
 * POST /api/sales/import/preview — 平台销售导入**预览**（只读，FP-SALE-03/05/06）。
 * 失败时 BFF 返回 4xx + {ok:false,error}，从 error.response.data.error 取文案。
 */
export async function previewSaleImport(body: {
  fileName: string
  contentBase64: string
}): Promise<SaleImportPreview> {
  const { data } = await client.post<SaleImportPreview>('/sales/import/preview', body)
  return data
}

/** GET /api/sales/import/batches — 外部销售批次列表（只读，FP-SALE-04 撤回入口数据源） */
export async function fetchSaleBatches(): Promise<{ ok: boolean; batches: SaleBatch[] }> {
  const { data } = await client.get<{ ok: boolean; batches: SaleBatch[] }>('/sales/import/batches')
  return data
}

/** GET /api/sales/import/alias — 菜名映射列表 + 在售菜品下拉 + 平台/口径常量（只读，FP-SALE-06） */
export async function fetchSaleAlias(): Promise<{
  ok: boolean
  aliases: SaleAlias[]
  onDishes: SaleDishOption[]
  srcs: SaleSrcOption[]
  amtModes: Record<string, string>
}> {
  const { data } = await client.get<{
    ok: boolean
    aliases: SaleAlias[]
    onDishes: SaleDishOption[]
    srcs: SaleSrcOption[]
    amtModes: Record<string, string>
  }>('/sales/import/alias')
  return data
}
