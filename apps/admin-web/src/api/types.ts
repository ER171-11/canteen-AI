/*
 * BFF 接口类型定义。
 * 形状对齐已上线端点：/api/auth|/api/admin|/api/report|/api/snapshot|/api/actions|/api/modules/* 等。
 * 字段以可选为主做前向兼容，页面侧对缺失字段需有兜底渲染。
 */

/** 角色枚举：与 BFF 下发 role 字段一致 */
export type Role = '老板' | '店长' | '财务' | '厨房' | '收银' | '只读'

/** POST /api/admin/login 入参 */
export interface LoginRequest {
  account: string
  password?: string
  device_fp: string
}

/** POST /api/admin/login 出参 */
export interface LoginResponse {
  ok?: boolean
  token: string
  role: Role
  expires_at: string
  display_name?: string
  store_id?: string
  store_name?: string
  position_name?: string
  permissions?: string[]
  can_write?: boolean
  error?: string
}

export interface OrgStore {
  id: string
  name: string
  brand?: string
  city?: string
  address?: string
  status?: string
}

export interface OrgPosition {
  id: string
  name: string
  write?: boolean
  permissions?: string[]
}

export interface OrgUser {
  id: string
  account: string
  display_name?: string
  role?: string
  position_id?: string
  position_name?: string
  store_id?: string
  store_name?: string
  permissions?: string[]
  can_write?: boolean
  status?: string
}

