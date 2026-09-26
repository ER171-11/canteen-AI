package com.pandawufu.shared.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

/** GET /api/health —— BFF 返回 rev 为数字；兼容字符串 */
@Serializable
data class HealthDto(
    val ok: Boolean = false,
    val service: String = "",
    val models: List<String> = emptyList(),
    @SerialName("key_loaded") val keyLoaded: Boolean? = null,
    val rev: JsonElement? = null,
    val time: String? = null
) {
    fun revText(): String =
        rev?.jsonPrimitive?.contentOrNull
            ?: rev?.jsonPrimitive?.intOrNull?.toString()
            ?: ""
}

/** GET /api/snapshot/latest —— 见 model/SnapshotDtos.kt（Sprint 1 起对齐 BFF 真实契约） */

/** GET /api/report/daily —— 见 model/ReportDtos.kt（Sprint 2 起对齐 BFF 新契约） */

/** 写操作 ActionDto / ActionStatus —— 见 model/ActionDtos.kt */

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
