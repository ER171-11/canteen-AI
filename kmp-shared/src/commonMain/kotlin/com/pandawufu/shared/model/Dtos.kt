package com.pandawufu.shared.model

import kotlinx.serialization.Serializable

/** GET /api/health */
@Serializable
data class HealthDto(
    val ok: Boolean,
    val service: String = "",
    val rev: String? = null,
    val keyLoaded: Boolean? = null,
    val time: String? = null
)

/** GET /api/snapshot/latest —— 见 model/SnapshotDtos.kt（Sprint 1 起对齐 BFF 真实契约） */

/** GET /api/report/daily —— 日报（只读） */
@Serializable
data class ReportDailyDto(
    val date: String,
    val rev: String,
    val revenue: Double = 0.0,
    val orders: Int = 0,
    val grossMargin: Double? = null,
    val topItems: List<TopItemDto> = emptyList()
)

@Serializable
data class TopItemDto(
    val name: String,
    val qty: Int,
    val margin: Double? = null
)

/** 写操作四态：草稿 → 已确认 → 已执行 / 已驳回 */
@Serializable
enum class ActionStatus { PENDING, CONFIRMED, EXECUTED, REJECTED }

/** POST /api/actions 的请求/响应。一切端侧写操作必须经 ConfirmGateway 落到这里。 */
@Serializable
data class ActionDto(
    val id: String,
    val type: String,
    val payload: Map<String, String> = emptyMap(),
    val status: ActionStatus = ActionStatus.PENDING,
    val baseRev: String? = null,
    val rev: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null
)

/** POST /api/kimi/vision(/stream) 入参 */
@Serializable
data class KimiVisionRequest(
    val type: String,
    val imageBase64: String,
    val ctx: Map<String, String> = emptyMap()
)

/**
 * BFF 出参 result，形状对齐原型 renderKimiCard：
 * rows 为三元组 [item, value, status]，status ∈ pass|fail|warn；conf 形如 "95%"。
 */
@Serializable
data class KimiResultDto(
    val title: String,
    val rows: List<List<String>> = emptyList(),
    val note: String = "",
    val cta: String = "",
    val conf: String = ""
)

@Serializable
data class KimiVisionResponse(
    val ok: Boolean,
    val result: KimiResultDto? = null,
    val error: String? = null,
    val model: String? = null,
    val traceId: String? = null
)

/** Kimi 识别行状态（对应 rows[*][2]） */
enum class KimiRowStatus(val wire: String) {
    PASS("pass"), FAIL("fail"), WARN("warn");

    companion object {
        fun of(wire: String?): KimiRowStatus =
            entries.firstOrNull { it.wire == wire } ?: WARN
    }
}
