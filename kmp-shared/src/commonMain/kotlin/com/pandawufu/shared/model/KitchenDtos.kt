package com.pandawufu.shared.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

private fun JsonElement?.asRevText(): String =
    this?.jsonPrimitive?.contentOrNull
        ?: this?.jsonPrimitive?.intOrNull?.toString()
        ?: ""

/**
 * BFF/seed 里 tools、inputs、key_points 可能是字符串或字符串数组。
 * 统一收成 List<String>，避免详情解析整页挂掉。
 */
object FlexibleStringListSerializer : KSerializer<List<String>> {
    private val delegate = ListSerializer(String.serializer())
    override val descriptor: SerialDescriptor = delegate.descriptor

    override fun serialize(encoder: Encoder, value: List<String>) =
        encoder.encodeSerializableValue(delegate, value)

    override fun deserialize(decoder: Decoder): List<String> {
        val json = decoder as? JsonDecoder ?: return decoder.decodeSerializableValue(delegate)
        return when (val el = json.decodeJsonElement()) {
            is JsonNull -> emptyList()
            is JsonArray -> el.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.takeIf { s -> s.isNotBlank() } }
            is JsonPrimitive -> el.contentOrNull?.takeIf { it.isNotBlank() }?.let { listOf(it) } ?: emptyList()
            else -> emptyList()
        }
    }
}

/** GET /api/kitchen/recipes 列表项 */
@Serializable
data class RecipeDto(
    @SerialName("sku_id") val skuId: String,
    val name: String,
    /** 五色别：红/黑/黄/绿/紫/白/其他（热/凉/汤/甜）；保本类型亦可能写入 */
    val color: String? = null,
    val filling: String? = null,
    @SerialName("face_main") val faceMain: String? = null,
    // BOM：BFF 未公布元素结构，按字符串行解析；若为对象数组需收紧为 BomLineDto
    val main: List<String> = emptyList(),
    val aux: List<String> = emptyList(),
    val seasoning: List<String> = emptyList(),
    val steps: List<String> = emptyList(),
    val params: JsonObject? = null,
    val blessing: String? = null,
    @SerialName("diet_tags") val dietTags: List<String> = emptyList(),
    /** menu-wufu：jiao5 / jiao_white / jian / zheng；保本：引流/爆品/利润/形象/常规 */
    @SerialName("menu_cat") val menuCat: String? = null,
    @SerialName("menu_id") val menuId: String? = null,
    val subtitle: String? = null,
    @SerialName("face_detail") val faceDetail: String? = null,
    val brief: String? = null,
    /** snapshot | menu | snapshot+menu | baoben */
    val source: String? = null,
    /** 保本测算：食材成本（元/份） */
    val cost: Double? = null,
    /** 保本测算：售价（元） */
    val price: Double? = null,
    @SerialName("cost_rate") val costRate: Double? = null,
    @SerialName("gross_margin") val grossMargin: Double? = null,
    @SerialName("daily_qty") val dailyQty: Double? = null,
    /** 引流/爆品/利润/形象/常规 */
    @SerialName("dish_type") val dishType: String? = null,
    @SerialName("baoben_id") val baobenId: String? = null,
    /** BFF 可能返回数字或字符串 */
    val version: JsonElement? = null,
    @SerialName("updated_at") val updatedAt: String? = null
) {
    fun versionText(): String = version.asRevText()
}

@Serializable
data class RecipesResponse(
    val ok: Boolean = false,
    val items: List<RecipeDto> = emptyList(),
    val count: Int? = null,
    /** BFF 返回数字 rev，兼容字符串 */
    val rev: JsonElement? = null,
    val baoben: BaobenMetaDto? = null,
    @SerialName("baoben_summary") val baobenSummary: BaobenSummaryDto? = null,
    val source: String? = null,
    /** 无快照空开：no_snapshot */
    val hint: String? = null,
    val message: String? = null
) {
    fun revText(): String = rev.asRevText()
}

@Serializable
data class BaobenMetaDto(
    val brand: String? = null,
    val count: Int? = null,
    val source: String? = null
)

@Serializable
data class BaobenSummaryDto(
    val brand: String? = null,
    val source: String? = null,
    val count: Int? = null,
    val kpi: BaobenKpiDto? = null,
    val types: List<BaobenTypeDto> = emptyList(),
    val scenes: List<BaobenSceneDto> = emptyList(),
    val advice: List<String> = emptyList()
)

