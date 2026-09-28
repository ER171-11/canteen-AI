package com.pandawufu.shared.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/** GET /api/modules/staff */
@Serializable
data class StaffModuleDto(
    val ok: Boolean = false,
    val hint: String? = null,
    val message: String? = null,
    val rev: Int? = null,
    @SerialName("generated_at") val generatedAt: String? = null,
    val shifts: List<StaffShiftDto> = emptyList(),
    val clock: List<StaffClockDto> = emptyList(),
    val perf: List<StaffPerfDto> = emptyList(),
    val train: List<StaffTrainDto> = emptyList(),
    val insight: StaffInsightDto? = null
)

/** 排班洞察：班表 + 打卡异常 + 健康证禁岗 + 峰谷加排 */
@Serializable
data class StaffTodayDto(
    val date: String = "",
    val shifts: Int = 0,
    val staff: Int = 0,
    @SerialName("by_shift") val byShift: Map<String, Int> = emptyMap()
)

@Serializable
data class StaffClockInsightDto(
    val expected: Int = 0,
    val clocked: Int = 0,
    val late: Int = 0,
    val makeup: Int = 0,
    val absent: List<String> = emptyList()
)

@Serializable
data class StaffCertBlockDto(val holder: String = "", val days: Int = 0)

@Serializable
data class StaffCertsInsightDto(
    val blocked: List<StaffCertBlockDto> = emptyList(),
    val expiring: List<StaffCertBlockDto> = emptyList(),
    @SerialName("blocked_scheduled") val blockedScheduled: List<String> = emptyList()
)

@Serializable
data class StaffTrainingInsightDto(
    val total: Int = 0,
    val pending: Int = 0
)

@Serializable
data class StaffPeakInsightDto(
    val hour: Int? = null,
    val scheduled: Int = 0,
    @SerialName("suggest_add") val suggestAdd: Boolean = false,
    val text: String = ""
)

@Serializable
data class StaffInsightDto(
    val today: StaffTodayDto? = null,
    val clock: StaffClockInsightDto? = null,
    val certs: StaffCertsInsightDto? = null,
    val training: StaffTrainingInsightDto? = null,
    val peak: StaffPeakInsightDto? = null,
    val advice: List<String> = emptyList()
)

@Serializable
data class StaffShiftDto(
    val id: Int? = null,
    @SerialName("staff_id") val staffId: String? = null,
    @SerialName("staff_name") val staffName: String? = null,
    val date: String? = null,
    val shift: String? = null,
    @SerialName("start_time") val startTime: String? = null,
    @SerialName("end_time") val endTime: String? = null,
    val role: String? = null
)

@Serializable
data class StaffClockDto(
    val id: Int? = null,
    @SerialName("staff_id") val staffId: String? = null,
    val ts: String? = null,
    val kind: String? = null,
    val status: String? = null
)

@Serializable
data class StaffPerfDto(
    val id: Int? = null,
    @SerialName("staff_id") val staffId: String? = null,
    @SerialName("staff_name") val staffName: String? = null,
    val date: String? = null,
    val metric: String? = null,
    val value: Double? = null,
    val hours: Double? = null
)

@Serializable
data class StaffTrainDto(
    val id: Int? = null,
    @SerialName("staff_id") val staffId: String? = null,
    @SerialName("staff_name") val staffName: String? = null,
    val title: String? = null,
    val course: String? = null,
    val status: String? = null,
    val date: String? = null
) {
    val displayTitle: String get() = title ?: course ?: "-"
}

/** GET /api/modules/booking */
@Serializable
data class BookingModuleDto(
    val ok: Boolean = false,
    val hint: String? = null,
    val message: String? = null,
    val date: String? = null,
    val rev: Int? = null,
    val bookings: List<BookingDto> = emptyList(),
    val queue: List<QueueDto> = emptyList(),
    val serves: List<QueueServeDto> = emptyList(),
    val insight: BookingInsightDto? = null
)

/** 预订排队洞察：翻台预估 + 后厨备料 + 加排建议 */
@Serializable
data class BookingInsightDto(
    val summary: BookingSummaryDto? = null,
    val queue: BookingQueueInsightDto? = null,
    val tables: BookingTablesInsightDto? = null,
    val turn: BookingTurnDto? = null,
    val kitchen: BookingKitchenInsightDto? = null,
    val staffing: BookingStaffingInsightDto? = null
)

@Serializable
data class BookingSummaryDto(
    val bookings: Int = 0,
    val guests: Int = 0,
    @SerialName("by_status") val byStatus: Map<String, Int> = emptyMap(),
    @SerialName("by_slot") val bySlot: Map<String, Int> = emptyMap()
)

