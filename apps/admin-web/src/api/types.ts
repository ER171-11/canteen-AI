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
  /** 运行环境：real（真实库）| sandbox（演练库）；由 BFF 依据 CANTEEN_ENV 透出 */
  env?: string
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
/** FP-DASH-11 低库存预警明细行（旧版 #lowStockBox，HTML:1280-1285） */
export interface LowStockItem {
  id?: string | null
  name?: string
  cat?: string
  unit?: string
  /** 现存 */
  qty?: number
  /** 安全线 */
  safe?: number
}

export interface ReportDaily {
  ok?: boolean
  mock?: boolean
  date: string
  /** FP-DASH-01 统计周期：'1'=当日（程序化调用沿用旧行为）| '7' | '30' | 'all'（旧版 DASH_R，HTML:1221） */
  range?: string
  /** 区间文字（旧版 rangeLabel，HTML:1223） */
  range_label?: string
  range_from?: string | null
  range_to?: string
  /** FP-DASH-11 低库存预警明细：total 为总种数，前端按 12 条截断并给「等 N 种」提示 */
  low_stock?: { total?: number; items?: LowStockItem[] }
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

/** 审批中心动作状态（BFF 实际下发集合：queued 为入队初态英文遗留，其余中文） */
export type ActionStatus = 'queued' | '待执行' | '已执行' | '已驳回' | '已过期'

/** GET /api/actions 列表项 */
export interface ActionItem {
  id: string
  type: string
  title?: string
  /** 后端下发的状态字符串（以 ActionStatus 为准，| string 兜底未知态） */
  status: ActionStatus | string
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
  /** 近 30 天销量（BFF /api/admin/dishes 聚合，FP-DISH-11） */
  q30?: number
  /** 近 30 天毛利额（= 近30天营收 − 每份成本×近30天销量，FP-DISH-12） */
  gp30?: number
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

/* ---------------- 食安点位主数据（巡检 / 消毒 统一事实来源） ---------------- */

export type SafetyPointKind = 'inspection' | 'disinfect'

/** fs_points 行结构：巡检点与消毒点共用，按 kind 区分 */
export interface SafetyPoint {
  id: string
  name: string
  zone: string
  kind: SafetyPointKind
  /** 1=需每 30 分钟记录（仅巡检卫生间类） */
  every30: number
  demo_image_key: string | null
  demo_image_url: string | null
  /** 1=启用；0=逻辑删除 */
  enabled: number
  sort: number
  note: string | null
}

/** GET /api/safety/points */
export interface SafetyPointsResp {
  ok: boolean
  kind: SafetyPointKind
  points: SafetyPoint[]
  count?: number
  rev: number | string | null
  /** true=当前展示内置默认点位（尚无自定义点位） */
  using_defaults: boolean
  /** 对象存储是否可用（false 时演示图降级） */
  configured: boolean
}

/** POST /api/safety/points */
export interface SafetyPointUpsertBody {
  id?: string
  name: string
  zone?: string
  kind: SafetyPointKind
  every30?: number
  demo_image_key?: string | null
  demo_image_url?: string | null
  sort?: number
  note?: string | null
}

/** 点位写操作统一回执（入队） */
export interface SafetyPointEnqueueResp {
  ok: boolean
  action_id?: string
  status?: string
  rev?: number | string | null
  dedup?: boolean
  note?: string
  error?: string
}

/** POST /api/safety/points/presign — 演示图上传预签名 */
export interface SafetyPointPresignResp {
  ok: boolean
  configured: boolean
  key: string | null
  method?: 'PUT'
  upload_url: string | null
  headers?: Record<string, string>
  expires_in?: number
  photo_url?: string | null
  public_base?: boolean
  missing?: string[]
  note?: string
}

/** POST /api/safety/points/sign — 私有 bucket 读图 */
export interface SafetyPointSignResp {
  ok: boolean
  configured: boolean
  items: { key: string; url: string | null; public_url: string | null }[]
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
  /** 出成率（毛料→净料，0.05~1 的分数，缺省 1 = 无损耗） */
  yld?: number
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
  /** 销量占比（五类角色卡片；旧版 renderCalcTypes totQ 口径，HTML:3987） */
  qty_share?: number
  rev_share?: number
  gp_share?: number
}

/** 逐菜结构表行（GET /api/modules/analysis 的 `calc_dishes`；对齐旧版 SD） */
export interface BaobenDishRow {
  /** 菜品 id（模拟态按 id 定位；无 id 时后端回落菜名） */
  id?: string
  /** 菜品名称 */
  name: string
  /** 类型（引流/爆品/利润/形象/常规） */
  cat?: string | null
  /** 食材成本（元/份） */
  cost?: number | null
  /** 售价（元/份） */
  price?: number | null
  /** 日销量（份/天，按当前口径：估算 q / 近30天真实日均 / 近7天真实日均，见 FP-CALC-08） */
  qty?: number | null
  /** 菜品主数据估算日销（旧版 `est`，用于回落与提示） */
  est?: number
  /** 近 N 天真实销售总份数（旧版 `sq`；估算口径恒 0） */
  sq?: number
  /** 日销量来源：`real` 真实销量 / `est` 估算值（旧版 `src`） */
  src?: 'real' | 'est'
  /** 是否上架（模拟态可取消勾选模拟下架；后端已按真实下架滤除） */
  on?: boolean
}

/** 结构测算模拟态行覆盖（POST /api/modules/analysis/sim 的 `rows`，按菜名或菜品 id） */
export interface CalcSimRowOverride {
  /** 食材成本（元/份） */
  c?: number
  /** 售价（元/份） */
  p?: number
  /** 日销量（份/天） */
  q?: number
  /** 是否上架（false = 模拟下架） */
  on?: boolean
}

/** 日销量口径（照抄旧版 `SC_QMODES`） */
export type CalcQMode = 'est' | 'real30' | 'real7'

/** POST /api/modules/analysis/sim —— 只读推演（不落库、不入队，见 ADR-007） */
export interface AnalysisSimResp {
  ok: boolean
  sim?: boolean
  rev?: number | string | null
  /** 基准行集标识：`shop_dishes` = 本店在售菜品（旧版 calcModel 的 SD 口径） */
  basis?: string | null
  qmode?: CalcQMode
  qmode_label?: string
  qfallback?: boolean
  qdays?: number
  baoben_summary?: BaobenSummary | null
  calc_dishes?: BaobenDishRow[] | null
  /** 口径提示计数 */
  qstat?: { n_total?: number; n_active?: number; n_real?: number; n_fallback?: number } | null
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

/* ---------------- M2 排班员工：/api/staff/* ---------------- */

/** GET /api/staff/schedule */
export interface StaffScheduleRow {
  staff_id?: string | null
  staff_name: string
  role?: string | null
  /** date(YYYY-MM-DD) → A/B/C/休 */
  cells: Record<string, string>
  hours: number
  days: number
}
export interface StaffScheduleResp {
  ok: boolean
  week_start: string
  days: string[]
  staff: StaffScheduleRow[]
  totals: { people: number; hours: number; shifts: number }
}

/** GET /api/staff/clock */
export interface AttendanceRow {
  staff_id: string | null
  staff_name: string
  role?: string | null
  shift?: string | null
  start_time?: string | null
  end_time?: string | null
  clock_ts?: string | null
  clock_kind?: string | null
  makeup: boolean
  late_min?: number | null
  /** 准点 / 迟到 N 分 / 缺勤 / 补录 */
  status: string
}
export interface StaffClockResp {
  ok: boolean
  date: string
  expected: number
  clocked: number
  on_time: number
  late: number
  absent: number
  makeup: number
  thresholds: { late_min: number; absent_min: number }
  rows: AttendanceRow[]
  rev?: number | string | null
}

/** GET /api/staff/perf */
export interface StaffPerfRow {
  rank: number
  staff_id: string | null
  staff_name: string
  score: number
  hours: number
  remark: string | null
}
export interface StaffPerfResp {
  ok: boolean
  perf: StaffPerfRow[]
  rev?: number | string | null
}

/** GET /api/staff/train */
export interface CertAlert {
  staff_name: string
  expire_at: string | null
  days_left: number | null
  level: 'red' | 'warn' | 'ok' | 'unknown'
  blocked: boolean
}
export interface TrainCourse {
  course: string
  done: number
  total: number
  pct: number
  passed: boolean
  last_ts: string | null
}
export interface StaffTrainProgress {
  staff_id: string
  staff_name: string | null
  courses: TrainCourse[]
  gated_skus: string[]
  blocked_skus: string[]
  blocked?: boolean
}
export interface StaffTrainResp {
  ok: boolean
  sop_total: number
  train: TrainItem[]
  progress: StaffTrainProgress[]
  certs: CertAlert[]
  summary: {
    staff: number
    cert_red: number
    cert_warn: number
    blocked_staff: number
    gated_skus: number
  }
  skill_matrix: Record<string, string>
  uniform: TrainItem[]
  rev?: number | string | null
}

/** /api/staff/swaps */
export type SwapStatus = 'pending_peer' | 'pending_manager' | 'applied' | 'rejected'
export interface SwapItem {
  id: string
  date: string
  shift: string
  shift_start?: string | null
  shift_end?: string | null
  shift_role?: string | null
  from_staff: string
  from_name?: string | null
  to_staff: string
  to_name?: string | null
  reason?: string | null
  status: SwapStatus
  requested_by?: string | null
  peer_by?: string | null
  peer_at?: string | null
  approved_by?: string | null
  approved_at?: string | null
  rejected_by?: string | null
  rejected_at?: string | null
  reject_reason?: string | null
  created_at?: string
  updated_at?: string
  base_rev?: number | string | null
  applied_rev?: number | string | null
  write_actions?: string[]
}
export interface SwapResp {
  ok: boolean
  swap?: SwapItem
  items?: SwapItem[]
  count?: number
  write_actions?: string[]
  error?: string
  expected_rev?: number | string | null
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

/* ============ 食安模块 v2 GET/POST /api/foodsafe/* （M4 后场） ============ */

/** 证照临期分级：逾期禁营 / 红 / 橙 / 黄 / 绿 / 未知 */
export type CertLevel = 'expired' | 'red' | 'orange' | 'yellow' | 'green' | 'unknown'
export type CertKind = 'health' | 'store'

export interface CertRow {
  id: string | number | null
  type: string
  holder: string
  cert_no?: string | null
  issued_at?: string | null
  expire_at?: string | null
  status?: string | null
  days: number | null
  level: CertLevel
  kind: CertKind
  /** 健康证逾期/红 → 排班禁岗 */
  blocked: boolean
  /** 店铺证照逾期 → 停业风险 */
  store_risk: boolean
}

export interface CertThresholds {
  block: number
  red: number
  orange: number
  yellow: number
}

export interface FoodsafeCertsResp {
  ok: boolean
  rev?: number | string | null
  rows: CertRow[]
  counts: Record<string, number>
  thresholds: CertThresholds
  health_blocked: string[]
  store_risks: CertRow[]
  store_stop_risk: boolean
  advice: string[]
}

export interface CertConfigResp {
  ok: boolean
  cert: CertThresholds
  defaults: CertThresholds
  config?: { cert?: CertThresholds } | null
  rev?: number | string | null
}

/** Kimi 证照识别返回的结构化字段 */
export interface CertRecognizeFields {
  cert_type: string
  holder: string
  cert_no: string
  issued_at: string
  expire_at: string
  status: string
}

export interface KimiVisionResult {
  title: string
  rows: [string, string, string][]
  note: string
  cta: string
  conf: string
  fields?: CertRecognizeFields | null
}

export interface KimiVisionResp {
  ok: boolean
  result?: KimiVisionResult
  model?: string
  traceId?: string
  error?: string
}

export interface TraceRow {
  id: string | number | null
  batch_no: string
  ing_name: string
  supplier: string
  recv_date?: string | null
  origin?: string | null
  cert_no?: string | null
  check_result?: string | null
  /** 缺检验报告/合格证 → 前端标「待补」(黄) */
  missing_cert: boolean
}

export interface TraceDrill {
  recv: Record<string, unknown>[]
  sales: Record<string, unknown>[]
  need_cert: boolean
  note: string
}

export interface TraceResp {
  ok: boolean
  rev?: number | string | null
  rows: TraceRow[]
  batches: number
  missing_cert: number
  advice: string[]
  sales_source?: string
  query?: string
  batch?: TraceRow | null
  matches?: number
  drill?: TraceDrill
}

export type WeightLevel = 'pass' | 'warn' | 'fail' | 'unknown'
export type SampleLevel = 'green' | 'yellow' | 'red' | 'done' | 'unknown'
export type SampleTempLevel = 'ok' | 'out' | 'unknown'

export interface SampleRow {
  id: string | number | null
  date?: string | null
  meal?: string | null
  dish: string
  keeper?: string | null
  weight_g: number
  need_g: number
  weight_ok: boolean
  weight_level: WeightLevel
  short_g: number
  kept_at: string | null
  due_at: string | null
  hours_left: number | null
  elapsed_h: number | null
  status: string
  level: SampleLevel
  cleared_at?: string | null
  hold_temp?: number | null
  sealed_by?: string | null
  temp_level?: SampleTempLevel
}

export interface SampleReminder {
  id: string | number | null
  dish: string
  level: string
  text: string
}

export interface SampleSummary {
  total: number
  pending: number
  due_soon: number
  expired: number
  cleared: number
  under_weight: number
  temp_out: number
}

export interface FoodsafeSamplesResp {
  ok: boolean
  rev?: number | string | null
  hold_hours: number
  warn_hours: number
  weight_rule: Record<string, number>
  temp_range?: { min: number; max: number }
  auto_archive_conf: number
  rows: SampleRow[]
  summary: SampleSummary
  reminders: SampleReminder[]
}

export interface DisinfectDay {
  date: string
  records: number
  done_areas: string[]
  missed: string[]
  rate: number | null
}

export interface DisinfectState {
  area: string
  state: string
  overdue: boolean
}

export interface DisinfectResp {
  ok: boolean
  rev?: number | string | null
  areas: string[]
  span: string[]
  days: DisinfectDay[]
  avg_rate: number | null
  today_done: number
  today_missed: string[]
  pending: DisinfectState[]
  overdue: DisinfectState[]
}

export interface FoodsafeAlert {
  level: string
  text: string
}

export interface FoodsafeOverviewResp {
  ok: boolean
  rev?: number | string | null
  certs: {
    counts: Record<string, number>
    health_blocked: string[]
    store_risks: number
    store_stop_risk: boolean
    thresholds: CertThresholds
  }
  samples: SampleSummary
  disinfect: {
    areas: number
    today_done: number
    today_missed: string[]
    avg_rate: number | null
  }
  trace: { batches: number; missing_cert: number }
  alerts: FoodsafeAlert[]
}

/** 写操作统一回执（入队动作 / Kimi 待复核 / 克重 422 拦截） */
export interface FoodsafeEnqueueResp {
  ok: boolean
  action_id?: string
  rev?: number | string | null
  note?: string
  error?: string
  /** Kimi 入档结果 */
  archived?: boolean
  review?: boolean
  conf?: number | null
  threshold?: number
  source?: string
  reason?: string
  /** 留样克重回执 */
  weight_level?: WeightLevel
  need_g?: number
  weight_g?: number
  dish?: string
  rule?: string
  due_at?: string
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
  /** 基准行集标识：缺省/`menu_baoben` = 保本价盘整表；`shop_dishes` = 本店在售菜品（模拟态，见 ADR-007） */
  basis?: string
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

/* ---------------- 设备 M8 /api/equipment/*（后场：GET 只读聚合 + POST 入队） ---------------- */

export type TempLevel = 'critical' | 'over' | 'warn' | 'ok' | 'unknown'
export interface EquipmentTempRow {
  device: string
  kind: string
  temp: number | null
  max: number
  minutes?: number
  history?: number[]
  margin?: number | null
  level: TempLevel
  status: string
  over: boolean
}
export interface EquipmentTempsResp {
  ok: boolean
  rev?: number | string | null
  rows: EquipmentTempRow[]
  counts: Record<string, number>
  over: number
  alerts: Array<{ device: string; kind: string; level: string; text: string }>
  advice: string[]
  limits: Record<string, number>
  mock?: boolean
}

export type MaintainLevel = 'overdue' | 'due_soon' | 'ok' | 'unknown'
export interface MaintainPlanRow {
  device: string
  kind: string
  last_ts: string | null
  operator: string | null
  next_due: string | null
  days_left: number | null
  level: MaintainLevel
  count: number
  total_cost: number
}
export interface MaintainRecordRow {
  id: number | null
  device: string
  kind: string
  ts: string | null
  operator: string | null
  cost: number | null
  next_due: string | null
  note: string | null
}
export interface EquipmentMaintainResp {
  ok: boolean
  rev?: number | string | null
  rows: MaintainRecordRow[]
  devices: MaintainPlanRow[]
  counts: Record<string, number>
  interval_d: number
  due_soon_d: number
  advice: string[]
}

export interface EnergyRow {
  id: number | null
  date: string | null
  device: string
  kind: string
  reading: number | null
  usage: number | null
}
export interface EquipmentEnergyResp {
  ok: boolean
  rev?: number | string | null
  rows: EnergyRow[]
  items: Array<{ kind: string; amount: number; pct: number }>
  total: number
  revenue: number
  ratio: number | null
  budget: number
  over_budget: boolean
  mock: boolean
  advice: string[]
}

export interface EquipmentOverviewResp {
  ok: boolean
  rev?: number | string | null
  temps: { total: number; over: number; counts: Record<string, number> }
  maintain: { counts: Record<string, number>; interval_d: number }
  energy: { total: number; budget: number; ratio: number | null; over_budget: boolean; mock: boolean }
  alerts: Array<{ level: string; text: string }>
  advice: string[]
}

export interface EquipmentConfigResp {
  ok: boolean
  equipment: {
    temps: Record<string, number>
    warn_margin: number
    over_alert_min: number
    maintain_interval_d: number
    maintain_due_soon_d: number
    energy_budget: number
  }
  defaults?: Record<string, unknown>
  rev?: number | string | null
}

export interface EquipmentEnqueueResp {
  ok: boolean
  action_id?: string
  rev?: number | string | null
  note?: string
  error?: string
  level?: string
  over?: boolean
}

/* ---------------- 财务 M9 /api/finance/*（后场：GET 只读聚合 + POST 入队） ---------------- */

export interface InvoiceRow {
  id: number | null
  invoice_no: string | null
  kind: string
  direction: string
  amount: number
  tax: number | null
  status: string
  ts: string | null
}
export interface FinanceInvoicesResp {
  ok: boolean
  rev?: number | string | null
  rows: InvoiceRow[]
  count: number
  by_direction: Record<string, number>
  by_kind: Record<string, number>
  month: string
  issued_this_month: number
  quota: number
  remaining: number
  usage_pct: number | null
  advice: string[]
}

export interface TaxRow {
  id: number | null
  period: string
  kind: string
  amount: number
  status: string
  filed_at: string | null
  filed: boolean
  overdue: boolean
  deadline: string | null
  days_left: number | null
}
export interface FinanceTaxResp {
  ok: boolean
  rev?: number | string | null
  rows: TaxRow[]
  pending: TaxRow[]
  pending_count: number
  payable: number
  by_kind: Record<string, number>
  counts: { filed: number; pending: number; overdue: number }
  deadline_day: number
  advice: string[]
}

export interface CashRow {
  id: number | null
  ts: string | null
  kind: string
  amount: number
  account: string
  note: string | null
}
export interface FinanceCashflowResp {
  ok: boolean
  rev?: number | string | null
  rows: CashRow[]
  income: number
  expense: number
  net: number
  by_account: Record<string, { income: number; expense: number }>
  by_kind: Record<string, number>
  advice: string[]
}

export interface SplitRow {
  id: number | null
  period: string | null
  party: string
  amount: number
  ratio: number | null
  frozen_until: string | null
  status: string
  frozen: boolean
  days_left: number | null
  can_release: boolean
}
export interface FinanceSplitResp {
  ok: boolean
  rev?: number | string | null
  rows: SplitRow[]
  counts: { frozen: number; settled: number; releasable: number }
  frozen_count: number
  frozen_amount: number
  frozen_until: string | null
  releasable: Array<{ id: number | null; party: string; amount: number }>
  advice: string[]
}

export interface FinanceOverviewResp {
  ok: boolean
  rev?: number | string | null
  invoices: { count: number; issued_this_month: number; quota: number; remaining: number; usage_pct: number | null }
  tax: { pending_count: number; payable: number; overdue: number }
  cashflow: { income: number; expense: number; net: number }
  split: { frozen_count: number; frozen_amount: number; releasable: number }
  alerts: Array<{ level: string; text: string }>
  advice: string[]
}

export interface FinanceConfigResp {
  ok: boolean
  finance: { invoice_quota_monthly: number; split_frozen_days: number; tax_deadline_day: number }
  defaults?: Record<string, unknown>
  rev?: number | string | null
}

export interface FinanceEnqueueResp {
  ok: boolean
  action_id?: string
  rev?: number | string | null
  note?: string
  error?: string
}

/* ---------------- 供应链 M10 /api/supply/*（后场：GET 只读聚合 + POST 入队） ---------------- */

export interface SupplyVendorRow {
  id: string | number | null
  name: string
  category: string
  status: string
  period: string
  level: number | null
  contact: string | null
  phone: string | null
}
export interface SupplyVendorsResp {
  ok: boolean
  rev?: number | string | null
  rows: SupplyVendorRow[]
  count: number
  by_category: Record<string, number>
  by_status: Record<string, number>
  by_period: Record<string, number>
  low_rated: string[]
  advice: string[]
}

export interface SupplyQuote {
  ing: string
  src: string
  price: number
  unit: string | null
  date: string | null
}
export interface SupplyCompareRow {
  name: string
  candidates: number
  best: { src: string; price: number }
  worst: { src: string; price: number }
  spread_pct: number | null
  quotes: SupplyQuote[]
}
export interface SupplyCompareResp {
  ok: boolean
  rev?: number | string | null
  available: number
  rows: SupplyCompareRow[]
  spread_top: SupplyCompareRow[]
  warn_pct: number
  advice: string[]
}

export interface SupplyAccountRow {
  id: number | null
  supplier: string
  balance: number
  kind: string
  due: string | null
  status: string
}
export interface SupplyAccountsResp {
  ok: boolean
  rev?: number | string | null
  rows: SupplyAccountRow[]
  count: number
  payable: number
  aging: { current: number; over30: number; over60: number; overdue: number }
  need_settle: number
  overdue_list: Array<{ supplier: string; balance: number; due: string | null; status: string; bucket: string }>
  over30_d: number
  over60_d: number
  advice: string[]
}

export interface SupplyOverviewResp {
  ok: boolean
  rev?: number | string | null
  vendors: { count: number; by_category: Record<string, number>; low_rated: number }
  compare: { available: number; top: { name: string; spread_pct: number | null; best: { src: string; price: number } } | null }
  accounts: { count: number; payable: number; aging: { current: number; over30: number; over60: number; overdue: number }; need_settle: number }
  alerts: Array<{ level: string; text: string }>
  advice: string[]
}

export interface SupplyConfigResp {
  ok: boolean
  supply: { spread_warn_pct: number; aging_over30_d: number; aging_over60_d: number; low_level: number }
  defaults?: Record<string, unknown>
  rev?: number | string | null
}

export interface SupplyEnqueueResp {
  ok: boolean
  action_id?: string
  rev?: number | string | null
  note?: string
  error?: string
}

/* ---------------- 原料比价 M13 /api/admin/price（FP-PRICE-01/02/03/13/14） ---------------- */

export interface PriceBest {
  src: string
  price: number
  per: string
  date: string
  unit: number
  note: string
}

export interface PriceReportRow {
  ingId: string
  name: string
  cat: string
  buy: string
  conv: number
  unit: string
  avg: number
  best: PriceBest | null
  diff: number | null
  savePct: number | null
  recent: Array<{ src: string; date: string }>
}

export interface PriceReport {
  rows: PriceReportRow[]
  tip: { onSale: number; noQuote: number; hasQuote: number }
}

export interface PricePlanItem {
  ingId: string
  name: string
  cat: string
  keyword: string
  buy: string
  conv: number
  unit: string
  avg: number
  status: '已比价' | '待比价'
}

export interface PricePlan {
  items: PricePlanItem[]
  onSale: number
}

export interface PriceResp {
  ok: boolean
  report: PriceReport
  plan: PricePlan
  rev?: number | string | null
}

/* ---------------- 损耗 M12 /api/loss/*（后场：GET 只读聚合 + POST 入队） ---------------- */

export interface LossRecordRow {
  id: number | null
  date: string | null
  name: string
  qty: number
  amount: number
  reason: string
}
export interface LossRecordsResp {
  ok: boolean
  rev?: number | string | null
  rows: LossRecordRow[]
  total_amount: number
  total_qty: number
  revenue: number
  loss_rate_pct: number | null
  by_reason_amount: Record<string, number>
  by_reason_qty: Record<string, number>
  top_ingredients: Array<{ name: string; amount: number }>
  top_share_pct: number | null
  warn_pct: number
  redline_pct: number
  advice: string[]
}

export interface LossReportRow {
  id: number | null
  date: string | null
  ing_name: string
  qty: number
  amount: number | null
  reason: string
  reporter: string | null
  status: string
}
export interface LossReportsResp {
  ok: boolean
  rev?: number | string | null
  rows: LossReportRow[]
  counts: { pending: number; approved: number; rejected: number; big_pending: number }
  big_amount: number
  advice: string[]
}

export interface LossInventoryRow {
  id: number | null
  date: string | null
  ing_name: string
  book_qty: number | null
  actual_qty: number | null
  diff: number
  note: string | null
}
export interface LossInventoryResp {
  ok: boolean
  rev?: number | string | null
  rows: LossInventoryRow[]
  diff_count: number
  loss_qty: number
  over_qty: number
  advice: string[]
}

export interface LossOverviewResp {
  ok: boolean
  rev?: number | string | null
  loss: { total_amount: number; loss_rate_pct: number | null; top_ingredient: { name: string; amount: number } | null; top_share_pct: number | null }
  reports: { pending: number; approved: number; rejected: number; big_pending: number }
  inventory: { diff_count: number; loss_qty: number; over_qty: number }
  alerts: Array<{ level: string; text: string }>
  advice: string[]
}

export interface LossConfigResp {
  ok: boolean
  loss: { loss_rate_warn: number; loss_rate_redline: number; big_amount: number; top_share_warn: number }
  defaults?: Record<string, unknown>
  rev?: number | string | null
}

export interface LossEnqueueResp {
  ok: boolean
  action_id?: string
  rev?: number | string | null
  note?: string
  error?: string
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
