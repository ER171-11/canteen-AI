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
    val train: List<StaffTrainDto> = emptyList()
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
    val serves: List<QueueServeDto> = emptyList()
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
    val disinfect: List<FsDisinfectDto> = emptyList()
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
    @SerialName("hours_left") val hoursLeft: Double? = null
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
    val forecast: AnalysisForecastDto? = null,
    @SerialName("baoben_summary") val baobenSummary: BaobenSummaryDto? = null,
    @SerialName("baoben_types") val baobenTypes: List<BaobenTypeDto> = emptyList()
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
    @SerialName("dish_type") val dishType: String? = null
)

@Serializable
data class AnalysisEfficiencyDto(
    @SerialName("avg_ticket") val avgTicket: Double? = null,
    @SerialName("daily_avg_revenue") val dailyAvgRevenue: Double? = null,
    @SerialName("total_orders") val totalOrders: Int? = null
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
    val visits: List<VipVisitDto> = emptyList()
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
    val reconcile: List<TakeoutReconcileDto> = emptyList()
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
    val improve: List<ImproveDto> = emptyList()
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
    val recon: FinanceReconDto? = null
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
    val confirmed: Boolean = false
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
    val reports: List<LossReportDto> = emptyList()
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
    val accounts: List<SupplyAccountDto> = emptyList()
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
