/*
 * api/quoteImport.ts — W2-04 报价批量导入（ADR-013 D2 / FP-PRICE-12）的 BFF 契约与请求入口。
 *
 * 与 api/recvImport.ts 同主题拆分：不把改动混进 api/index.ts。
 */
import { client } from './client'

export type QuoteImportRowStatus = 'append' | 'skipped' | 'invalid'

export interface QuoteImportRow {
  status: QuoteImportRowStatus
  ing: string
  src: string
  price: unknown
  reason?: string
  date?: string
}

export interface QuoteImportPreview {
  ok: true
  append: number
  skipped: number
  invalid: number
  rows: QuoteImportRow[]
  rev?: number | null
}

/** 单条待导入报价行（前端从 JSON 文件解析，字段对齐 panda-quote-task 衍生契约） */
export interface QuoteImportItem {
  ing?: string
  ing_id?: string
  ing_name?: string
  src?: string
  supplier?: string
  price: unknown
  per?: string
  date?: string
  name?: string
  unit?: string
  note?: string
}

/**
 * POST /api/supply/quote/import/preview —— 导入前只读预览（命中/跳过/非法计数）。
 * 红线：本端点不写库、不入队；真正的写要等用户点「确认导入」后投一个 quote.import 动作。
 */
export async function previewQuoteImport(items: QuoteImportItem[]): Promise<QuoteImportPreview> {
  const { data } = await client.post<QuoteImportPreview>('/supply/quote/import/preview', { items })
  return data
}

/**
 * 提交报价导入动作（整批一个动作，只写 data.quotes）。走 /api/actions 队列。
 */
export async function submitQuoteImport(items: QuoteImportItem[]): Promise<{
  ok: boolean
  id: string
  rev?: number | string
  status: string
}> {
  const { data } = await client.post('/actions', {
    type: 'quote.import',
    payload: { items },
    operator: 'admin',
  })
  return data
}