@Serializable
data class BaobenKpiDto(
    @SerialName("day_rev") val dayRev: Double? = null,
    @SerialName("day_dish_rev") val dayDishRev: Double? = null,
    @SerialName("be_day") val beDay: Double? = null,
    @SerialName("be_guests") val beGuests: Double? = null,
    @SerialName("avg_ticket") val avgTicket: Double? = null,
    @SerialName("month_rev") val monthRev: Double? = null,
    @SerialName("month_profit") val monthProfit: Double? = null,
    val safety: Double? = null,
    @SerialName("fixed_month") val fixedMonth: Double? = null,
    @SerialName("dish_cost_rate") val dishCostRate: Double? = null,
    @SerialName("contribution_margin") val contributionMargin: Double? = null
)

@Serializable
data class BaobenTypeDto(
    val k: String? = null,
    val name: String? = null,
    val desc: String? = null,
    val n: Int? = null,
    val qty: Double? = null,
    val rev: Double? = null,
    val cost: Double? = null,
    val gp: Double? = null,
    @SerialName("cost_rate") val costRate: Double? = null,
    @SerialName("rev_share") val revShare: Double? = null,
    @SerialName("gp_share") val gpShare: Double? = null
)

@Serializable
data class BaobenSceneDto(
    val name: String? = null,
    val k: Double? = null,
    @SerialName("day_rev") val dayRev: Double? = null,
    @SerialName("month_profit") val monthProfit: Double? = null,
    @SerialName("above_be") val aboveBe: Boolean? = null
)

/** SOP 步骤（配方详情与工单共用） */
@Serializable
data class SopStepDto(
    @SerialName("sku_id") val skuId: String? = null,
    @SerialName("step_no") val stepNo: Int = 0,
    val stage: String = "",
    @SerialName("duration_min") val durationMin: Int? = null,
    @Serializable(with = FlexibleStringListSerializer::class)
    val tools: List<String> = emptyList(),
    @Serializable(with = FlexibleStringListSerializer::class)
    val inputs: List<String> = emptyList(),
    @SerialName("key_points")
    @Serializable(with = FlexibleStringListSerializer::class)
    val keyPoints: List<String> = emptyList(),
    @SerialName("qc_point") val qcPoint: String? = null,
    val risk: String? = null,
    val params: JsonObject? = null
)

/** 成本卡 BOM 行（GET /api/kitchen/recipes/{sku} → cost_card.bom_lines） */
@Serializable
data class RecipeCostBomLineDto(
    val name: String? = null,
    @SerialName("qty_text") val qtyText: String? = null,
    @SerialName("line_cost") val lineCost: Double? = null,
    /** 是否匹配到库存/档案价；false 计入 missing_ings */
    val matched: Boolean? = null
)

/** 菜谱成本卡（BFF 批2 新增；未部署时整条为 null，UI 不渲染） */
@Serializable
data class RecipeCostCardDto(
    @SerialName("bom_lines") val bomLines: List<RecipeCostBomLineDto> = emptyList(),
    @SerialName("batch_cost") val batchCost: Double? = null,
    @SerialName("unit_cost") val unitCost: Double? = null,
    val price: Double? = null,
    /** 可能为比率（0.62）或百分数（62），展示侧兜底 */
    @SerialName("gross_margin") val grossMargin: Double? = null,
    @SerialName("missing_ings") val missingIngs: List<String> = emptyList()
)

@Serializable
data class RecipeDetailResponse(
    val ok: Boolean = false,
    val item: RecipeDto? = null,
    val steps: List<SopStepDto> = emptyList(),
    @SerialName("cost_card") val costCard: RecipeCostCardDto? = null,
    val rev: JsonElement? = null
) {
    fun revText(): String = rev.asRevText()
}

/** GET /api/sop/workorder?date= */
@Serializable
data class WorkorderDto(
    val id: String,
    @SerialName("sku_id") val skuId: String,
    val name: String = "",
    val color: String? = null,
    val qty: Int = 0,
    @SerialName("planned_start") val plannedStart: String? = null,
    val status: String = "待开始",
    /** 挂桌：前厅传菜对桌 */
    @SerialName("table_id") val tableId: String? = null,
    @SerialName("table_no") val tableNo: String? = null,
    val steps: List<SopStepDto> = emptyList()
) {
    fun tableLabel(): String? =
        tableNo?.takeIf { it.isNotBlank() } ?: tableId?.takeIf { it.isNotBlank() }
}

