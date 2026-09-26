import axios from 'axios'
import { client } from './client'
import type {
  ActionItem,
  ActionStatus,
  BookingResp,
  Dish,
  FoodsafeResp,
  Health,
  KitchenBoardItem,
  ListResp,
  LoginRequest,
  LoginResponse,
  QcRecord,
  RecipeDetailResp,
  RecipesResp,
  ReportDaily,
  Snapshot,
  StaffModuleResp,
  WorkorderResp,
  OrgOverview,
  OrgUser,
  OrgPosition,
} from './types'

/** POST /api/admin/login */
export async function login(req: LoginRequest): Promise<LoginResponse> {
  const { data } = await client.post<LoginResponse>('/admin/login', req)
  return data
}

/** GET /api/org */
export async function fetchOrg(): Promise<OrgOverview> {
  const { data } = await client.get<OrgOverview>('/org')
  return data
}

/** POST /api/org/users */
export async function createOrgUser(body: {
  account: string
  password?: string
  display_name?: string
  position_id?: string
  store_id?: string
}): Promise<{ ok: boolean; user: OrgUser }> {
  const { data } = await client.post('/org/users', body)
  return data
}

/** POST /api/org/users/update — 改岗/停用/改名 */
export async function updateOrgUser(body: {
  account?: string
  id?: string
  display_name?: string
  position_id?: string
  store_id?: string
  status?: string
}): Promise<{ ok: boolean; user: OrgUser }> {
  const { data } = await client.post('/org/users/update', body)
  return data
}

/** POST /api/org/users/reset-password */
export async function resetOrgPassword(body: {
  account: string
  password?: string
}): Promise<{ ok: boolean; account?: string }> {
  const { data } = await client.post('/org/users/reset-password', body)
  return data
}

/** POST /api/org/positions/update — 改岗位权限 */
export async function updateOrgPosition(body: {
  id?: string
  position_id?: string
  name?: string
  write?: boolean
  permissions?: string[]
}): Promise<{ ok: boolean; position?: OrgPosition }> {
  const { data } = await client.post('/org/positions/update', body)
  return data
}

/**
 * 管理端主数据写：入队 + 立即确认（仍走确认台状态机，不直连店内库）。
 * 消费器异步落库后快照刷新。
 */
export async function submitConfirmedAction(
  body: PostActionBody,
): Promise<PostActionResult & { confirmed?: boolean }> {
  const enq = await postAction(body)
  const rev = enq.rev
  try {
    await confirmAction(enq.id, { operator: body.operator || 'admin', rev })
    return { ...enq, status: '待执行', confirmed: true }
  } catch {
    return { ...enq, confirmed: false }
  }
}

/*
 * GET /api/health。当前 BFF 的健康检查实际挂在 /health（未带 /api 前缀），
 * 故失败时回退直连 /health；两者都不通则抛错由调用方按「BFF 离线」处理。
 */
export async function fetchHealth(): Promise<Health> {
  try {
    const { data } = await client.get<Health>('/health')
    if (data && typeof data === 'object' && 'ok' in data) return data
    throw new Error('unexpected health payload')
  } catch {
    const { data } = await axios.get<Health>('/health', { timeout: 5000 })
    if (data && typeof data === 'object' && 'ok' in data) return data
    throw new Error('bff offline')
  }
}

/** GET /api/report/daily?date= */
export async function fetchReportDaily(date?: string): Promise<ReportDaily> {
  const { data } = await client.get<ReportDaily>('/report/daily', {
    params: date ? { date } : undefined,
  })
  return data
}

/** GET /api/snapshot/latest */
export async function fetchSnapshot(): Promise<Snapshot> {
  const { data } = await client.get<Snapshot>('/snapshot/latest')
  return data
}

/** 服务端补货建议项（GET /api/inventory/restock-suggest） */
export interface RestockSuggestItem {
  ingredientId: string
  name?: string
  unit?: string
  /** 当前库存 */
  qty?: number
  /** 安全线 */
  safe?: number | null
  suggestQty?: number
  daily?: number
  daysLeft?: number | null
  reason?: string
  source?: string
  urgency?: 'critical' | 'low' | 'watch'
}

