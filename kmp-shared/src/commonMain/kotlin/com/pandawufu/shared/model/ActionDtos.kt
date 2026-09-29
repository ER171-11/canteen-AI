package com.pandawufu.shared.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/**
 * 写操作状态 ↔ BFF 线态：
 * queued → PENDING（草稿，待用户确认）
 * 待执行 → CONFIRMED（已确认，待消费器）
 * 已执行 → EXECUTED
 * 已驳回 / 已过期 → REJECTED
 */
@Serializable(with = ActionStatusSerializer::class)
enum class ActionStatus {
    PENDING, CONFIRMED, EXECUTED, REJECTED;

    fun toWire(): String = when (this) {
        PENDING -> "queued"
        CONFIRMED -> "待执行"
        EXECUTED -> "已执行"
        REJECTED -> "已驳回"
    }

    companion object {
        fun fromWire(raw: String?): ActionStatus = when (raw?.trim()) {
            "queued", "PENDING", "pending" -> PENDING
            "待执行", "CONFIRMED", "confirmed" -> CONFIRMED
            "已执行", "EXECUTED", "executed" -> EXECUTED
            "已驳回", "已过期", "REJECTED", "rejected", "expired" -> REJECTED
            else -> PENDING
        }
    }
}

object ActionStatusSerializer : KSerializer<ActionStatus> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("ActionStatus", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: ActionStatus) =
        encoder.encodeString(value.toWire())

    override fun deserialize(decoder: Decoder): ActionStatus =
        ActionStatus.fromWire(decoder.decodeString())
}

/** 端侧动作模型（经 ConfirmGateway） */
@Serializable
data class ActionDto(
    val id: String,
    val type: String,
    val payload: JsonObject = JsonObject(emptyMap()),
    val status: ActionStatus = ActionStatus.PENDING,
    val operator: String? = null,
    @SerialName("base_rev") val baseRev: String? = null,
    val rev: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("confirmed_at") val confirmedAt: String? = null,
    @SerialName("trace_id") val traceId: String? = null,
    val error: String? = null
)

/** POST /api/actions 入队请求 */
@Serializable
data class ActionEnqueueRequest(
    val type: String,
    val payload: JsonObject = JsonObject(emptyMap()),
    val operator: String? = null
)

/** POST /api/actions/{id}/confirm 请求 */
@Serializable
data class ActionConfirmRequest(
    val operator: String? = null,
    val rev: String? = null
)

@Serializable
data class ActionEnqueueResponse(
    val ok: Boolean = false,
    val id: String? = null,
    val status: String? = null,
    val rev: JsonElement? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("trace_id") val traceId: String? = null,
    val dedup: Boolean? = null,
    val error: String? = null
) {
    fun revText(): String =
        rev?.let {
            when (it) {
                is JsonPrimitive -> it.contentOrNull ?: it.toString().trim('"')
                else -> it.toString()
            }
        } ?: ""
}

/** POST /api/actions/{id}/confirm 响应 */
@Serializable
data class ActionConfirmResponse(
    val ok: Boolean = false,
    val id: String? = null,
    val status: String? = null,
    val rev: JsonElement? = null,
    @SerialName("confirmed_at") val confirmedAt: String? = null,
    val error: String? = null,
    @SerialName("expected_rev") val expectedRev: JsonElement? = null,
    @SerialName("got_rev") val gotRev: JsonElement? = null
)

/** POST /api/actions/{id}/reject */
@Serializable
data class ActionRejectRequest(
    val reason: String? = null,
    val error: String? = null
)

@Serializable
data class ActionRejectResponse(
    val ok: Boolean = false,
    val id: String? = null,
    val status: String? = null,
    val error: String? = null
)

/** GET|POST /api/actions/{id}/status */
@Serializable
data class ActionStatusResponse(
    val ok: Boolean = false,
    val id: String? = null,
    val status: String? = null,
    @SerialName("executed_at") val executedAt: String? = null,
    val error: String? = null,
    /** 消费器回写的人话摘要（如 dish.auto_link 关联统计） */
    val desc: String? = null,
    val result: JsonObject? = null
)