@Serializable
data class BookingQueueInsightDto(
    val waiting: Int = 0,
    @SerialName("waiting_guests") val waitingGuests: Int = 0,
    @SerialName("next_no") val nextNo: String? = null,
    val serving: Int = 0
)

@Serializable
data class BookingTablesInsightDto(
    val total: Int = 0,
    val occupied: Int = 0,
    @SerialName("occupancy_pct") val occupancyPct: Int? = null
)

@Serializable
data class BookingTurnCapacityDto(
    val count: Int = 0,
    @SerialName("turn_min") val turnMin: Int = 0
)

@Serializable
data class BookingTurnDto(
    @SerialName("by_capacity") val byCapacity: Map<String, BookingTurnCapacityDto> = emptyMap(),
    val note: String? = null
)

@Serializable
data class BookingKitchenInsightDto(
    @SerialName("expected_guests") val expectedGuests: Int = 0,
    @SerialName("expected_portions") val expectedPortions: Int? = null,
    @SerialName("dish_per_guest") val dishPerGuest: Double? = null
)

@Serializable
data class BookingStaffingInsightDto(
    @SerialName("occupancy_pct") val occupancyPct: Int? = null,
    @SerialName("suggest_add") val suggestAdd: Boolean = false,
    val text: String = ""
)

@Serializable
data class BookingDto(
    val id: Int? = null,
    @SerialName("guest_name") val guestName: String? = null,
    val phone: String? = null,
    val date: String? = null,
    val time: String? = null,
    @SerialName("party_size") val partySize: Int? = null,
    @SerialName("table_id") val tableId: String? = null,
    val status: String? = null,
    val note: String? = null
)

@Serializable
data class QueueDto(
    val id: Int? = null,
    @SerialName("queue_no") val queueNo: String? = null,
    val date: String? = null,
    @SerialName("party_size") val partySize: Int? = null,
    val status: String? = null,
    val ts: String? = null
)

@Serializable
data class QueueServeDto(
    val id: Int? = null,
    val date: String? = null,
    val action: String? = null,
    val item: String? = null,
    val qty: Double? = null,
    val note: String? = null,
    @SerialName("queue_no") val queueNo: String? = null,
    @SerialName("wait_eta_min") val waitEtaMin: Int? = null,
    @SerialName("queue_count") val queueCount: Int? = null,
    val ts: String? = null
)

/** GET /api/modules/foodsafe */
@Serializable
data class FoodsafeModuleDto(
    val ok: Boolean = false,
    val hint: String? = null,
    val message: String? = null,
    val rev: Int? = null,
    val certs: List<FsCertDto> = emptyList(),
    val trace: List<FsTraceDto> = emptyList(),
    val samples: List<FsSampleDto> = emptyList(),
    val disinfect: List<FsDisinfectDto> = emptyList(),
    val insight: FoodsafeInsightDto? = null
)

/** 食安洞察：证照临期/禁岗 + 留样 48h + 消毒漏做 + 溯源待补 */
@Serializable
data class FsCertWarnDto(
    val type: String = "",
    val holder: String = "",
    val days: Int? = null,
    val level: String = "unknown"
)

@Serializable
data class FsCertsInsightDto(
    @SerialName("by_type") val byType: Map<String, Int> = emptyMap(),
    val warnings: List<FsCertWarnDto> = emptyList(),
    @SerialName("health_blocked") val healthBlocked: List<String> = emptyList(),
    @SerialName("store_risks") val storeRisks: List<String> = emptyList()
)

@Serializable
data class FsSamplesInsightDto(
    val pending: Int = 0,
    @SerialName("due_soon") val dueSoon: Int = 0,
    val expired: Int = 0,
    @SerialName("under_weight") val underWeight: Int = 0
)

@Serializable
data class FsDisinfectInsightDto(
    val areas: Int = 0,
    @SerialName("today_done") val todayDone: Int = 0,
    val missed: List<String> = emptyList()
)

@Serializable
data class FsTraceInsightDto(
    val batches: Int = 0,
    @SerialName("missing_cert") val missingCert: Int = 0
)

@Serializable
data class FoodsafeInsightDto(
    val certs: FsCertsInsightDto? = null,
    val samples: FsSamplesInsightDto? = null,
    val disinfect: FsDisinfectInsightDto? = null,
    val trace: FsTraceInsightDto? = null,
    val advice: List<String> = emptyList()
)

@Serializable
data class FsCertDto(
    val id: Int? = null,
    @SerialName("cert_type") val certType: String? = null,
    val holder: String? = null,
    @SerialName("cert_no") val certNo: String? = null,
    @SerialName("expire_at") val expireAt: String? = null,
    val status: String? = null
)