@Serializable
data class WorkordersResponse(
    val ok: Boolean = false,
    val date: String? = null,
    val count: Int? = null,
    val workorders: List<WorkorderDto> = emptyList(),
    val rev: JsonElement? = null,
    val hint: String? = null,
    val message: String? = null
) {
    fun revText(): String = rev.asRevText()
}

/** GET /api/kitchen/qc?date= —— BFF 未公布 item 结构，宽松建模，补契约后收紧 */
@Serializable
data class QcRecordDto(
    val id: String? = null,
    @SerialName("sku_id") val skuId: String? = null,
    val name: String? = null,
    val color: String? = null,
    @SerialName("check_type") val checkType: String? = null,
    val result: String? = null,
    val rate: Double? = null,
    val note: String? = null,
    val inspector: String? = null,
    val ts: String? = null
)

@Serializable
data class QcResponse(
    val ok: Boolean = false,
    val items: List<QcRecordDto> = emptyList(),
    val rev: JsonElement? = null
) {
    fun revText(): String = rev.asRevText()
}

/** GET /api/kitchen/board?date= → {ok, items, demand, takeout_open} */
@Serializable
data class BoardItemDto(
    val color: String,
    val planned: Int = 0,
    val done: Int = 0,
    val doing: Int = 0,
    @SerialName("qc_pass_rate") val qcPassRate: Double? = null
)

@Serializable
data class BoardTakeoutDto(
    val id: JsonElement? = null,
    val platform: String? = null,
    @SerialName("platform_no") val platformNo: String? = null,
    val amount: Double? = null,
    val status: String? = null,
    val ts: String? = null
) {
    fun idText(): String =
        id?.jsonPrimitive?.contentOrNull
            ?: id?.jsonPrimitive?.intOrNull?.toString()
            ?: ""
}

/** 出品看板 · 按桌待传（工单挂 table_id） */
@Serializable
data class BoardTablePassDto(
    @SerialName("table_id") val tableId: String,
    @SerialName("table_no") val tableNo: String? = null,
    val pending: Int = 0,
    val doing: Int = 0,
    /** 已齐待传（status=待传） */
    val ready: Int = 0,
    val colors: List<BoardTableColorDto> = emptyList(),
    val items: List<BoardTableItemDto> = emptyList()
) {
    fun tableLabel(): String = tableNo?.takeIf { it.isNotBlank() } ?: tableId
}

@Serializable
data class BoardTableColorDto(
    val color: String,
    val qty: Int = 0
)

@Serializable
data class BoardTableItemDto(
    val id: String? = null,
    @SerialName("sku_id") val skuId: String? = null,
    val name: String? = null,
    val color: String? = null,
    val qty: Int = 0,
    val status: String? = null
)

@Serializable
data class BoardResponse(
    val ok: Boolean = false,
    val items: List<BoardItemDto> = emptyList(),
    val board: List<BoardItemDto> = emptyList(),
    /** 未完成工单按桌聚合 · 前厅传菜挂号 */
    val tables: List<BoardTablePassDto> = emptyList(),
    val demand: KitchenDemandDto? = null,
    @SerialName("takeout_open") val takeoutOpen: List<BoardTakeoutDto> = emptyList(),
    val rev: JsonElement? = null
) {
    fun revText(): String = rev.asRevText()
    fun boardItems(): List<BoardItemDto> = if (items.isNotEmpty()) items else board
}

/** GET /api/kitchen/demand */
@Serializable
data class KitchenDemandDto(
    val ok: Boolean = false,
    val date: String? = null,
    @SerialName("booking_tables") val bookingTables: Int = 0,
    @SerialName("booking_heads") val bookingHeads: Int = 0,
    @SerialName("takeout_open") val takeoutOpen: Int = 0,
    @SerialName("suggest_portions") val suggestPortions: Int = 0,
    @SerialName("workorder_planned") val workorderPlanned: Int = 0,
    val gap: Int = 0,
    @SerialName("suggest_workorders") val suggestWorkorders: List<DemandSuggestWoDto> = emptyList(),
    @SerialName("takeout_orders") val takeoutOrders: List<BoardTakeoutDto> = emptyList()
)

@Serializable
data class DemandSuggestWoDto(
    @SerialName("sku_id") val skuId: String = "",
    val name: String? = null,
    val color: String? = null,
    val qty: Int = 0,
    val reason: String? = null
)