export interface OrgOverview {
  ok?: boolean
  stores: OrgStore[]
  positions: OrgPosition[]
  users: OrgUser[]
  modules?: string[]
  current_store_id?: string | null
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
  ok?: boolean
  rev: number | string
  updated_at?: string
  generated_at?: string
  data?: SnapshotData
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

/** 待办事项（BFF：text/kind/route/desc；前端归一 title） */
export interface TodoItem {
  id?: string
  title?: string
  text?: string
  done?: boolean
  kind?: string
  route?: string
  desc?: string
  source?: string
  created_at?: string
}

/** 预警项：level 对应五色体系语义（BFF 用 text；可带 desc） */
export interface AlertItem {
  id?: string
  title?: string
  text?: string
  level: 'critical' | 'warn' | 'info' | string
  detail?: string
  desc?: string
  created_at?: string
}

/**
 * GET /api/report/daily
 * 兼容两种下发形状：契约版 kpis:[{key,label,value,unit,delta,trend}]；
 * 当前 BFF 实际版 kpi:[{label,value,delta}]（value 已带 ¥ 等格式）。
 */
export interface ReportDaily {
  ok?: boolean
  mock?: boolean
  date: string
  banner?: string
  kpis?: KpiItem[]
  kpi?: Array<{ label: string; value: string | number; delta?: string | null }>
  heat_mini?: Array<{ hour: number; orders: number } | number>
  todos?: TodoItem[]
  alerts?: AlertItem[]
  rev?: number | string | null
  generated_at?: string | null
  kitchen?: { workorders_total?: number; workorders_done?: number }
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

/* ---------------- Sprint 2：快照明细 + modules 只读端点 ---------------- */

/** data.ings 原料（快照下发，163 项）。safe=0/缺失时前端按 est×2 兜底安全线 */
export interface IngItem {
  id: string
  name: string
  cat?: string
  unit?: string
  /** 当前库存量 */
  stock?: number
  /** 安全库存线（可能为 0） */
  safe?: number
  /** 估算日均消耗（安全线兜底用，快照可能无此字段） */
  est?: number
  /** 均价 */
  avg?: number
  on?: boolean
  _u?: string
}

/** 进货/采购单行 */
export interface InventoryLine {
  ing?: string
  qty?: number
  price?: number
  amount?: number
  conv?: number
  unitCost?: number
  recvQty?: number
  [k: string]: unknown
}

export interface DocPayment {
  amount?: number
  date?: string
  method?: string
}

/** 进货单 JH / 采购单 CG（快照 data.recv / data.orders） */
export interface InventoryDoc {
  id?: string
  no?: string
  date?: string
  supplier?: string
  lines?: InventoryLine[]
  payable?: number
  payments?: DocPayment[]
  note?: string
  method?: string
  po?: string
  [k: string]: unknown
}

/** data.recv 历史别名：动态字段兼容 Kimi 验货态 */
export type RecvRecord = InventoryDoc | Record<string, unknown>

/** data.logs 库存流水 */
export interface StockLogItem {
  seq?: number | string
  t?: string
  date?: string
  type?: string
  ing?: string
  qty?: number
  inCost?: number
  cost?: number
  bal?: number
  ref?: string
  [k: string]: unknown
}

/** data.quotes 外接比价 */
export interface QuoteItem {
  id?: string
  ing?: string
  src?: string
  price?: number
  per?: string
  date?: string
  note?: string
  [k: string]: unknown
}

/** data.pos 桌台（字段以快照实际下发为准） */
export interface PosTable {
  id?: string
  name?: string
  no?: string | number
  seats?: number
  /** 空闲/就餐/待清/预订（或 free/dining/cleaning/reserved） */
  status?: string
  [k: string]: unknown
}

export interface SnapshotData {
  ings?: IngItem[]
  recv?: RecvRecord[]
  orders?: InventoryDoc[]
  logs?: StockLogItem[]
  quotes?: QuoteItem[]
  vendors?: Vendor[]
  pos?: PosTable[]
  [k: string]: unknown
}

/* 人员模块 GET /api/modules/staff（字段以快照 ext 实发为准，页面做容错） */
export interface ShiftItem {
  id?: string
  staff_id?: string
  name?: string
  staff_name?: string
  staff?: string
  role?: string
  date?: string
  shift?: string
  start_time?: string
  end_time?: string
  /** mock 形态：7 天班次 */
  week?: string[]
  [k: string]: unknown
}
export interface ClockItem {
  name?: string
  staff_name?: string
  staff?: string
  staff_id?: string
  time?: string
  ts?: string
  kind?: string
  /** 准点/迟到 */
  status?: string
  [k: string]: unknown
}
export interface PerfItem {
  name?: string
  staff_name?: string
  staff?: string
  staff_id?: string
  score?: number
  hours?: number
  output?: string | number
  value?: string | number
  remark?: string
  metric?: string
  [k: string]: unknown
}
export interface TrainItem {
  name?: string
  staff_name?: string
  staff?: string
  staff_id?: string
  stage?: string
  course?: string
  progress?: number
  passed?: number | boolean
  remark?: string
  cert_expire?: string
  [k: string]: unknown
}
export interface StaffModuleResp {
  ok: boolean
  shifts: ShiftItem[]
  clock: ClockItem[]
  perf: PerfItem[]
  train: TrainItem[]
  rev?: number | string
  generated_at?: string
}

/* 预订模块 GET /api/modules/booking?date= */
export interface BookingItem {
  id?: string
  time?: string
  name?: string
  guest_name?: string
  people?: number
  party_size?: number
  phone?: string
  table_type?: string
  table_id?: string
  status?: string
  date?: string
  [k: string]: unknown
}
export interface QueueItem {
  no?: string | number
  queue_no?: string | number
  people?: number
  party_size?: number
  status?: string
  [k: string]: unknown
}
export interface BookingResp {
  ok: boolean
  date: string
  bookings: BookingItem[]
  queue: QueueItem[]
  rev?: number | string
  generated_at?: string
}

/* 食安模块 GET /api/modules/foodsafe */
export interface CertItem {
  /** 健康证 / 店铺证照类型 */
  type?: string
  cert_type?: string
  name?: string
  holder?: string
  staff?: string
  expire?: string
  expire_at?: string
  expiry?: string
  /** 剩余天数（mock 或前端推算） */
  expire_days?: number
  status?: string
  [k: string]: unknown
}
export interface TraceItem {
  batch?: string
  batch_no?: string
  ing?: string
  ing_name?: string
  vendor?: string
  supplier?: string
  result?: string
  check_result?: string
  [k: string]: unknown
}
export interface SampleItem {
  dish?: string
  weight?: number
  weight_g?: number
  ts?: string
  kept_at?: string
  /** 距 48h 到期剩余小时（BFF 附加） */
  hours_left?: number | null
  meal?: string
  [k: string]: unknown
}
export interface DisinfectItem {
  area?: string
  ts?: string
  operator?: string
  pass?: boolean
  result?: string
  method?: string
  [k: string]: unknown
}
export interface FoodsafeResp {
  ok: boolean
  certs: CertItem[]
  trace: TraceItem[]
  samples: SampleItem[]
  disinfect: DisinfectItem[]
  rev?: number | string
  generated_at?: string
}

/* 分析模块 GET /api/modules/analysis（与 App/KMP 同源） */
export interface AnalysisForecastRestock {
  ingredientId?: string
  name?: string
  unit?: string
  qty?: number
  pred?: number
  cons?: number
  opt?: number
  amount?: number
  badge?: string
  reason?: string
}
export interface AnalysisForecast {
  confidence?: number
  note?: string
  days?: Array<{ date?: string; pred?: number; opt?: number; cons?: number }>
  restock?: AnalysisForecastRestock[]
  holidays?: Array<{ label?: string; effect?: string }>
}
export interface AnalysisResp {
  ok: boolean
  rev?: number | string
  trend?: Array<Record<string, unknown>>
  heatmap?: Array<Record<string, unknown>>
  matrix?: Array<Record<string, unknown>>
  efficiency?: Record<string, unknown>
  forecast?: AnalysisForecast | null
  baoben_summary?: Record<string, unknown> | null
  baoben_types?: Array<Record<string, unknown>> | null
  mock?: boolean
  note?: string
}

/* 设备 GET /api/modules/equipment */
export interface EquipmentTemp {
  device?: string
  kind?: string
  temp?: number
  max?: number
  status?: string
  minutes?: number
  history?: number[]
}
export interface EquipmentResp {
  ok: boolean
  rev?: number | string
  temps?: EquipmentTemp[]
  maintain?: Array<Record<string, unknown>>
  energy?: Array<Record<string, unknown>>
  energy_summary?: {
    mock?: boolean
    items?: Array<{ kind?: string; amount?: number; pct?: number }>
    total?: number
    yoy?: string | null
    mom?: string | null
  } | null
  mock_temps?: boolean
}

/* 会员 GET /api/modules/vip */
export interface VipMember {
  member_id?: string
  name?: string
  phone?: string
  level?: string
  balance?: number
  status?: string
  birthday?: string | null
  birthday_soon?: boolean
}
export interface VipResp {
  ok: boolean
  rev?: number | string
  members?: VipMember[]
  coupons?: Array<Record<string, unknown>>
}

/* AI 审计 GET /api/admin/kimi-log?limit= */
export interface KimiLogItem {
  ts?: string
  trace_id?: string
  type?: string
  model?: string
  dt_ms?: number
  latency_ms?: number
  /** 是否降级（模型回退/非流式降级） */
  degraded?: boolean
  ok?: boolean
  status?: number
}

/* 请求审计 GET /api/admin/audit?limit= */
export interface AuditItem {
  ts: string
  trace_id?: string
  method: string
  path: string
  role?: string
  status: number
  dt_ms?: number
}