@Serializable
data class FsTraceDto(
    val id: Int? = null,
    val name: String? = null,
    @SerialName("ing_name") val ingName: String? = null,
    val supplier: String? = null,
    val batch: String? = null,
    @SerialName("batch_no") val batchNo: String? = null,
    @SerialName("check_result") val checkResult: String? = null,
    @SerialName("recv_date") val recvDate: String? = null
)

@Serializable
data class FsSampleDto(
    val id: Int? = null,
    val date: String? = null,
    val meal: String? = null,
    val dish: String? = null,
    @SerialName("weight_g") val weightG: Double? = null,
    val keeper: String? = null,
    @SerialName("kept_at") val keptAt: String? = null,
    @SerialName("hours_left") val hoursLeft: Double? = null,
    /** 已清样（cleared_at 有值）：不再倒计时 */
    val cleared: Boolean? = null,
    /** 已超 48h 留样时限 */
    val expired: Boolean? = null
)

@Serializable
data class FsDisinfectDto(
    val id: Int? = null,
    val area: String? = null,
    val method: String? = null,
    val result: String? = null,
    val ts: String? = null,
    val date: String? = null
)

/** GET /api/modules/analysis */
@Serializable
data class AnalysisModuleDto(
    val ok: Boolean = false,
    val hint: String? = null,
    val message: String? = null,
    val rev: Int? = null,
    val mock: Boolean? = null,
    val note: String? = null,
    val trend: List<AnalysisTrendDto> = emptyList(),
    val heatmap: List<AnalysisHeatDto> = emptyList(),
    val matrix: List<AnalysisMatrixDto> = emptyList(),
    val efficiency: AnalysisEfficiencyDto? = null,
    val compare: AnalysisCompareDto? = null,
    val forecast: AnalysisForecastDto? = null,
    @SerialName("baoben_summary") val baobenSummary: BaobenSummaryDto? = null,
    @SerialName("baoben_types") val baobenTypes: List<BaobenTypeDto> = emptyList()
)

/** 同环比（样本不足字段为 null，UI 不编造） */
@Serializable
data class AnalysisCompareDto(
    val days: Int? = null,
    @SerialName("wow_rev_pct") val wowRevPct: Double? = null,
    @SerialName("mom_rev_pct") val momRevPct: Double? = null,
    @SerialName("yoy_rev_pct") val yoyRevPct: Double? = null,
    @SerialName("last7_rev") val last7Rev: Double? = null,
    @SerialName("prev7_rev") val prev7Rev: Double? = null
)

@Serializable
data class AnalysisTrendDto(
    val date: String? = null,
    val week: String? = null,
    val revenue: Double? = null,
    val orders: Int? = null,
    @SerialName("gross_rate") val grossRate: Double? = null
)

@Serializable
data class AnalysisHeatDto(
    val hour: Int? = null,
    val weekday: Int? = null,
    val orders: Int? = null,
    val revenue: Double? = null
)

@Serializable
data class AnalysisMatrixDto(
    val name: String? = null,
    val price: Double? = null,
    val volume: Double? = null,
    val margin: Double? = null,
    val quadrant: String? = null,
    @SerialName("dish_type") val dishType: String? = null,
    /** 菜品主数据 id（写动作 dish.price / dish.set_active 用）；BFF 未带时为 null */
    val id: String? = null,
    @SerialName("dish_id") val dishId: String? = null
)

@Serializable
data class AnalysisEfficiencyDto(
    @SerialName("avg_ticket") val avgTicket: Double? = null,
    @SerialName("daily_avg_revenue") val dailyAvgRevenue: Double? = null,
    @SerialName("total_orders") val totalOrders: Int? = null,
    val days: Int? = null,
    /** 翻台率（订单/桌位容量/天，无桌位按座位÷4 估） */
    val turnover: Double? = null,
    @SerialName("revenue_per_sqm") val revenuePerSqm: Double? = null,
    @SerialName("revenue_per_staff") val revenuePerStaff: Double? = null,
    val area: Double? = null,
    val staff: Double? = null,
    val seats: Double? = null,
    val tables: Int? = null
)

@Serializable
data class AnalysisForecastDto(
    val confidence: Int? = null,
    val note: String? = null,
    val days: List<AnalysisForecastDayDto> = emptyList(),
    @SerialName("weather_coef") val weatherCoef: List<AnalysisWeatherCoefDto> = emptyList(),
    val holidays: List<AnalysisHolidayDto> = emptyList(),
    val restock: List<AnalysisForecastRestockDto> = emptyList(),
    val peak: AnalysisForecastDayDto? = null
)

