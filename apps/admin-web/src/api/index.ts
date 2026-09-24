import axios from 'axios'
import { client } from './client'
import type {
  ActionItem,
  ActionStatus,
  Dish,
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
  WorkorderResp,
} from './types'

/** POST /api/admin/login */
export async function login(req: LoginRequest): Promise<LoginResponse> {
  const { data } = await client.post<LoginResponse>('/admin/login', req)
  return data
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

/** GET /api/report/daily */
export async function fetchReportDaily(): Promise<ReportDaily> {
  const { data } = await client.get<ReportDaily>('/report/daily')
  return data
}

/** GET /api/snapshot/latest */
export async function fetchSnapshot(): Promise<Snapshot> {
  const { data } = await client.get<Snapshot>('/snapshot/latest')
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

/** GET /api/admin/{resource}（dishes/recipes/staff/members/tables/vendors） */
export async function fetchAdminList<T>(resource: string): Promise<T[]> {
  const { data } = await client.get<T[] | { items: T[] }>(`/admin/${resource}`)
  return Array.isArray(data) ? data : data.items ?? []
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
