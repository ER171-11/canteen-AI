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

/**
 * GET /api/report/daily
 * 兼容两种下发形状：契约版 kpis:[{key,label,value,unit,delta,trend}]；
 * 当前 BFF 实际版 kpi:[{label,value,delta}]（value 已带 ¥ 等格式）。
 */
export interface ReportDaily {
  date: string
  banner?: string
  kpis?: KpiItem[]
  kpi?: Array<{ label: string; value: string | number; delta?: string | null }>
  todos?: TodoItem[]
  alerts?: AlertItem[]
  rev?: number
}

/** 审批中心动作四态（BFF 实际下发中文状态，渲染层做双语映射） */
export type ActionStatus = 'pending' | 'confirmed' | 'rejected' | 'done'

/** GET /api/actions 列表项 */
export interface ActionItem {
  id: string
  type: string
  title?: string
  /** 英文四态或中文「待审批/已通过/已驳回/已执行」 */
  status: ActionStatus | '待审批' | '已通过' | '已驳回' | '已执行' | string
  initiator?: string
  operator?: string
  payload?: Record<string, unknown>
  created_at?: string
  updated_at?: string
  confirmed_at?: string
  executed_at?: string
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

/** GET /api/admin/dishes 菜品（快照下发，86 道真实菜品） */
export interface Dish {
  id: string
  /** 分类，如 引流/招牌/五福饺 */
  cat?: string
  name: string
  /** 估算成本（元） */
  est?: number
  price?: number
  /** 销量 */
  q?: number
  /** 是否上架 */
  on?: boolean
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

/* ---------------- 菜品厨房（Sprint 1 契约） ---------------- */

/** BOM 条目：face_main/main/aux/seasoning 数组元素，对象或字符串均可能出现 */
export type BomEntry = Record<string, string | number | undefined> | string

/** GET /api/kitchen/recipes → items 元素 */
export interface RecipeItem {
  sku_id: string
  name: string
  /** 五色：red/black/yellow/green/purple 或 红/黑/黄/绿/紫 */
  color: string
  filling?: string
  face_main?: BomEntry[]
  main?: BomEntry[]
  aux?: BomEntry[]
  seasoning?: BomEntry[]
  steps?: string[]
  params?: Record<string, string | number>
  blessing?: string
  diet_tags?: string[]
  version?: string
  updated_at?: string
}

/** GET /api/kitchen/recipes/{sku_id} → steps 元素（SOP 步骤） */
export interface SopStep {
  sku_id?: string
  step_no: number
  /** 阶段：和面/醒发/备馅/拌馅/剂子/包制/煮制/装盘 */
  stage: string
  duration_min?: number
  tools?: string | string[]
  inputs?: string
  key_points?: string
  qc_point?: string
  risk?: string
  params?: Record<string, unknown>
}

/** GET /api/sop/workorder?date= → workorders 元素 */
export interface WorkOrder {
  id: string
  sku_id: string
  name: string
  color: string
  qty: number
  planned_start?: string
  /** 待开始/进行中/已完成 */
  status: string
  steps?: SopStep[]
}

/** GET /api/kitchen/qc?date= → items 元素 */
export interface QcRecord {
  id: string
  workorder_id?: string
  sku_id: string
  sample_weight?: number
  pass: boolean
  ts?: string
  source?: string
}

/** GET /api/kitchen/board?date= → items 元素（按五色分组） */
export interface KitchenBoardItem {
  color: string
  planned: number
  done: number
  qc_pass_rate?: number
}

/** 通用列表响应包装 */
export interface ListResp<T> {
  ok: boolean
  items: T[]
  rev?: number | string
  count?: number
  key?: string
}

export type RecipesResp = ListResp<RecipeItem>

export interface RecipeDetailResp {
  ok: boolean
  item: RecipeItem
  steps: SopStep[]
}

export interface WorkorderResp {
  ok: boolean
  date: string
  workorders: WorkOrder[]
}