@Serializable
data class AnalysisForecastDayDto(
    val date: String? = null,
    val pred: Double? = null,
    val opt: Double? = null,
    val cons: Double? = null,
    val weekday: Int? = null
)

@Serializable
data class AnalysisWeatherCoefDto(
    val weather: String? = null,
    val red: String? = null,
    val black: String? = null,
    val yellow: String? = null,
    val green: String? = null,
    val white: String? = null
)

@Serializable
data class AnalysisHolidayDto(
    val label: String? = null,
    val effect: String? = null
)

@Serializable
data class AnalysisForecastRestockDto(
    val ingredientId: String? = null,
    val name: String? = null,
    val unit: String? = null,
    val qty: Double? = null,
    val pred: Double? = null,
    val cons: Double? = null,
    val opt: Double? = null,
    val amount: Double? = null,
    val badge: String? = null,
    val reason: String? = null
)

/** GET /api/modules/vip */
@Serializable
data class VipModuleDto(
    val ok: Boolean = false,
    val hint: String? = null,
    val message: String? = null,
    val rev: Int? = null,
    val members: List<VipMemberDto> = emptyList(),
    val coupons: List<VipCouponDto> = emptyList(),
    val visits: List<VipVisitDto> = emptyList(),
    val insight: VipInsightDto? = null
)

/** 会员洞察：资产 + 券状态机 + 生日 + 到店（联动 POS 储值/券） */
@Serializable
data class VipAssetsDto(
    val members: Int = 0,
    @SerialName("new_this_month") val newThisMonth: Int = 0,
    @SerialName("by_level") val byLevel: Map<String, Int> = emptyMap(),
    @SerialName("stored_total") val storedTotal: Double = 0.0,
    @SerialName("with_balance") val withBalance: Int = 0
)

@Serializable
data class VipRechargeInsightDto(
    val count: Int = 0,
    val total: Double = 0.0,
    @SerialName("big_count") val bigCount: Int = 0
)

@Serializable
data class VipCouponInsightDto(
    val total: Int = 0,
    @SerialName("by_status") val byStatus: Map<String, Int> = emptyMap(),
    val liability: Double = 0.0,
    @SerialName("used_value") val usedValue: Double = 0.0,
    @SerialName("expiring_7d") val expiring7d: Int = 0,
    val expired: Int = 0
)

@Serializable
data class VipBirthdayInsightDto(
    val soon: Int = 0,
    val names: List<String> = emptyList()
)

@Serializable
data class VipVisitsInsightDto(
    val count: Int = 0,
    @SerialName("unique_members") val uniqueMembers: Int = 0
)

@Serializable
data class VipInsightDto(
    val assets: VipAssetsDto? = null,
    val recharge: VipRechargeInsightDto? = null,
    val coupons: VipCouponInsightDto? = null,
    val birthday: VipBirthdayInsightDto? = null,
    val visits: VipVisitsInsightDto? = null,
    val advice: List<String> = emptyList()
)

@Serializable
data class VipMemberDto(
    @SerialName("member_id") val memberId: String? = null,
    val name: String? = null,
    val phone: String? = null,
    val level: String? = null,
    val balance: Double? = null,
    val status: String? = null,
    val birthday: String? = null,
    @SerialName("birthday_soon") val birthdaySoon: Boolean? = null
)

@Serializable
data class VipCouponDto(
    val id: Int? = null,
    val code: String? = null,
    val type: String? = null,
    val value: Double? = null,
    val status: String? = null
)

@Serializable
data class VipVisitDto(
    val id: Int? = null,
    @SerialName("member_id") val memberId: String? = null,
    val name: String? = null,
    val phone: String? = null,
    @SerialName("table_id") val tableId: String? = null,
    val note: String? = null,
    val ts: String? = null
)

/** GET /api/modules/takeout */
@Serializable
data class TakeoutModuleDto(
    val ok: Boolean = false,
    val hint: String? = null,
    val message: String? = null,
    val rev: Int? = null,
    val platforms: List<TakeoutPlatformDto> = emptyList(),
    val orders: List<TakeoutOrderDto> = emptyList(),
    val reviews: List<TakeoutReviewDto> = emptyList(),
    val reconcile: List<TakeoutReconcileDto> = emptyList(),
    val insight: TakeoutInsightDto? = null
)

/** 外卖洞察：渠道概览 + 对账差异闭环 + 差评归因 */
@Serializable
data class TakeoutPlatformStatDto(
    val orders: Int = 0,
    val amount: Double = 0.0,
    val commission: Double = 0.0
)

