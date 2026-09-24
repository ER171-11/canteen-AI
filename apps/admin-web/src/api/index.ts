import axios from 'axios'
import { client } from './client'
import type {
  ActionItem,
  ActionStatus,
  Health,
  LoginRequest,
  LoginResponse,
  ReportDaily,
  Snapshot,
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
