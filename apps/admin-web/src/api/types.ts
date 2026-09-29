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
  key_loaded?: boolean
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
  /** 保本实况（代理A新增）：无此字段时前端回落 baoben_summary.kpi 静态价盘 */
  breakeven?: { be_day?: number; today_rev?: number; attain_pct?: number } | null
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
  /** 后端可能下发数组，也可能因 UI 保存把 face_main 落成纯字符串 */
  face_main?: BomEntry[] | string
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
  /** 逐步打卡状态（代理A新增）：key 为 step_no，未上线时页面回退旧高亮逻辑 */
  steps_state?: Record<string, { done_at?: string; operator?: string }>
  /** 实际出成（份），workorder.advance 到已完成时录入 */
  actual_yield?: number | null
  /** SOP 总步数（代理A下发，缺失时取 steps.length） */
  sop_total?: number
}

/** GET /api/kitchen/board?date= → yield_alerts 元素（代理A新增，形状前向兼容） */
export interface YieldAlert {
  workorder_id?: string
  id?: string
  sku_id?: string
  name?: string
  color?: string
  /** 理论出成（份） */
  expected_yield?: number
  actual_yield?: number
  deviation_pct?: number
  note?: string
  [k: string]: unknown
}

/** GET /api/kitchen/qc?date= → items 元素（A 块扩展字段） */
export interface QcRecord {
  id: string
  workorder_id?: string
  sku_id: string
  sample_weight?: number
  pass: boolean
  ts?: string
  source?: string
  /** A 块新增：结论文案 / 缺陷项 / 工序环节 / 责任人 / 照片引用 */
  name?: string
  check_type?: string
  result?: string
  note?: string
  inspector?: string
  rate?: number
  stage?: string
  operator?: string
  station?: string
  /** 缺陷项：后端以 JSON 字符串或数组形式下发，前端统一按 unknown 解析 */
  defect_items?: unknown
  conf?: number
  manual_review?: boolean
  photo_url?: string
  photo_key?: string
}

/** GET /api/qc/media/status — 品控图片可用性（未配置对象存储时标注「图片不可用」） */
export interface QcMediaStatus {
  ok: boolean
  configured: boolean
  missing?: string[]
  host?: string
  bucket?: string
  region?: string
  service?: string
  path_style?: boolean
  public_base?: boolean
  expire_sec?: number
}

/** 强制放行记录（qc.force_pass 入队，按需落库） */
export interface QcForcePass {
  id?: string
  workorder_id: string
  sku_id?: string
  reason: string
  operator?: string
  ts?: string
}

/** SOP 视频教材（后台绑定 video_url，不收视频字节） */
export interface SopVideo {
  id: string
  sku_id: string
  title: string
  video_url: string
  ts?: string
}

/** GET /api/modules/inspection → 巡检统筹看板 */
export interface InspectionBoardResp {
  ok: boolean
  date?: string
  updated_at?: string
  summary?: InspectionSummary
  boards: InspectionBoardProgress[]
  nodes: InspectionNode[]
  groups?: string[]
  records?: InspectionRecord[]
  every30?: InspectionEvery30
  hint?: string
  message?: string
}

export interface InspectionSummary {
  total: number
  done: number
  rate: number
}

export interface InspectionBoardProgress {
  board: string
  total: number
  done: number
  rate: number
  missing: string[]
}

export interface InspectionNode {
  id: string
  board: string
  name: string
  node_group?: string
  every30: boolean
}

export interface InspectionRecord {
  node_id: string
  operator?: string
  ts?: string
  done: boolean
  round?: number
}

export interface InspectionEvery30 {
  window_min: number
  rounds_total: number
  rounds_done: number
  rounds_missing: string[]
}

/** GET /api/kitchen/board?date= → items 元素（按五色分组） */
export interface KitchenBoardItem {
  color: string
  planned: number
  done: number
  qc_pass_rate?: number
}