/** POST /api/org/users */
@Serializable
data class OrgCreateUserRequest(
    val account: String,
    val password: String? = null,
    @SerialName("display_name") val displayName: String? = null,
    @SerialName("position_id") val positionId: String? = null,
    @SerialName("store_id") val storeId: String? = null
)

@Serializable
data class OrgCreateUserResponse(
    val ok: Boolean = false,
    val user: OrgUserBriefDto? = null,
    val error: String? = null
)

@Serializable
data class OrgUserBriefDto(
    val id: String? = null,
    val account: String? = null,
    @SerialName("display_name") val displayName: String? = null,
    val role: String? = null,
    @SerialName("position_id") val positionId: String? = null,
    @SerialName("store_id") val storeId: String? = null,
    val status: String? = null
)

/** POST /api/org/stores */
@Serializable
data class OrgCreateStoreRequest(
    val name: String,
    val brand: String? = null,
    val city: String? = null,
    val address: String? = null,
    val status: String? = "筹备中"
)

@Serializable
data class OrgCreateStoreResponse(
    val ok: Boolean = false,
    val store: OrgStoreBriefDto? = null,
    val error: String? = null
)

@Serializable
data class OrgStoreBriefDto(
    val id: String? = null,
    val name: String? = null,
    val brand: String? = null,
    val city: String? = null,
    val address: String? = null,
    val status: String? = null
)

/** POST /api/org/stores/update — 改现有门店资料 */
@Serializable
data class OrgUpdateStoreRequest(
    val id: String,
    val name: String? = null,
    val brand: String? = null,
    val city: String? = null,
    val address: String? = null,
    val status: String? = null
)

@Serializable
data class OrgUpdateStoreResponse(
    val ok: Boolean = false,
    val store: OrgStoreBriefDto? = null,
    val error: String? = null
)

/** GET /api/admin/config */
@Serializable
data class AdminConfigResponse(
    val ok: Boolean = false,
    val config: JsonObject? = null,
    val source: String? = null,
    val rev: JsonElement? = null,
    val error: String? = null
)

/** POST /api/org/users/update */
@Serializable
data class OrgUpdateUserRequest(
    val account: String,
    @SerialName("display_name") val displayName: String? = null,
    @SerialName("position_id") val positionId: String? = null,
    @SerialName("store_id") val storeId: String? = null,
    val status: String? = null
)

@Serializable
data class OrgUpdateUserResponse(
    val ok: Boolean = false,
    val user: OrgUserBriefDto? = null,
    val error: String? = null
)

/** POST /api/org/users/reset-password（需 org.write；password 缺省后端用默认密码） */
@Serializable
data class OrgResetPasswordRequest(
    val account: String,
    val password: String? = null
)

@Serializable
data class OrgResetPasswordResponse(
    val ok: Boolean = false,
    val account: String? = null,
    val reset: Boolean = false,
    val error: String? = null
)

fun Map<String, String>.toJsonObject(): JsonObject = buildJsonObject {
    forEach { (k, v) -> put(k, v) }
}

/**
 * 动作队列 payload 序列化：`explicitNulls = false` 让值为 null 的字段直接缺席。
 *
 * 这一点对 A 块很关键：BFF 的 `applyQcExtras` 只在 payload 真的提供了某列时才写库，
 * 所以「照片没上传成功」必须是**不下发 photo_url**，而不是下发 `photo_url: null`，
 * 否则会把已有照片引用覆盖成空。
 */
@PublishedApi
internal val payloadJson = Json {
    encodeDefaults = false
    explicitNulls = false
    ignoreUnknownKeys = true
}

/** 任意 @Serializable DTO → 动作 payload */
inline fun <reified T> toPayload(value: T): JsonObject =
    payloadJson.encodeToJsonElement(value).jsonObject