@Serializable
data class TakeoutOverviewDto(
    val orders: Int = 0,
    val gross: Double = 0.0,
    val commission: Double = 0.0,
    val settle: Double = 0.0,
    @SerialName("avg_order") val avgOrder: Double = 0.0,
    val open: Int = 0,
    @SerialName("fee_rate") val feeRate: Double? = null,
    @SerialName("by_platform") val byPlatform: Map<String, TakeoutPlatformStatDto> = emptyMap()
)

@Serializable
data class TakeoutReconcilePendingDto(
    val platform: String = "",
    val period: String = "",
    val diff: Double = 0.0,
    val status: String = ""
)

@Serializable
data class TakeoutReconcileInsightDto(
    val total: Int = 0,
    @SerialName("by_status") val byStatus: Map<String, Int> = emptyMap(),
    @SerialName("diff_sum") val diffSum: Double = 0.0,
    val pending: List<TakeoutReconcilePendingDto> = emptyList(),
    val clean: Boolean = false
)

@Serializable
data class TakeoutReviewInsightDto(
    val total: Int = 0,
    val bad: Int = 0,
    val reasons: Map<String, Int> = emptyMap(),
    @SerialName("reply_pending") val replyPending: Int = 0,
    @SerialName("dish_flags") val dishFlags: Map<String, Int> = emptyMap()
)

@Serializable
data class TakeoutInsightDto(
    val overview: TakeoutOverviewDto? = null,
    val reconcile: TakeoutReconcileInsightDto? = null,
    val reviews: TakeoutReviewInsightDto? = null,
    val advice: List<String> = emptyList()
)

@Serializable
data class TakeoutPlatformDto(
    val name: String? = null,
    val orders: Int? = null,
    val amount: Double? = null,
    val rating: Double? = null
)

@Serializable
data class TakeoutOrderDto(
    val id: Int? = null,
    val platform: String? = null,
    @SerialName("platform_no") val platformNo: String? = null,
    val ts: String? = null,
    val amount: Double? = null,
    val status: String? = null
)

@Serializable
data class TakeoutReviewDto(
    val id: Int? = null,
    val platform: String? = null,
    val rating: Double? = null,
    val content: String? = null,
    val handled: Int? = null
)

@Serializable
data class TakeoutReconcileDto(
    val id: Int? = null,
    val platform: String? = null,
    val period: String? = null,
    @SerialName("expect_amt") val expectAmt: Double? = null,
    @SerialName("actual_amt") val actualAmt: Double? = null,
    val diff: Double? = null,
    val status: String? = null
)

/** GET /api/modules/review */
@Serializable
data class ReviewModuleDto(
    val ok: Boolean = false,
    val hint: String? = null,
    val message: String? = null,
    val rev: Int? = null,
    val reviews: List<ReviewDto> = emptyList(),
    val improve: List<ImproveDto> = emptyList(),
    val insight: ReviewInsightDto? = null
)

/** 口碑洞察：评分聚合 + 差评归因 + 改进闭环 + 好评素材 */
@Serializable
data class ReviewPlatformDto(val name: String = "", val rating: Double? = null, val orders: Int? = null)

@Serializable
data class ReviewScoresDto(
    val overall: Double? = null,
    @SerialName("local_avg") val localAvg: Double? = null,
    @SerialName("by_platform") val byPlatform: List<ReviewPlatformDto> = emptyList()
)

@Serializable
data class ReviewBadItemDto(
    val source: String? = null,
    val rating: Double = 0.0,
    val content: String = "",
    val ts: String? = null
)

@Serializable
data class ReviewBadDto(
    val count: Int = 0,
    val reasons: Map<String, Int> = emptyMap(),
    @SerialName("dish_flags") val dishFlags: Map<String, Int> = emptyMap(),
    val items: List<ReviewBadItemDto> = emptyList()
)

@Serializable
data class ReviewOverdueDto(val action: String? = null, val owner: String? = null, val due: String? = null)

@Serializable
data class ReviewImproveInsightDto(
    val total: Int = 0,
    @SerialName("by_status") val byStatus: Map<String, Int> = emptyMap(),
    val open: Int = 0,
    val overdue: List<ReviewOverdueDto> = emptyList()
)

@Serializable
data class ReviewGoodDto(
    val count: Int = 0,
    @SerialName("quotes_total") val quotesTotal: Int = 0,
    @SerialName("quotes_approved") val quotesApproved: Int = 0
)

