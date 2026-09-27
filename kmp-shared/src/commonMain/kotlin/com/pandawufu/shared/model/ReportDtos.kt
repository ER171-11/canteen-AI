package com.pandawufu.shared.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * GET /api/report/daily
 * 对齐 BFF：banner 为字符串；rev 可为 number/string；heat_mini 为 {hour,orders}[]；
 * todos 为 {text,done}；alerts 为 {level,text}。
 */
@Serializable
data class ReportDailyDto(
    val ok: Boolean = false,
    val mock: Boolean? = null,
    val date: String = "",
    /** BFF 可能返回数字或字符串 */
    val rev: JsonElement? = null,
    @SerialName("generated_at") val generatedAt: String? = null,
    val banner: String? = null,
    /** 精简一句话晨报（营收/保本差/风险/待办），首页可直接展示 */
    val summary: String? = null,
    val kpi: List<KpiDto> = emptyList(),
    @SerialName("heat_mini") val heatMini: List<HeatMiniDto> = emptyList(),
    val todos: List<TodoDto> = emptyList(),
    val alerts: List<AlertDto> = emptyList(),
    val kitchen: JsonObject? = null,
    /** 打烊日清：售出 / 入库 / 报损 */
    @SerialName("day_close") val dayClose: DayCloseDto? = null
) {
    fun revText(): String =
        rev?.jsonPrimitive?.contentOrNull
            ?: rev?.jsonPrimitive?.intOrNull?.toString()
            ?: ""
}

@Serializable
data class DayCloseDto(
    val sold: DayCloseLineDto? = null,
    val inbound: DayCloseLineDto? = null,
    val loss: DayCloseLineDto? = null,
    @SerialName("workorders_open") val workordersOpen: Int? = null
)

@Serializable
data class DayCloseLineDto(
    val label: String? = null,
    val count: Int? = null,
    val amount: Double? = null,
    val route: String? = null
)

@Serializable
data class HeatMiniDto(
    val hour: Int? = null,
    val orders: Int? = null
)

@Serializable
data class KpiDto(
    val label: String = "",
    val value: String = "",
    val delta: String? = null,
    val up: Boolean? = null
)

@Serializable
data class TodoDto(
    val id: String? = null,
    val text: String? = null,
    val title: String? = null,
    val desc: String? = null,
    val done: Boolean? = null,
    /** restock | prep | channel_takeout | channel_booking */
    val kind: String? = null,
    /** App 路由，如 inventory/restock、kitchen、m/takeout */
    val route: String? = null,
    val amount: String? = null
) {
    fun displayText(): String = text ?: title ?: ""
}

@Serializable
data class AlertDto(
    val id: String? = null,
    val text: String? = null,
    val title: String? = null,
    val desc: String? = null,
    val level: String = "info",
    val target: String? = null
) {
    fun displayText(): String = text ?: title ?: ""
}
