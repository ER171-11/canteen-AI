/*
 * api/snapshotHighRisk.ts — W4 高危三件套（ADR-013 D4 / FP-SET-15/16/17）的 BFF 契约与请求入口。
 *
 * 红线：
 *   · 预览端点（preview）**只读零写**：纯计算，不写快照、不写暂存、不入队；
 *   · 写全部走队列：导入恢复 POST /snapshot/import（暂存文件 + 入 `snapshot.import` 动作），
 *     重置基线 / 清空 POST /actions（`snapshot.reset_baseline` / `snapshot.clear`）；
 *   · 三项均为「仅老板/店长」（BFF 侧 HIGH_RISK_TYPES 门禁，前端 disabled 只是体验层）。
 */
import { client } from './client'

/** 快照规模摘要（与后端 countSummary 同口径） */
export interface SnapshotSummary {
  ings: number
  recv: number
  sales: number
  quotes: number
  logs: number
  dishes: number
  ext_tables: number
}

export interface SummaryDelta {
  key: keyof SnapshotSummary
  current: number
  next: number
}

/** 基线制品（随包 bff/baselines/baseline-<ver>.json） */
export interface BaselineItem {
  version: string
  generated_at: string | null
  source: string | null
  note: string
  size: number
  counts: SnapshotSummary
  checksum_ok: boolean
}

export interface BaselinePreview {
  ok: true
  baseline_version: string
  baseline_generated_at: string | null
  baseline_source: string | null
  baseline_note: string
  checksum_ok: boolean
  current_rev: number | null
  will_discard: SnapshotSummary
  will_restore: SnapshotSummary
  changed: SummaryDelta[]
}

export interface SnapshotImportPreview {
  ok: true
  incoming_rev: number | null
  schema_steps: number
  current_rev: number | null
  will_discard: SnapshotSummary
  will_restore: SnapshotSummary
  changed: SummaryDelta[]
}

export interface ClearPreview {
  ok: true
  scope: 'business' | 'all'
  current_rev: number | null
  will_discard: SnapshotSummary
  remaining: SnapshotSummary
  kept_data: string[]
  kept_ext: string[]
  removed_files: string[]
}

/** GET /api/snapshot/baselines —— 可用基线版本列表（只读） */
export async function fetchBaselines(): Promise<{ items: BaselineItem[]; count: number }> {
  const { data } = await client.get<{ ok: boolean; items: BaselineItem[]; count: number }>('/snapshot/baselines')
  return { items: data.items || [], count: data.count || 0 }
}

/** GET /api/snapshot/baseline/preview?version= —— 重置前只读预览 */
export async function fetchBaselinePreview(version?: string): Promise<BaselinePreview> {
  const { data } = await client.get<BaselinePreview>('/snapshot/baseline/preview', {
    params: version ? { version } : {},
  })
  return data
}

/** POST /api/snapshot/import/preview —— 导入前只读预览（解析 + schema 校验 + 差异统计，零写） */
export async function previewSnapshotImport(snapshot: unknown): Promise<SnapshotImportPreview> {
  const { data } = await client.post<SnapshotImportPreview>(
    '/snapshot/import/preview',
    { snapshot },
    { timeout: 60000 },
  )
  return data
}

/**
 * POST /api/snapshot/import —— 暂存导入文件 + 入队 `snapshot.import`（仅老板/店长）。
 * 执行器在审批确认后才整包覆盖 data+ext，且执行前自动打备份。
 */
export async function submitSnapshotImport(
  snapshot: unknown,
  reason?: string,
): Promise<{ ok: boolean; id: string; status: string; import_id: string; dedup?: boolean }> {
  const { data } = await client.post(
    '/snapshot/import',
    { snapshot, reason: reason || '' },
    { timeout: 60000 },
  )
  return data
}

/** GET /api/snapshot/clear/preview?scope= —— 清空前只读预览 */
export async function fetchClearPreview(scope: 'business' | 'all'): Promise<ClearPreview> {
  const { data } = await client.get<ClearPreview>('/snapshot/clear/preview', { params: { scope } })
  return data
}

/** 重置为基线（入队 `snapshot.reset_baseline`，仅老板/店长） */
export async function submitResetBaseline(payload: {
  baseline_version: string
  reason?: string
}): Promise<{ ok: boolean; id: string; status: string; rev?: number | string }> {
  const { data } = await client.post('/actions', {
    type: 'snapshot.reset_baseline',
    payload,
    operator: 'admin',
  })
  return data
}

/** 清空业务数据（入队 `snapshot.clear`，仅老板/店长） */
export async function submitSnapshotClear(payload: {
  scope: 'business' | 'all'
  reason?: string
}): Promise<{ ok: boolean; id: string; status: string; rev?: number | string }> {
  const { data } = await client.post('/actions', {
    type: 'snapshot.clear',
    payload,
    operator: 'admin',
  })
  return data
}