@Serializable
data class ReviewInsightDto(
    val scores: ReviewScoresDto? = null,
    val bad: ReviewBadDto? = null,
    val improve: ReviewImproveInsightDto? = null,
    val good: ReviewGoodDto? = null,
    val advice: List<String> = emptyList()
)

@Serializable
data class ReviewDto(
    val id: Int? = null,
    val source: String? = null,
    val rating: Double? = null,
    val content: String? = null,
    val handled: Int? = null,
    val ts: String? = null
)

@Serializable
data class ImproveDto(
    val id: Int? = null,
    @SerialName("review_id") val reviewId: Int? = null,
    val action: String? = null,
    val owner: String? = null,
    val status: String? = null
)

/** GET /api/modules/equipment */
@Serializable
data class EquipmentModuleDto(
    val ok: Boolean = false,
    val hint: String? = null,
    val message: String? = null,
    val rev: Int? = null,
    val temps: List<EquipmentTempDto> = emptyList(),
    val maintain: List<MaintainDto> = emptyList(),
    val energy: List<EnergyDto> = emptyList(),
    @SerialName("energy_summary") val energySummary: EnergySummaryDto? = null,
    @SerialName("mock_temps") val mockTemps: Boolean? = null
)

@Serializable
data class EquipmentTempDto(
    val device: String? = null,
    val kind: String? = null,
    val temp: Double? = null,
    val max: Double? = null,
    val status: String? = null,
    val minutes: Int? = null,
    val history: List<Double> = emptyList()
)

@Serializable
data class EnergySummaryDto(
    val mock: Boolean? = null,
    val items: List<EnergySummaryItemDto> = emptyList(),
    val total: Double? = null,
    val yoy: String? = null,
    val mom: String? = null,
    val ratio: String? = null
)

@Serializable
data class EnergySummaryItemDto(
    val kind: String? = null,
    val amount: Double? = null,
    val pct: Int? = null
)

@Serializable
data class MaintainDto(
    val id: Int? = null,
    val device: String? = null,
    val kind: String? = null,
    val ts: String? = null,
    val operator: String? = null,
    val note: String? = null
)

@Serializable
data class EnergyDto(
    val id: Int? = null,
    val date: String? = null,
    val device: String? = null,
    val kind: String? = null,
    /** 店内可能推数字或「12度」这类字符串，统一接住再兜底解析，避免整端点解析失败 */
    val usage: JsonElement? = null
) {
    fun usageValue(): Double? = when (val u = usage) {
        is JsonPrimitive -> u.contentOrNull?.toDoubleOrNull()
            ?: Regex("[0-9]+(?:\\.[0-9]+)?").find(u.contentOrNull.orEmpty())?.value?.toDoubleOrNull()
        else -> null
    }

    fun usageText(): String = when (val u = usage) {
        is JsonPrimitive -> u.contentOrNull ?: "-"
        null -> "-"
        else -> u.toString()
    }
}

/** GET /api/modules/finance */
@Serializable
data class FinanceModuleDto(
    val ok: Boolean = false,
    val hint: String? = null,
    val message: String? = null,
    val rev: Int? = null,
    val invoices: List<FinRowDto> = emptyList(),
    val tax: List<FinRowDto> = emptyList(),
    val cash: List<FinRowDto> = emptyList(),
    val split: List<FinSplitDto> = emptyList(),
    val recon: FinanceReconDto? = null,
    val insight: FinanceInsightDto? = null
)

/** 财务洞察：发票额度 + 税务待申报 + 现金流 + 分账冻结 */
@Serializable
data class FinInvoiceInsightDto(
    val count: Int = 0,
    @SerialName("by_direction") val byDirection: Map<String, Double> = emptyMap(),
    @SerialName("by_kind") val byKind: Map<String, Int> = emptyMap(),
    @SerialName("issued_this_month") val issuedThisMonth: Double = 0.0,
    val quota: Double = 0.0,
    val remaining: Double = 0.0,
    @SerialName("usage_pct") val usagePct: Double? = null
)

@Serializable
data class FinTaxPendingDto(
    val kind: String? = null,
    val amount: Double = 0.0,
    val period: String? = null,
    val status: String = ""
)

@Serializable
data class FinTaxInsightDto(
    @SerialName("pending_count") val pendingCount: Int = 0,
    val payable: Double = 0.0,
    @SerialName("by_kind") val byKind: Map<String, Double> = emptyMap(),
    val pending: List<FinTaxPendingDto> = emptyList()
)

@Serializable
data class CashAccountDto(val income: Double = 0.0, val expense: Double = 0.0)

