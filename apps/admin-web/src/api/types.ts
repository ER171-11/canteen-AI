/*
 * BFF 接口类型定义。
 * 形状依据任务书约定的端点契约（POST /api/admin/login、GET /api/report/daily、
 * GET /api/snapshot/latest、GET /api/actions 等）。当前 BFF 尚未实现这些端点，
 * 字段以可选为主做前向兼容，页面侧对缺失字段需有兜底渲染。
 */

/** 角色枚举：与 BFF 下发 role 字段一致 */
export type Role = '老板' | '店长' | '财务' | '厨房' | '只读'

/** POST /api/admin/login 入参 */
export interface LoginRequest {
  account: string
  password?: string
  device_fp: string
}

/** POST /api/admin/login 出参 */
export interface LoginResponse {
  token: string
  role: Role
  expires_at: string
}

/** GET /api/health */
export interface Health {
  ok: boolean
  service?: string
  /** 数据快照修订号（Header 展示用） */
  rev?: number | string
  /** 快照最近更新时间（ISO8601） */
  updated_at?: string
  time?: string
  models?: string[]
  keyLoaded?: boolean
}

/** GET /api/snapshot/latest */
export interface Snapshot {
  rev: number | string
  updated_at: string
  data?: Record<string, unknown>
}

/** 经营看板 KPI 单项 */
export interface KpiItem {
  key: string
  label: string
  value: number | string
  unit?: string
  /** 同比/环比描述，如 "+12.3%" */
  delta?: string
  trend?: 'up' | 'down' | 'flat'
}

/** 待办事项 */
export interface TodoItem {
  id: string
  title: string
  source?: string
  created_at?: string
}

/** 预警项：level 对应五色体系语义 */
export interface AlertItem {
  id: string
  title: string
  level: 'critical' | 'warn' | 'info'
  detail?: string
  created_at?: string
}

/** GET /api/report/daily */
export interface ReportDaily {
  date: string
  banner?: string
  kpis: KpiItem[]
  todos: TodoItem[]
  alerts: AlertItem[]
}

/** 审批中心动作四态 */
export type ActionStatus = 'pending' | 'confirmed' | 'rejected' | 'done'

/** GET /api/actions 列表项 */
export interface ActionItem {
  id: string
  type: string
  title: string
  status: ActionStatus
  initiator?: string
  payload?: Record<string, unknown>
  created_at?: string
  updated_at?: string
}

/** POST /api/actions/{id}/status 出参 */
export interface ActionStatusResult {
  id: string
  status: ActionStatus
  detail?: string
}

/** AI 审计日志（Kimi 调用记录） */
export interface KimiLog {
  traceId: string
  type: 'recv' | 'stock' | 'qc' | 'plate' | 'sample' | 'uniform'
  model?: string
  ok: boolean
  latency_ms?: number
  created_at?: string
}

/* ---------------- 只读管理端点实体（/api/admin/*） ---------------- */

export interface Dish {
  id: string
  name: string
  color?: 'red' | 'black' | 'yellow' | 'green' | 'purple' | 'white'
  price?: number
  status?: 'on' | 'off'
}

export interface Recipe {
  id: string
  dish_id: string
  dish_name?: string
  bom?: Array<{ material: string; qty: number; unit: string }>
}

export interface Staff {
  id: string
  name: string
  role?: string
  phone?: string
  health_cert_expire?: string
}

export interface Member {
  id: string
  name: string
  phone?: string
  level?: string
  balance?: number
  birthday?: string
}

export interface DiningTable {
  id: string
  name: string
  seats?: number
  status?: 'free' | 'occupied' | 'reserved'
}

export interface Vendor {
  id: string
  name: string
  category?: string
  contact?: string
  rating?: number
}

/** 统一错误形状（BFF 返回 { ok:false, error } 时） */
export interface ApiError {
  ok: false
  error: string
  traceId?: string
}
