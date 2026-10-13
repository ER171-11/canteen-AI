/*
 * api/recvImport.ts — 进货单批量导入（FP-RECV-02 / FP-RECV-03）的 BFF 契约与请求入口。
 *
 * 为什么单独成文件（而不是写进 api/index.ts）：
 *   api/index.ts 是全站共用入口，当前还挂着「现场管理」的在途未提交改动；
 *   为了按单一主题提交、不把别人的改动混进本阶段，本阶段的接口与类型放在这里（不删别人的东西）。
 */
import { client } from './client'

/** 预览返回的单据分组（同一批文件会按「供应商+日期」拆成多张 JH 单） */
export interface RecvImportGroup {
  supplier: string
  date: string
  note: string
  payable: number
  lines: RecvImportLine[]
}

export interface RecvImportLine {
  /** 原料档案 id（预览阶段已匹配）；未匹配行为空串，导入时由执行器自动建档 */
  ingId: string
  name: string
  qty: number
  price: number
  unit: string
  amount: number
  /** true = 原料档案里没有，导入时自动建档为「待完善草稿」（旧版 createIngFromImport 语义） */
  isNew?: boolean
}

/** 本批导入将自动建档的新原料（待完善草稿） */
export interface RecvImportNewIng {
  name: string
  unit: string
  cat: string
}

/**
 * POST /api/inventory/recv/import/preview 的**成功**响应。
 * 失败时 BFF 返回 4xx + {ok:false,error}，调用方从 error.response.data.error 取文案展示
 * （这类失败是正常的用户操作反馈，不是异常，不要把文案吞掉）。
 */
export interface RecvImportPreview {
  ok: true
  /** 识别出的真实格式：xlsx / html / csv / json */
  format: string
  sheet?: string
  sheetCount?: number
  /** 数量非数字等被剔除的行数（旧版把这类与「×/未收」混算，本版分开） */
  bad: number
  /** 实收数为 ×/未收/已划掉 的业务性跳过的行数 */
  skipped: number
  /** 「原料档案」中不存在、本批将**自动建档**（待完善草稿）的原料名 */
  unmatched: string[]
  /** 同上，带 unit/cat 明细 */
  newIngs?: RecvImportNewIng[]
  groups: RecvImportGroup[]
  single: boolean
  totalLines: number
  totalAmount: number
}

/**
 * 进货单批量导入**预览**（只读）。
 *
 * 红线：本端点在 BFF 侧不写文件、不改快照、不入队；真正的写要等用户点「确认导入」后
 * 由页面投**一个** recv.import 动作走 /api/actions（ADR-004 §2.4：批内原子）。
 */
export async function previewRecvImport(body: {
  fileName: string
  contentBase64: string
}): Promise<RecvImportPreview> {
  const { data } = await client.post<RecvImportPreview>('/inventory/recv/import/preview', body)
  return data
}