/** GET /api/inventory/restock-suggest — 服务端补货建议（est/plans 口径） */
export async function fetchRestockSuggest(): Promise<{
  ok: boolean
  mock?: boolean
  banner?: string
  items: RestockSuggestItem[]
}> {
  const { data } = await client.get('/inventory/restock-suggest')
  return data
}

/** GET /api/actions?status= */
export async function fetchActions(status?: ActionStatus): Promise<ActionItem[]> {
  const { data } = await client.get<ActionItem[] | { items: ActionItem[] }>(
    '/actions',
    { params: status ? { status } : undefined },
  )
  return Array.isArray(data) ? data : data.items ?? []
}

export interface PostActionBody {
  type: string
  payload?: Record<string, unknown>
  operator?: string
}

export interface PostActionResult {
  ok: boolean
  id: string
  status: string
  rev?: number | string
  created_at?: string
  dedup?: boolean
  trace_id?: string
}

/** POST /api/actions — 写操作统一入队（不直连店内 sync） */
export async function postAction(body: PostActionBody): Promise<PostActionResult> {
  const { data } = await client.post<PostActionResult>('/actions', body)
  return data
}

/** POST /api/actions/{id}/confirm */
export async function confirmAction(
  id: string,
  body: { operator?: string; rev?: string | number },
): Promise<{ ok: boolean; id: string; status: string }> {
  const { data } = await client.post(`/actions/${encodeURIComponent(id)}/confirm`, body)
  return data
}

/** POST /api/actions/{id}/reject */
export async function rejectAction(
  id: string,
  body: { reason?: string } = {},
): Promise<{ ok: boolean; id: string; status: string }> {
  const { data } = await client.post(`/actions/${encodeURIComponent(id)}/reject`, body)
  return data
}

/** GET /api/actions/{id}/status — 已确认单执行进度轮询 */
export async function fetchActionStatus(id: string): Promise<{
  ok?: boolean
  id: string
  status: string
  executed_at?: string
  error?: string
}> {
  const { data } = await client.get(`/actions/${encodeURIComponent(id)}/status`)
  return data
}

/* ---------------- 菜品厨房（Sprint 1） ---------------- */

/** GET /api/admin/dishes → {ok,key,count,items,rev} */
export async function fetchAdminDishes(): Promise<ListResp<Dish>> {
  const { data } = await client.get<ListResp<Dish>>('/admin/dishes')
  return data
}

/** GET /api/kitchen/recipes */
export async function fetchKitchenRecipes(): Promise<RecipesResp> {
  const { data } = await client.get<RecipesResp>('/kitchen/recipes')
  return data
}

/** GET /api/kitchen/recipes/{sku_id} */
export async function fetchKitchenRecipe(skuId: string): Promise<RecipeDetailResp> {
  const { data } = await client.get<RecipeDetailResp>(
    `/kitchen/recipes/${encodeURIComponent(skuId)}`,
  )
  return data
}

/** GET /api/sop/workorder?date= */
export async function fetchWorkorders(date: string): Promise<WorkorderResp> {
  const { data } = await client.get<WorkorderResp>('/sop/workorder', {
    params: { date },
  })
  return data
}

/** GET /api/kitchen/qc?date= */
export async function fetchKitchenQc(date: string): Promise<ListResp<QcRecord>> {
  const { data } = await client.get<ListResp<QcRecord>>('/kitchen/qc', {
    params: { date },
  })
  return data
}

/** GET /api/kitchen/board?date= */
export async function fetchKitchenBoard(
  date: string,
): Promise<ListResp<KitchenBoardItem>> {
  const { data } = await client.get<ListResp<KitchenBoardItem>>('/kitchen/board', {
    params: { date },
  })
  return data
}

/* ---------------- Sprint 2：modules 只读端点 + 审计 ---------------- */

/** GET /api/modules/staff */
export async function fetchModulesStaff(): Promise<StaffModuleResp> {
  const { data } = await client.get<StaffModuleResp>('/modules/staff')
  return data
}

/** GET /api/modules/booking?date= */
export async function fetchBooking(date: string): Promise<BookingResp> {
  const { data } = await client.get<BookingResp>('/modules/booking', {
    params: { date },
  })
  return data
}

/** GET /api/modules/foodsafe */
export async function fetchFoodsafe(): Promise<FoodsafeResp> {
  const { data } = await client.get<FoodsafeResp>('/modules/foodsafe')
  return data
}
