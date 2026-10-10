import axios from 'axios'
import { client } from './client'
import type {
  AcceptStandardsResp,
  ActionItem,
  ActionStatus,
  AnalysisResp,
  AnalysisSimResp,
  AppRelease,
  BaobenParams,
  BookingResp,
  CalcQMode,
  CalcSimRowOverride,
  CertConfigResp,
  CertThresholds,
  Dish,
  DisinfectResp,
  EquipmentEnergyResp,
  EquipmentEnqueueResp,
  EquipmentConfigResp,
  EquipmentMaintainResp,
  EquipmentOverviewResp,
  EquipmentTempsResp,
  FinanceCashflowResp,
  FinanceConfigResp,
  FinanceEnqueueResp,
  FinanceInvoicesResp,
  FinanceOverviewResp,
  FinanceSplitResp,
  FinanceTaxResp,
  FoodsafeCertsResp,
  LossConfigResp,
  LossEnqueueResp,
  LossInventoryResp,
  LossOverviewResp,
  LossRecordsResp,
  LossReportsResp,
  SupplyAccountsResp,
  SupplyCompareResp,
  SupplyConfigResp,
  SupplyEnqueueResp,
  SupplyOverviewResp,
  SupplyVendorsResp,
  FoodsafeEnqueueResp,
  FoodsafeOverviewResp,
  FoodsafeResp,
  FoodsafeSamplesResp,
  Health,
  KitchenBoardResp,
  ListResp,
  LoginRequest,
  LoginResponse,
  QcRecord,
  QcMediaStatus,
  SopVideo,
  InspectionBoardResp,
  RecipeDetailResp,
  RecipesResp,
  RecvAcceptRecord,
  RecvAcceptResp,
  ReportDaily,
  SettleTemplate,
  SettleTemplateResp,
  Snapshot,
  StaffModuleResp,
  StaffScheduleResp,
  StaffClockResp,
  StaffPerfResp,
  StaffTrainResp,
  SwapResp,
  TraceResp,
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
/** FP-DASH-01：range = '7' | '30' | 'all'，不传则由 BFF 取默认（30） */
export async function fetchReportDaily(date?: string, range?: string): Promise<ReportDaily> {
  const params: Record<string, string> = {}
  if (date) params.date = date
  if (range) params.range = range
  const { data } = await client.get<ReportDaily>('/report/daily', {
    params: Object.keys(params).length ? params : undefined,
  })
  return data
}

/** GET /api/snapshot/latest */
export async function fetchSnapshot(): Promise<Snapshot> {
  const { data } = await client.get<Snapshot>('/snapshot/latest')
  return data
}

/**
 * 经营分析店参（只读测算层，不落库）。
 * 键名与 `bff/lib/menu_baoben.js` 的 PARAM_QUERY_MAP 一一对应；未给值的键由后端 DEFAULT_PARAMS 兜底。
 */
export type AnalysisParams = BaobenParams

/** GET /api/modules/analysis?area=&rent_psm=&…&target_profit= */
export async function fetchAnalysis(params?: AnalysisParams): Promise<AnalysisResp> {
  const { data } = await client.get<AnalysisResp>('/modules/analysis', {
    params: params && Object.keys(params).length ? params : undefined,
  })
  return data
}

/** 结构测算模拟态入参（`rows` 按菜名或菜品 id 覆盖 c/p/q/on） */
export interface AnalysisSimParams {
  params?: AnalysisParams
  qmode?: CalcQMode
  qfallback?: boolean
  rows?: Record<string, CalcSimRowOverride>
}

/**
 * POST /api/modules/analysis/sim —— 结构测算「模拟态」只读推演。
 *
 * 后端零写库：不落库、不入队、不写菜品主数据（见 `docs/decisions/ADR-007-结构测算模拟层只读推演.md`）。
 * 基准行集 = 本店在售菜品（旧版 `calcModel()` 的 `SD` 口径），与基线 `fetchAnalysis()` 的保本价盘口径不同，
 * 故响应里带 `basis`，页面对模拟态必须挂口径徽标。
 */
export async function simulateAnalysis(body: AnalysisSimParams): Promise<AnalysisSimResp> {
  const { data } = await client.post<AnalysisSimResp>('/modules/analysis/sim', body)
  return data
}

/* ------------------------------------------------------------------ */
/* docx M1 经营分析只读端点（/api/analysis/*，零写库）                 */
/* ------------------------------------------------------------------ */
export interface AnalysisTrendPoint {
  date: string
  revenue: number
  orders: number
}
export interface AnalysisHeatPoint {
  hour: number
  weekday: number
  orders: number
  revenue: number
}
export interface AnalysisMatrixRow {
  id: string | null
  dish_id: string | null
  name: string
  price: number | null
  volume: number
  margin: number
  quadrant: string
  dish_type: string | null
}
export interface AnalysisEfficiency {
  avg_ticket: number
  daily_avg_revenue: number
  total_orders: number
  days: number
  peak_hour: number | null
  peak_weekday: number | null
  turnover: number | null
  revenue_per_sqm: number | null
  revenue_per_staff: number | null
  area: number | null
  staff: number | null
  seats: number | null
  tables: number | null
}
export interface AnalysisWeather {
  date: string
  city: string
  temp: number | null
  desc: string | null
  ttl_hours: number
  sample: boolean
  cached_at?: string
}
export interface AnalysisSuggestion {
  title: string
  content: string
  priority: string
}
export interface AnalysisSuggestionsResp {
  suggestions: AnalysisSuggestion[]
  weather_conclusion: string
  sample_weeks: number
  ai_generated: boolean
  note?: string
}

// 后端通用响应 {code,data,rev,msg} → 取 data
function unwrap<T>(resp: { code?: number; data?: T; rev?: number | string; msg?: string } | undefined): T | null {
  if (!resp) return null
  if (resp.data !== undefined) return resp.data
  return resp as unknown as T
}

/** GET /api/analysis/trend?start_date=&end_date= */
export async function fetchAnalysisTrend(start?: string, end?: string): Promise<AnalysisTrendPoint[]> {
  const { data } = await client.get('/analysis/trend', {
    params: start || end ? { start_date: start, end_date: end } : undefined,
  })
  return unwrap<AnalysisTrendPoint[]>(data) ?? []
}

/** GET /api/analysis/heat?date= */
export async function fetchAnalysisHeat(date?: string): Promise<AnalysisHeatPoint[]> {
  const { data } = await client.get('/analysis/heat', { params: date ? { date } : undefined })
  return unwrap<AnalysisHeatPoint[]>(data) ?? []
}

/** GET /api/analysis/matrix?date= */
export async function fetchAnalysisMatrix(date?: string): Promise<AnalysisMatrixRow[]> {
  const { data } = await client.get('/analysis/matrix', { params: date ? { date } : undefined })
  return unwrap<AnalysisMatrixRow[]>(data) ?? []
}

/** GET /api/analysis/efficiency?date= */
export async function fetchAnalysisEfficiency(date?: string): Promise<AnalysisEfficiency | null> {
  const { data } = await client.get('/analysis/efficiency', { params: date ? { date } : undefined })
  return unwrap<AnalysisEfficiency>(data) ?? null
}

/** GET /api/analysis/weather?date=&city= */
export async function fetchAnalysisWeather(date?: string, city?: string): Promise<AnalysisWeather | null> {
  const { data } = await client.get('/analysis/weather', {
    params: date || city ? { date, city } : undefined,
  })
  return unwrap<AnalysisWeather>(data) ?? null
}

/** POST /api/analysis/ai-suggestions */
export async function postAnalysisSuggestions(): Promise<AnalysisSuggestionsResp | null> {
  const { data } = await client.post('/analysis/ai-suggestions', {})
  return unwrap<AnalysisSuggestionsResp>(data) ?? null
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
  /** 验收标准规格要求（代理A新增）：采购员照着买 */
  spec_req?: string
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
export async function fetchKitchenBoard(date: string): Promise<KitchenBoardResp> {
  const { data } = await client.get<KitchenBoardResp>('/kitchen/board', {
    params: { date },
  })
  return data
}

/** GET /api/qc/media/status — 品控图片是否可用 */
export async function fetchQcMediaStatus(): Promise<QcMediaStatus> {
  const { data } = await client.get<QcMediaStatus>('/qc/media/status')
  return data
}

/** GET /api/kitchen/sop-videos?sku_id= */
export async function fetchSopVideos(skuId?: string): Promise<SopVideo[]> {
  const { data } = await client.get<{ ok: boolean; items: SopVideo[] }>(
    '/kitchen/sop-videos',
    { params: skuId ? { sku_id: skuId } : undefined },
  )
  return data.items ?? []
}

/** POST /api/kitchen/sop-videos — 绑定视频教材 URL（不收视频字节） */
export async function postSopVideo(body: {
  sku_id: string
  title: string
  video_url: string
}): Promise<{ ok: boolean; item?: SopVideo; error?: string }> {
  const { data } = await client.post('/kitchen/sop-videos', body)
  return data
}

/** GET /api/modules/inspection?date=&board= */
export async function fetchInspectionBoard(params?: {
  date?: string
  board?: string
}): Promise<InspectionBoardResp> {
  const { data } = await client.get<InspectionBoardResp>('/modules/inspection', {
    params: params && Object.keys(params).length ? params : undefined,
  })
  return data
}

/* ---------------- 食材按标准验收（代理A契约） ---------------- */

/** GET /api/inventory/accept-standards */
export async function fetchAcceptStandards(): Promise<AcceptStandardsResp> {
  const { data } = await client.get<AcceptStandardsResp>('/inventory/accept-standards')
  return data
}

/** GET /api/inventory/recv-accept?date= — items/records 两种包装兼容 */
export async function fetchRecvAccept(date?: string): Promise<RecvAcceptRecord[]> {
  const { data } = await client.get<RecvAcceptResp>('/inventory/recv-accept', {
    params: date ? { date } : undefined,
  })
  return data.items ?? data.records ?? []
}

/* ---------------- Sprint 2：modules 只读端点 + 审计 ---------------- */

/** GET /api/modules/staff */
export async function fetchModulesStaff(): Promise<StaffModuleResp> {
  const { data } = await client.get<StaffModuleResp>('/modules/staff')
  return data
}

/* ---------------- M2 排班员工：/api/staff/*（后端聚合 ext.staff_*，只读） ---------------- */

/** GET /api/staff/schedule?week=YYYY-MM-DD */
export async function fetchStaffSchedule(week?: string): Promise<StaffScheduleResp> {
  const { data } = await client.get<StaffScheduleResp>('/staff/schedule', {
    params: week ? { week } : undefined,
  })
  return data
}

/** GET /api/staff/clock?date=YYYY-MM-DD */
export async function fetchStaffClock(date?: string): Promise<StaffClockResp> {
  const { data } = await client.get<StaffClockResp>('/staff/clock', {
    params: date ? { date } : undefined,
  })
  return data
}

/** GET /api/staff/perf */
export async function fetchStaffPerf(): Promise<StaffPerfResp> {
  const { data } = await client.get<StaffPerfResp>('/staff/perf')
  return data
}

/** GET /api/staff/train */
export async function fetchStaffTrain(): Promise<StaffTrainResp> {
  const { data } = await client.get<StaffTrainResp>('/staff/train')
  return data
}

/** GET /api/staff/config — 迟到/缺勤阈值（生效值） */
export async function fetchStaffConfig(): Promise<{
  ok: boolean
  attendance: { late_min: number; absent_min: number }
}> {
  const { data } = await client.get('/staff/config')
  return data
}

/** POST /api/staff/config — 阈值可配 */
export async function saveStaffConfig(attendance: {
  late_min: number
  absent_min: number
}): Promise<{ ok: boolean; attendance: { late_min: number; absent_min: number } }> {
  const { data } = await client.post('/staff/config', { attendance })
  return data
}

/** GET /api/staff/swaps?status= */
export async function fetchStaffSwaps(status?: string): Promise<SwapResp> {
  const { data } = await client.get<SwapResp>('/staff/swaps', {
    params: status ? { status } : undefined,
  })
  return data
}

/** POST /api/staff/swaps/request — A 发起换班 */
export async function requestShiftSwap(body: {
  date: string
  shift: string
  from_staff: string
  from_name?: string
  to_staff: string
  to_name?: string
  start_time?: string
  end_time?: string
  role?: string
  reason?: string
}): Promise<SwapResp> {
  const { data } = await client.post<SwapResp>('/staff/swaps/request', body)
  return data
}

/** 换班单动作：accept / reject / approve（均带 rev，后端做乐观锁） */
export async function actShiftSwap(
  id: string,
  action: 'accept' | 'reject' | 'approve',
  body: { rev?: string | number; reason?: string } = {},
): Promise<SwapResp> {
  const { data } = await client.post<SwapResp>(
    `/staff/swaps/${encodeURIComponent(id)}/${action}`,
    body,
  )
  return data
}

/** POST /api/staff/uniform — 着装合规入档（uniform.log 入队） */
export async function postStaffUniform(body: {
  staff_id: string
  staff_name?: string
  pass?: string | boolean
  score?: number
  note?: string
}): Promise<{ ok: boolean; data?: { id: string; status: string }; note?: string }> {
  const { data } = await client.post('/staff/uniform', body)
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

/* ---------------- 食安证照 v2（M4 后场：GET 只读聚合 + POST 入队） ---------------- */

/** GET /api/foodsafe/certs?level= — 证照台账（分级/禁岗/停业风险） */
export async function fetchFoodsafeCerts(
  params: { level?: string } = {},
): Promise<FoodsafeCertsResp> {
  const { data } = await client.get<FoodsafeCertsResp>('/foodsafe/certs', { params })
  return data
}

/** GET /api/foodsafe/trace?batch= — 溯源批次；带 batch 下钻进货/销售 */
export async function fetchFoodsafeTrace(
  params: { batch?: string } = {},
): Promise<TraceResp> {
  const { data } = await client.get<TraceResp>('/foodsafe/trace', { params })
  return data
}

/** GET /api/foodsafe/samples — 留样 48h 状态机 + 克重合规 */
export async function fetchFoodsafeSamples(): Promise<FoodsafeSamplesResp> {
  const { data } = await client.get<FoodsafeSamplesResp>('/foodsafe/samples')
  return data
}

/** GET /api/foodsafe/disinfect?date=&span= — 消毒记录 + 7 日达标率 */
export async function fetchFoodsafeDisinfect(params: { date?: string; span?: number } = {}): Promise<DisinfectResp> {
  const { data } = await client.get<DisinfectResp>('/foodsafe/disinfect', { params })
  return data
}

/** GET /api/foodsafe/overview — 食安看板汇总 */
export async function fetchFoodsafeOverview(): Promise<FoodsafeOverviewResp> {
  const { data } = await client.get<FoodsafeOverviewResp>('/foodsafe/overview')
  return data
}

/** GET /api/foodsafe/config — 证照临期阈值（可配） */
export async function fetchFoodsafeConfig(): Promise<CertConfigResp> {
  const { data } = await client.get<CertConfigResp>('/foodsafe/config')
  return data
}

/** POST /api/foodsafe/config — 保存临期阈值（需 逾期禁营 ≤ 红 ≤ 橙 ≤ 黄） */
export async function saveFoodsafeConfig(
  cert: Partial<CertThresholds>,
): Promise<CertConfigResp> {
  const { data } = await client.post<CertConfigResp>('/foodsafe/config', { cert })
  return data
}

/** POST /api/foodsafe/certs — 证照登记/续期 → fs.cert.upsert 入队 */
export async function upsertFoodsafeCert(body: {
  id?: string | number
  cert_type: string
  holder: string
  cert_no?: string
  issued_at?: string
  expire_at: string
  status?: string
}): Promise<FoodsafeEnqueueResp> {
  const { data } = await client.post<FoodsafeEnqueueResp>('/foodsafe/certs', body)
  return data
}

/** POST /api/foodsafe/samples — 留样登记（克重不足 422 拦截）→ sample.log 入队 */
export async function logFoodsafeSample(body: {
  date?: string
  meal?: string
  dish: string
  weight_g: number
  keeper?: string
  kept_at?: string
}): Promise<FoodsafeEnqueueResp> {
  const { data } = await client.post<FoodsafeEnqueueResp>('/foodsafe/samples', body)
  return data
}

/** POST /api/foodsafe/samples/ingest — Kimi 识别入档（≥91% 自动入档 / <91% 待复核） */
export async function ingestFoodsafeSample(body: {
  date?: string
  meal?: string
  dish: string
  weight_g: number
  conf: number
  keeper?: string
  source?: string
}): Promise<FoodsafeEnqueueResp> {
  const { data } = await client.post<FoodsafeEnqueueResp>('/foodsafe/samples/ingest', body)
  return data
}

/** POST /api/foodsafe/samples/clear — 销毁登记 → fs.sample_clear 入队 */
export async function clearFoodsafeSample(body: {
  id: string | number
  dish?: string
  cleared_at?: string
  note?: string
}): Promise<FoodsafeEnqueueResp> {
  const { data } = await client.post<FoodsafeEnqueueResp>('/foodsafe/samples/clear', body)
  return data
}

/** POST /api/foodsafe/disinfect — 消毒登记 → fs.disinfect 入队 */
export async function logFoodsafeDisinfect(body: {
  date?: string
  area: string
  method?: string
  operator?: string
  ts?: string
  result?: string
}): Promise<FoodsafeEnqueueResp> {
  const { data } = await client.post<FoodsafeEnqueueResp>('/foodsafe/disinfect', body)
  return data
}

/* ---------------- App 分发包（局域网下载） ---------------- */

/** GET /api/app/release — 安装包元信息（版本/大小/哈希/局域网地址） */
export async function fetchAppRelease(): Promise<AppRelease> {
  const { data } = await client.get<AppRelease>('/app/release')
  return data
}

/* ---------------- 结算单模板（只读输出层的配置） ---------------- */

/** GET /api/settle/template */
export async function fetchSettleTemplate(): Promise<SettleTemplateResp> {
  const { data } = await client.get<SettleTemplateResp>('/settle/template')
  return data
}

/**
 * PUT /api/settle/template — 仅老板/店长。
 * 注意：模板是「只读输出层」的配置，不进业务库、不走审批队列。
 */
export async function saveSettleTemplate(tpl: SettleTemplate): Promise<SettleTemplateResp> {
  const { data } = await client.put<SettleTemplateResp>('/settle/template', { template: tpl })
  return data
}

/* ---------------- 设备温度/维保/能耗 v2（M8 后场：GET 只读聚合 + POST 入队） ---------------- */

/** GET /api/equipment/temps — 冷柜温度台账（分级/超温告警） */
export async function fetchEquipmentTemps(): Promise<EquipmentTempsResp> {
  const { data } = await client.get<EquipmentTempsResp>('/equipment/temps')
  return data
}

/** GET /api/equipment/maintain — 维保记录 + 计划（逾期/临期） */
export async function fetchEquipmentMaintain(): Promise<EquipmentMaintainResp> {
  const { data } = await client.get<EquipmentMaintainResp>('/equipment/maintain')
  return data
}

/** GET /api/equipment/energy — 能耗汇总（燃气/水/电 + 营收占比 + 预算） */
export async function fetchEquipmentEnergy(): Promise<EquipmentEnergyResp> {
  const { data } = await client.get<EquipmentEnergyResp>('/equipment/energy')
  return data
}

/** GET /api/equipment/overview — 设备看板汇总 */
export async function fetchEquipmentOverview(): Promise<EquipmentOverviewResp> {
  const { data } = await client.get<EquipmentOverviewResp>('/equipment/overview')
  return data
}

/** GET /api/equipment/config — 温度上限/维保周期/能耗预算（可配） */
export async function fetchEquipmentConfig(): Promise<EquipmentConfigResp> {
  const { data } = await client.get<EquipmentConfigResp>('/equipment/config')
  return data
}

/** POST /api/equipment/config — 保存设备配置 */
export async function saveEquipmentConfig(
  equipment: Partial<EquipmentConfigResp['equipment']>,
): Promise<EquipmentConfigResp> {
  const { data } = await client.post<EquipmentConfigResp>('/equipment/config', { equipment })
  return data
}

/** POST /api/equipment/maintain — 维保登记 → equipment.maintain 入队 */
export async function logEquipmentMaintain(body: {
  device: string
  kind?: string
  ts?: string
  cost?: number
  next_due?: string
  note?: string
}): Promise<EquipmentEnqueueResp> {
  const { data } = await client.post<EquipmentEnqueueResp>('/equipment/maintain', body)
  return data
}

/** POST /api/equipment/temp — 温度登记 → equipment.temp_log 入队（高频表，不进 rev） */
export async function logEquipmentTemp(body: {
  device: string
  temp: number
  ts?: string
}): Promise<EquipmentEnqueueResp> {
  const { data } = await client.post<EquipmentEnqueueResp>('/equipment/temp', body)
  return data
}

/** POST /api/equipment/energy — 能耗抄表 → equipment.energy_log 入队 */
export async function logEquipmentEnergy(body: {
  date?: string
  device: string
  kind: string
  reading?: number
  usage?: number
}): Promise<EquipmentEnqueueResp> {
  const { data } = await client.post<EquipmentEnqueueResp>('/equipment/energy', body)
  return data
}

/* ---------------- 财务 v2（M9 后场：GET 只读聚合 + POST 入队） ---------------- */

/** GET /api/finance/invoices — 发票台账 + 月度销项额度 */
export async function fetchFinanceInvoices(): Promise<FinanceInvoicesResp> {
  const { data } = await client.get<FinanceInvoicesResp>('/finance/invoices')
  return data
}

/** GET /api/finance/tax — 税务申报（待申报/逾期） */
export async function fetchFinanceTax(): Promise<FinanceTaxResp> {
  const { data } = await client.get<FinanceTaxResp>('/finance/tax')
  return data
}

/** GET /api/finance/cashflow — 现金流水（收入/支出/净额） */
export async function fetchFinanceCashflow(): Promise<FinanceCashflowResp> {
  const { data } = await client.get<FinanceCashflowResp>('/finance/cashflow')
  return data
}

/** GET /api/finance/split — 分账（冻结红线/可解冻） */
export async function fetchFinanceSplit(): Promise<FinanceSplitResp> {
  const { data } = await client.get<FinanceSplitResp>('/finance/split')
  return data
}

/** GET /api/finance/overview — 财务看板汇总 */
export async function fetchFinanceOverview(): Promise<FinanceOverviewResp> {
  const { data } = await client.get<FinanceOverviewResp>('/finance/overview')
  return data
}

/** GET /api/finance/config — 发票额度/冻结期/申报日（可配） */
export async function fetchFinanceConfig(): Promise<FinanceConfigResp> {
  const { data } = await client.get<FinanceConfigResp>('/finance/config')
  return data
}

/** POST /api/finance/config — 保存财务配置 */
export async function saveFinanceConfig(
  finance: Partial<FinanceConfigResp['finance']>,
): Promise<FinanceConfigResp> {
  const { data } = await client.post<FinanceConfigResp>('/finance/config', { finance })
  return data
}

/** POST /api/finance/invoice — 开票登记 → finance.invoice 入队 */
export async function logFinanceInvoice(body: {
  invoice_no?: string
  kind?: string
  direction?: string
  amount: number
  tax?: number
  ts?: string
}): Promise<FinanceEnqueueResp> {
  const { data } = await client.post<FinanceEnqueueResp>('/finance/invoice', body)
  return data
}

/** POST /api/finance/tax — 税务申报登记 → finance.tax 入队 */
export async function logFinanceTax(body: {
  period?: string
  kind: string
  amount: number
  status?: string
  filed_at?: string
}): Promise<FinanceEnqueueResp> {
  const { data } = await client.post<FinanceEnqueueResp>('/finance/tax', body)
  return data
}

/** POST /api/finance/cash — 现金流水登记 → finance.cash 入队 */
export async function logFinanceCash(body: {
  ts?: string
  kind: string
  amount: number
  account?: string
  note?: string
}): Promise<FinanceEnqueueResp> {
  const { data } = await client.post<FinanceEnqueueResp>('/finance/cash', body)
  return data
}

/** POST /api/finance/split — 分账冻结登记 → finance.freeze 入队 */
export async function freezeFinanceSplit(body: {
  period?: string
  party: string
  amount: number
  ratio?: number
  frozen_until?: string
}): Promise<FinanceEnqueueResp> {
  const { data } = await client.post<FinanceEnqueueResp>('/finance/split', body)
  return data
}

/** POST /api/finance/split/approve — 分账解冻/结算 → finance.approve 入队 */
export async function approveFinanceSplit(body: {
  id: number | string
  party?: string
  amount?: number
  status?: string
}): Promise<FinanceEnqueueResp> {
  const { data } = await client.post<FinanceEnqueueResp>('/finance/split/approve', body)
  return data
}

/** POST /api/finance/recon — 三方勾兑确认 → finance.recon 入队 */
export async function reconFinance(body: {
  date?: string
  dine_in?: number
  takeout?: number
  purchase?: number
  note?: string
}): Promise<FinanceEnqueueResp> {
  const { data } = await client.post<FinanceEnqueueResp>('/finance/recon', body)
  return data
}

/* ---------------- 供应链 v2（M10 后场：GET 只读聚合 + POST 入队） ---------------- */

/** GET /api/supply/vendors — 供应商档案（品类/状态/账期/评级） */
export async function fetchSupplyVendors(): Promise<SupplyVendorsResp> {
  const { data } = await client.get<SupplyVendorsResp>('/supply/vendors')
  return data
}

/** GET /api/supply/compare — 比价（同原料多供应商 + 价差） */
export async function fetchSupplyCompare(): Promise<SupplyCompareResp> {
  const { data } = await client.get<SupplyCompareResp>('/supply/compare')
  return data
}

/** GET /api/supply/accounts — 往来账龄（0-30/31-60/>60/逾期） */
export async function fetchSupplyAccounts(): Promise<SupplyAccountsResp> {
  const { data } = await client.get<SupplyAccountsResp>('/supply/accounts')
  return data
}

/** GET /api/supply/overview — 供应链看板汇总 */
export async function fetchSupplyOverview(): Promise<SupplyOverviewResp> {
  const { data } = await client.get<SupplyOverviewResp>('/supply/overview')
  return data
}

/** GET /api/supply/config — 价差阈值/账龄分档/低评级线（可配） */
export async function fetchSupplyConfig(): Promise<SupplyConfigResp> {
  const { data } = await client.get<SupplyConfigResp>('/supply/config')
  return data
}

/** POST /api/supply/config — 保存供应链配置 */
export async function saveSupplyConfig(
  supply: Partial<SupplyConfigResp['supply']>,
): Promise<SupplyConfigResp> {
  const { data } = await client.post<SupplyConfigResp>('/supply/config', { supply })
  return data
}

/** POST /api/supply/vendor — 供应商档案 upsert → vendor.upsert 入队 */
export async function upsertSupplyVendor(body: {
  name?: string
  vendor_id?: string
  contact?: string
  phone?: string
  category?: string
  level?: number
  status?: string
  period?: string
  note?: string
}): Promise<SupplyEnqueueResp> {
  const { data } = await client.post<SupplyEnqueueResp>('/supply/vendor', body)
  return data
}

/** POST /api/supply/quote — 供应商报价 → quote.upsert 入队 */
export async function logSupplyQuote(body: {
  ing: string
  src: string
  price: number
  per?: string
  unit?: string
  note?: string
  set_default_sup?: boolean
}): Promise<SupplyEnqueueResp> {
  const { data } = await client.post<SupplyEnqueueResp>('/supply/quote', body)
  return data
}

/** POST /api/supply/po — 采购应付登记 → supply.po 入队 */
export async function logSupplyPo(body: {
  vendor_id: string
  amount: number
  ref_no?: string
  ts?: string
}): Promise<SupplyEnqueueResp> {
  const { data } = await client.post<SupplyEnqueueResp>('/supply/po', body)
  return data
}

/* ---------------- 损耗 v2（M12 后场：GET 只读聚合 + POST 入队） ---------------- */

/** GET /api/loss/records — 损耗流水归因（损耗率/原因/原料） */
export async function fetchLossRecords(): Promise<LossRecordsResp> {
  const { data } = await client.get<LossRecordsResp>('/loss/records')
  return data
}

/** GET /api/loss/reports — 报损单（待审批/大额） */
export async function fetchLossReports(): Promise<LossReportsResp> {
  const { data } = await client.get<LossReportsResp>('/loss/reports')
  return data
}

/** GET /api/loss/inventory — 盘点差异（盘亏/盘盈） */
export async function fetchLossInventory(): Promise<LossInventoryResp> {
  const { data } = await client.get<LossInventoryResp>('/loss/inventory')
  return data
}

/** GET /api/loss/overview — 损耗看板汇总 */
export async function fetchLossOverview(): Promise<LossOverviewResp> {
  const { data } = await client.get<LossOverviewResp>('/loss/overview')
  return data
}

/** GET /api/loss/config — 损耗率红线/大额阈值（可配） */
export async function fetchLossConfig(): Promise<LossConfigResp> {
  const { data } = await client.get<LossConfigResp>('/loss/config')
  return data
}

/** POST /api/loss/config — 保存损耗配置 */
export async function saveLossConfig(
  loss: Partial<LossConfigResp['loss']>,
): Promise<LossConfigResp> {
  const { data } = await client.post<LossConfigResp>('/loss/config', { loss })
  return data
}

/** POST /api/loss/report — 报损登记（待审核）→ loss.report 入队 */
export async function logLossReport(body: {
  date?: string
  ing_name: string
  qty: number
  reason?: string
  reporter?: string
  amount?: number
}): Promise<LossEnqueueResp> {
  const { data } = await client.post<LossEnqueueResp>('/loss/report', body)
  return data
}

/** POST /api/loss/approve — 报损审批（扣库存）→ loss.approve 入队 */
export async function approveLossReport(body: { id: number | string }): Promise<LossEnqueueResp> {
  const { data } = await client.post<LossEnqueueResp>('/loss/approve', body)
  return data
}

/** POST /api/loss/reject — 报损驳回（不扣库存）→ loss.reject 入队 */
export async function rejectLossReport(body: { id: number | string; reason?: string }): Promise<LossEnqueueResp> {
  const { data } = await client.post<LossEnqueueResp>('/loss/reject', body)
  return data
}