@Serializable
data class FinCashflowInsightDto(
    val income: Double = 0.0,
    val expense: Double = 0.0,
    val net: Double = 0.0,
    @SerialName("by_account") val byAccount: Map<String, CashAccountDto> = emptyMap()
)

@Serializable
data class FinSplitInsightDto(
    val count: Int = 0,
    @SerialName("frozen_count") val frozenCount: Int = 0,
    @SerialName("frozen_amount") val frozenAmount: Double = 0.0,
    @SerialName("frozen_until") val frozenUntil: String? = null
)

@Serializable
data class FinanceInsightDto(
    val invoices: FinInvoiceInsightDto? = null,
    val tax: FinTaxInsightDto? = null,
    val cashflow: FinCashflowInsightDto? = null,
    val split: FinSplitInsightDto? = null,
    val advice: List<String> = emptyList()
)

@Serializable
data class FinanceChannelDto(
    val amount: Double? = null,
    val count: Int? = null
)

@Serializable
data class FinanceReconDto(
    val date: String? = null,
    @SerialName("dine_in") val dineIn: FinanceChannelDto? = null,
    val takeout: FinanceChannelDto? = null,
    val purchase: FinanceChannelDto? = null,
    val gap: Double? = null,
    val confirmed: Boolean = false,
    val ts: String? = null,
    val note: String? = null,
    /** 最近一次已结算的勾兑（今日无数据时展示，避免空屏） */
    val last: FinanceReconDto? = null
)

@Serializable
data class FinRowDto(
    val id: Int? = null,
    val kind: String? = null,
    val amount: Double? = null,
    val status: String? = null,
    val ts: String? = null,
    val period: String? = null,
    val note: String? = null
)

@Serializable
data class FinSplitDto(
    val id: Int? = null,
    val period: String? = null,
    val party: String? = null,
    val amount: Double? = null,
    val ratio: Double? = null,
    @SerialName("frozen_until") val frozenUntil: String? = null,
    val status: String? = null
)

/** GET /api/modules/loss */
@Serializable
data class LossModuleDto(
    val ok: Boolean = false,
    val hint: String? = null,
    val message: String? = null,
    val rev: Int? = null,
    val reports: List<LossReportDto> = emptyList(),
    val insight: LossInsightDto? = null
)

/** 损耗洞察：损耗率 + 归因 + 报损审批 + 盘点差异 */
@Serializable
data class LossIngredientDto(val name: String = "", val amount: Double = 0.0)

@Serializable
data class LossApprovalsDto(
    val pending: Int = 0,
    val approved: Int = 0,
    val rejected: Int = 0,
    @SerialName("big_pending") val bigPending: Int = 0
)

@Serializable
data class LossInventoryDto(
    @SerialName("diff_count") val diffCount: Int = 0,
    @SerialName("loss_qty") val lossQty: Double = 0.0,
    @SerialName("over_qty") val overQty: Double = 0.0
)

@Serializable
data class LossInsightDto(
    @SerialName("total_amount") val totalAmount: Double = 0.0,
    @SerialName("total_qty") val totalQty: Double = 0.0,
    val records: Int = 0,
    @SerialName("loss_rate_pct") val lossRatePct: Double? = null,
    @SerialName("by_reason_amount") val byReasonAmount: Map<String, Double> = emptyMap(),
    @SerialName("by_reason_qty") val byReasonQty: Map<String, Double> = emptyMap(),
    @SerialName("top_ingredients") val topIngredients: List<LossIngredientDto> = emptyList(),
    @SerialName("top_share_pct") val topSharePct: Double? = null,
    val approvals: LossApprovalsDto? = null,
    val inventory: LossInventoryDto? = null,
    val advice: List<String> = emptyList()
)

@Serializable
data class LossReportDto(
    val id: Int? = null,
    val date: String? = null,
    @SerialName("ing_name") val ingName: String? = null,
    val qty: Double? = null,
    val reason: String? = null,
    val status: String? = null
)

/** GET /api/modules/supply */
@Serializable
data class SupplyModuleDto(
    val ok: Boolean = false,
    val hint: String? = null,
    val message: String? = null,
    val rev: Int? = null,
    val suppliers: List<String> = emptyList(),
    val quotes: List<QuoteDto> = emptyList(),
    val accounts: List<SupplyAccountDto> = emptyList(),
    val vendors: List<JsonObject> = emptyList(),
    val insight: SupplyInsightDto? = null
)

/** 供应链洞察：供应商 + 比价 + 账龄 */
@Serializable
data class SupplyVendorRowDto(
    val id: String? = null,
    val name: String = "",
    val category: String = "",
    val status: String = "",
    val period: String = "",
    val level: Double? = null
)