/** GET /api/kitchen/board?date= 完整响应（代理A新增 yield_alerts，未上线时缺省） */
export interface KitchenBoardResp extends ListResp<KitchenBoardItem> {
  yield_alerts?: YieldAlert[]
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

/** 成本卡 BOM 行（均价口径动态成本） */
export interface CostCardLine {
  name: string
  qty_text?: string
  line_cost?: number
  /** 原料已建档且有均价 */
  matched?: boolean
}

/** GET /api/kitchen/recipes/{sku} → cost_card（代理A新增，未上线时为 null） */
export interface CostCard {
  bom_lines?: CostCardLine[]
  batch_cost?: number
  unit_cost?: number
  price?: number
  gross_margin?: number
  missing_ings?: string[]
}

export interface RecipeDetailResp {
  ok: boolean
  item: RecipeItem
  steps: SopStep[]
  cost_card?: CostCard | null
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
  /** 采购单位（结算单「单位」列用，旧版 ing.buy） */
  buy?: string
  /** 包规（如「25kg/袋」，旧版 ing.pack） */
  pack?: string
  /** 当前库存量 */
  stock?: number
  /** 安全库存线（可能为 0） */
  safe?: number
  /** 估算日均消耗（安全线兜底用，快照可能无此字段） */
  est?: number
  /** 均价（库存单位口径） */
  avg?: number
  /** 换算率：1 采购单位 = conv 库存单位（旧版 ing.conv，缺省 1） */
  conv?: number
  /** 最近一次进货价（元/采购单位，重建库存时回写；无进货记录为 0/缺失） */
  last?: number | null
  /** 是否启用（false = 停用，不参与补货/告急统计） */
  on?: boolean
  _u?: string
}

/* ---------------- 结算单（进货付款审批单） ---------------- */

/** 结算单模板：字段与旧版 DEF_SETTLE_TPL（旧 HTML:2088-2095）逐一对齐 */
export interface SettleTemplate {
  /** 单据标题，如「进货付款审批单」 */
  title: string
  /** 抬头单位名称；留空时回落餐厅名 */
  restName: string
  addr: string
  tel: string
  taxNo: string
  /** 支出用途默认值 */
  usePurpose: string
  payeeName: string
  payeeBank: string
  payeeAccount: string
  /** 签字栏，如 ['经办人','审核人','审批人'] */
  subjects: string[]
  footer: string
}

/** GET /api/settle/template */
export interface SettleTemplateResp {
  ok?: boolean
  template: SettleTemplate
  /** 'file' = 来自 bff/data/settle_template.json；'default' = 未配置，用默认 */
  source?: 'file' | 'default'
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

/* ---------------- 食材按标准验收（代理A契约，未上线时页面回落） ---------------- */

/** GET /api/inventory/accept-standards → standards 元素 */
export interface AcceptStandard {
  ing_name: string
  brand?: string
  /** 规格要求 */
  spec_req?: string
  /** 感官要求 */
  sensory?: string
  /** 重量容差 % */
  weight_tol_pct?: number
  /** 温度要求 */
  temp_req?: string
  /** 保质期要求 */
  shelf_life_req?: string
  /** 索证要求 */
  cert_req?: string
}

export interface AcceptStandardsResp {
  ok: boolean
  standards: AcceptStandard[]
}

/** GET /api/inventory/recv-accept?date= → 逐项验收记录 */
export interface RecvAcceptRecord {
  recv_id?: string
  ing_name?: string
  qty_ordered?: number
  qty_received?: number
  qty_rejected?: number
  /** pass / warn / fail（或中文 合格/让步/拒收） */
  verdict?: string
  /** JSON 字符串或对象，可能含 Kimi 验货 rows 明细 */
  detail?: string | Record<string, unknown> | null
  batch_no?: string
  cert_no?: string
  ts?: string
  source?: string
  [k: string]: unknown
}

export interface RecvAcceptResp {
  ok: boolean
  date?: string
  items?: RecvAcceptRecord[]
  records?: RecvAcceptRecord[]
}

/* ---------------- 经营分析（/api/modules/analysis） ---------------- */

/** 保本测算 KPI（静态价盘） */
export interface BaobenKpi {
  day_rev?: number
  day_cost?: number
  dish_cost_rate?: number
  all_cost_rate?: number
  var_rate?: number
  contribution_margin?: number
  fixed_month?: number
  /** 日保本额（元） */
  be_day?: number
  /** 保本客流（人/日） */
  be_guests?: number
  guests?: number
  avg_ticket?: number
  month_rev?: number
  /** 月利润预测（元） */
  month_profit?: number
  /** 安全边际（%） */
  safety?: number
  rent?: number
  labor?: number
  amort?: number
  /** 物业费（月，元） */
  prop?: number
  /** 能耗固定部分（月，元） */
  util_fix?: number
  /** 其他固定费用（月，元） */
  other?: number
  /** 食材+酒水成本（月，元） */
  cost_bev_month?: number
  /** 其他变动成本（月，元） */
  var_other_month?: number
  /** 日均点菜份数（份） */
  dish_qty?: number
}

/** 客流情景（爬坡/培育/当前/稳定/成熟） */
export interface BaobenScene {
  name?: string
  /** 客流系数（1.00 = 当前菜品销量设定） */
  k?: number
  day_rev?: number
  /** 日客流（人） */
  guests?: number
  /** 月营收（元） */
  month_rev?: number
  month_profit?: number
  /** 日营收是否已达保本线 */
  above_be?: boolean
}

/** 菜品类型营收/毛利占比（保本价盘口径） */
export interface BaobenType {
  k?: string
  name?: string
  desc?: string
  n?: number
  qty?: number
  rev?: number
  cost?: number
  gp?: number
  cost_rate?: number
  rev_share?: number
  gp_share?: number
}

/** 逐菜结构表行（GET /api/modules/analysis 的 `calc_dishes`；对齐旧版 SD） */
export interface BaobenDishRow {
  /** 菜品名称 */
  name: string
  /** 类型（引流/爆品/利润/形象/常规） */
  cat?: string | null
  /** 食材成本（元/份） */
  cost?: number | null
  /** 售价（元/份） */
  price?: number | null
  /** 日销量（份/天，估算口径；真实销量口径切换见 FP-CALC-08） */
  qty?: number | null
  /** 是否上架（后端已按下架滤除，保留字段供后续模拟态使用） */
  on?: boolean
}

/** 菜品矩阵行（四象限） */
export interface MatrixRow {
  name: string
  price?: number
  volume?: number
  /** 毛利率 0-1 */
  margin?: number
  quadrant?: 'star' | 'puzzle' | 'cow' | 'dog' | string
  dish_type?: string
}

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
export interface AnalysisTrendRow {
  date?: string
  week?: string
  revenue?: number
  orders?: number
  gross_rate?: number
}
/**
 * 生效店参回显（键名与 `/api/modules/analysis` 的 query 同名，
 * 由 `bff/lib/menu_baoben.js` 的 PARAM_QUERY_MAP 单一定义）
 */
export interface BaobenParams {
  area?: number
  rent_psm?: number
  prop_fee?: number
  staff?: number
  labor_per?: number
  fit?: number
  fit_m?: number
  eq?: number
  eq_m?: number
  util_fix?: number
  other?: number
  bev_ratio?: number
  bev_cost?: number
  pack?: number
  takeout?: number
  comm?: number
  mkt?: number
  util_var?: number
  misc?: number
  fee?: number
  dish_per_guest?: number
  days?: number
  seats?: number
  target_profit?: number
}
export interface BaobenSummary {
  brand?: string
  source?: string
  count?: number
  params?: BaobenParams
  kpi?: BaobenKpi
  types?: BaobenType[]
  scenes?: BaobenScene[]
  advice?: string[]
}
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
  trend?: AnalysisTrendRow[]
  heatmap?: Array<Record<string, unknown>>
  matrix?: MatrixRow[]
  efficiency?: Record<string, unknown>
  forecast?: AnalysisForecast | null
  baoben_summary?: BaobenSummary | null
  baoben_types?: Array<Record<string, unknown>> | null
  /** 逐菜结构表行（只读；见基线 FP-CALC-09/10） */
  calc_dishes?: BaobenDishRow[] | null
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

/** GET /api/app/release — Android 安装包分发包元信息（供「App 下载」页） */
export interface AppRelease {
  ok: boolean
  available: boolean
  applicationId?: string | null
  versionName?: string | null
  versionCode?: number | null
  minSdk?: number | null
  variant?: string | null
  file?: string | null
  size?: number | null
  sizeText?: string | null
  sha256?: string | null
  builtAt?: string | null
  downloadPath?: string
  lan?: { port?: number; ips?: string[]; urls?: string[] }
  note?: string | null
  error?: string | null
}
