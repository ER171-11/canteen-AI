/*
 * api/snapshotRollback.ts — W2-01 快照回滚（ADR-013 D1）的 BFF 契约与请求入口。
 *
 * 与 api/recvImport.ts 等同主题拆分：不把改动混进 api/index.ts。
 */
import { client } from './client'

/** 回滚预览（只读）：当前 rev → 目标 rev、备份时间、将丢弃/将恢复的数据规模 */
export interface SnapshotRollbackPreview {
  ok: true
  backup_id: string
  backup_rev: number | null
  backup_generated_at: string | null
  current_rev: number | null
  will_restore: SnapshotSummary
  will_discard: SnapshotSummary | null
}

export interface SnapshotSummary {
  ings: number
  recv: number
  sales: number
  quotes: number
  logs: number
  dishes: number
  ext_tables: number
}

/**
 * GET /api/snapshot/backup/preview?id= —— 回滚前只读预览（纯计算，零写）。
 * 失败时 BFF 返回 4xx + {ok:false,error}，调用方从 error.response.data.error 取文案。
 */
export async function fetchSnapshotRollbackPreview(id: string): Promise<SnapshotRollbackPreview> {
  const { data } = await client.get<SnapshotRollbackPreview>('/snapshot/backup/preview', { params: { id } })
  return data
}

/**
 * 提交快照回滚动作（高危写，仅老板/店长）。走 /api/actions 队列 → 审批中心确认 → 执行器。
 * 返回动作 id，前端提示「已入队 → 审批中心确认」。
 */
export async function submitSnapshotRollback(payload: {
  backup_id: string
  target_rev?: number
  reason?: string
}): Promise<{ ok: boolean; id: string; rev?: number | string; status: string }> {
  const { data } = await client.post('/actions', {
    type: 'snapshot.rollback',
    payload,
    operator: 'admin',
  })
  return data
}