@Serializable
data class SupplyVendorsInsightDto(
    val count: Int = 0,
    @SerialName("by_category") val byCategory: Map<String, Int> = emptyMap(),
    @SerialName("by_status") val byStatus: Map<String, Int> = emptyMap(),
    @SerialName("by_period") val byPeriod: Map<String, Int> = emptyMap(),
    val list: List<SupplyVendorRowDto> = emptyList()
)

@Serializable
data class SupplyPriceRefDto(val src: String = "", val price: Double = 0.0)

@Serializable
data class SupplyCompareRowDto(
    val name: String = "",
    val candidates: Int = 0,
    val best: SupplyPriceRefDto? = null,
    val worst: SupplyPriceRefDto? = null,
    @SerialName("spread_pct") val spreadPct: Double? = null
)

@Serializable
data class SupplyCompareInsightDto(
    val available: Int = 0,
    @SerialName("spread_top") val spreadTop: List<SupplyCompareRowDto> = emptyList(),
    val note: String = ""
)

@Serializable
data class SupplyAgingDto(
    val current: Double = 0.0,
    val over30: Double = 0.0,
    val over60: Double = 0.0,
    val overdue: Double = 0.0
)

@Serializable
data class SupplyAccountsInsightDto(
    val count: Int = 0,
    val payable: Double = 0.0,
    val aging: SupplyAgingDto = SupplyAgingDto(),
    @SerialName("overdue_list") val overdueList: List<String?> = emptyList()
)

@Serializable
data class SupplyInsightDto(
    val vendors: SupplyVendorsInsightDto? = null,
    val compare: SupplyCompareInsightDto? = null,
    val accounts: SupplyAccountsInsightDto? = null,
    val advice: List<String> = emptyList()
)

@Serializable
data class SupplyAccountDto(
    val id: String? = null,
    val supplier: String? = null,
    val period: String? = null,
    val balance: Double? = null,
    val status: String? = null
)

/** POST /api/agent/chat */
@Serializable
data class AgentChatRequest(
    val question: String,
    val ctx: Map<String, String> = emptyMap()
)

/** agent 只读回答附带的可点提案（仍须老板确认台，AI 不直写） */
@Serializable
data class AgentActionCard(
    val title: String,
    val summary: String = "",
    val type: String,
    val payload: JsonObject = JsonObject(emptyMap()),
    @SerialName("cta_label") val ctaLabel: String = "去确认台",
)

@Serializable
data class AgentChatResponse(
    val ok: Boolean = false,
    val answer: String? = null,
    /** 可点 CTA → App ConfirmBus.ask；空=仅问答 */
    val cards: List<AgentActionCard> = emptyList(),
    val suggestions: List<String> = emptyList(),
    /** si = LLM+只读工具已启用；rules = 规则快照降级 */
    val engine: String? = null,
    /** SI 这轮调用过的只读工具（工具执行过程可视化） */
    val steps: List<AgentStepDto> = emptyList(),
    @SerialName("trace_id") val traceId: String? = null,
    val note: String? = null,
    val rev: JsonElement? = null,
    val error: String? = null
) {
    fun revText(): String {
        val e = rev ?: return ""
        return e.jsonPrimitive.contentOrNull
            ?: (e as? JsonPrimitive)?.content
            ?: e.toString().trim('"')
    }
}

/** GET /api/modules/pos —— 堂食收银桌台 + 今日实收 + 洞察 */
@Serializable
data class PosTablesInsightDto(
    val total: Int = 0,
    @SerialName("by_state") val byState: Map<String, Int> = emptyMap(),
    @SerialName("occupancy_pct") val occupancyPct: Int? = null,
    @SerialName("vip_tables") val vipTables: Int = 0
)

@Serializable
data class PosPaymentsInsightDto(
    val count: Int = 0,
    val amount: Double = 0.0,
    @SerialName("by_method") val byMethod: Map<String, Double> = emptyMap(),
    val avg: Double = 0.0
)

@Serializable
data class PosRevenueInsightDto(
    @SerialName("dine_today") val dineToday: Double = 0.0
)

@Serializable
data class PosInsightDto(
    val tables: PosTablesInsightDto? = null,
    val payments: PosPaymentsInsightDto? = null,
    val revenue: PosRevenueInsightDto? = null,
    val advice: List<String> = emptyList()
)

@Serializable
data class PosModuleDto(
    val ok: Boolean = false,
    val hint: String? = null,
    val rev: Int? = null,
    val tables: List<JsonObject> = emptyList(),
    val payments: List<JsonObject> = emptyList(),
    val insight: PosInsightDto? = null
)