/** POST /api/auth/login {account, password?, device_fp} */
@Serializable
data class LoginRequest(
    val account: String,
    @SerialName("device_fp") val deviceFp: String,
    val password: String? = null
)

@Serializable
data class LoginResponse(
    val ok: Boolean = false,
    val token: String? = null,
    val role: String? = null,
    val account: String? = null,
    @SerialName("expires_at") val expiresAt: String? = null,
    @SerialName("display_name") val displayName: String? = null,
    @SerialName("store_id") val storeId: String? = null,
    @SerialName("store_name") val storeName: String? = null,
    @SerialName("position_id") val positionId: String? = null,
    @SerialName("position_name") val positionName: String? = null,
    val permissions: List<String> = emptyList(),
    @SerialName("can_write") val canWrite: Boolean? = null,
    @SerialName("wechat_demo") val wechatDemo: Boolean? = null,
    val error: String? = null
)

@Serializable
data class WechatLoginRequest(
    val code: String,
    @SerialName("device_fp") val deviceFp: String,
    val account: String? = null,
    val password: String? = null,
    @SerialName("invite_code") val inviteCode: String? = null
)

@Serializable
data class WechatAuthConfig(
    val ok: Boolean = false,
    val enabled: Boolean = false,
    @SerialName("app_id") val appId: String? = null,
    val demo: Boolean = false,
    val note: String? = null
)

/** GET /api/auth/me */
@Serializable
data class AuthMeResponse(
    val ok: Boolean = false,
    val user: AuthUserDto? = null,
    val error: String? = null
)

@Serializable
data class AuthUserDto(
    val account: String? = null,
    val role: String? = null,
    @SerialName("display_name") val displayName: String? = null,
    @SerialName("store_id") val storeId: String? = null,
    @SerialName("store_name") val storeName: String? = null,
    @SerialName("position_id") val positionId: String? = null,
    @SerialName("position_name") val positionName: String? = null,
    val permissions: List<String> = emptyList(),
    @SerialName("can_write") val canWrite: Boolean? = null
)

/** GET /api/actions */
@Serializable
data class ActionsListResponse(
    val ok: Boolean = false,
    val count: Int = 0,
    val items: List<ActionListItemDto> = emptyList(),
    val error: String? = null
)

@Serializable
data class ActionListItemDto(
    val id: String? = null,
    val type: String? = null,
    val status: String? = null,
    val operator: String? = null,
    val payload: JsonObject? = null,
    val rev: JsonElement? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("confirmed_at") val confirmedAt: String? = null,
    @SerialName("executed_at") val executedAt: String? = null,
    val error: String? = null,
    @SerialName("trace_id") val traceId: String? = null
)

@Serializable
data class RegisterRequest(
    val account: String,
    val password: String,
    @SerialName("invite_code") val inviteCode: String,
    @SerialName("display_name") val displayName: String? = null,
    @SerialName("device_fp") val deviceFp: String? = null,
    @SerialName("position_id") val positionId: String? = null
)

/** GET /api/org */
@Serializable
data class OrgOverviewResponse(
    val ok: Boolean = false,
    val stores: List<OrgStoreDto> = emptyList(),
    val positions: List<OrgPositionDto> = emptyList(),
    val users: List<OrgUserDto> = emptyList(),
    val modules: List<String> = emptyList(),
    @SerialName("invite_hint") val inviteHint: String? = null,
    val error: String? = null
)

@Serializable
data class OrgStoreDto(
    val id: String? = null,
    val name: String? = null,
    val brand: String? = null,
    val city: String? = null,
    val address: String? = null,
    val status: String? = null
)

@Serializable
data class OrgPositionDto(
    val id: String? = null,
    val name: String? = null,
    val write: Boolean? = null,
    val permissions: List<String> = emptyList()
)

@Serializable
data class OrgUserDto(
    val id: String? = null,
    val account: String? = null,
    @SerialName("display_name") val displayName: String? = null,
    val role: String? = null,
    @SerialName("position_id") val positionId: String? = null,
    @SerialName("position_name") val positionName: String? = null,
    @SerialName("store_id") val storeId: String? = null,
    @SerialName("store_name") val storeName: String? = null,
    val permissions: List<String> = emptyList(),
    @SerialName("can_write") val canWrite: Boolean? = null
)
