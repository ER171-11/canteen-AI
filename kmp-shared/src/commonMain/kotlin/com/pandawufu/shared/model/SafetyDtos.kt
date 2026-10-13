package com.pandawufu.shared.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * 食安拍照上报 DTO（对应 `bff/routes/safety.js` 的 GET /api/safety/progress 与 `docs/safety-schema.md`）。
 *
 * 三条不可动摇的约定：
 *  1. 员工端**不等待 AI**：上报只产生 `ai_result=pending` 的记录，AI 初判由 BFF 的 `safety.ai_judge` 异步回填；
 *  2. `photoUrl` 只是对象存储引用（图片**永不**经 BFF、不入库）；未配置对象存储时降级为空；
 *  3. AI 初判（[SafetyProgressPointDto.aiResult]）与人工结论（[SafetyProgressPointDto.finalResult]）
 *     分列存储，**人工优先**——端侧不得用 AI 结果覆盖人工复核。
 */

/** 上报载荷（POST /api/actions，type=safety.check） */
@Serializable
data class SafetyCheckRequest(
    @SerialName("point_id") val pointId: String,
    /** 直传对象存储后拿到的访问地址；未配置对象存储时为空（BFF 仍记录上报，AI 初判会记 error） */
    @SerialName("photo_url") val photoUrl: String? = null,
    /** 现场拍摄时刻（ISO8601）；缺省由算法补执行时刻 */
    @SerialName("taken_at") val takenAt: String? = null,
    val operator: String? = null,
    @SerialName("store_id") val storeId: String? = null
)

/** 单点进度行：点位 + 当日最新核验记录 */
@Serializable
data class SafetyProgressPointDto(
    @SerialName("point_id") val pointId: String,
    val name: String = "",
    val zone: String = "",
    /** 核验要点（AI 判定依据，员工端可提示「拍什么」） */
    val target: String? = null,
    @SerialName("demo_image_url") val demoImageUrl: String? = null,
    /** none | pending | pass | fail | review | error */
    val status: String = "none",
    @SerialName("check_id") val checkId: String? = null,
    val operator: String? = null,
    @SerialName("photo_url") val photoUrl: String? = null,
    /** pending | pass | fail | error */
    @SerialName("ai_result") val aiResult: String? = null,
    @SerialName("ai_reason") val aiReason: String? = null,
    @SerialName("ai_confidence") val aiConfidence: Double? = null,
    /** pass | fail | null（null = 未复核） */
    @SerialName("final_result") val finalResult: String? = null,
    @SerialName("review_reason") val reviewReason: String? = null,
    @SerialName("reviewed_by") val reviewedBy: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    /** 派生口径：人工优先，AI 兜底（pending/error 时为 null） */
    @SerialName("effective_result") val effectiveResult: String? = null
) {
    /** 今日是否已上报 */
    fun reported(): Boolean = !checkId.isNullOrBlank()

    /** 展示态文案（与 admin-web 的 STATUS_META 对齐） */
    fun statusLabel(): String = when (status) {
        "pending" -> "待 AI 初判"
        "pass" -> "合格"
        "fail" -> "不合格"
        "review" -> "待人工复核"
        "error" -> "AI 初判失败"
        else -> "未上报"
    }

    /** 员工端一句话提示（含 AI 初判依据，便于自查自纠） */
    fun hint(): String = when (status) {
        "pending" -> "已上报，待确认"
        "pass" -> "已确认合格"
        "fail" -> "不合格" + (aiReason?.takeIf { it.isNotBlank() }?.let { "：$it" } ?: "")
        "review" -> "待店长复核" + (aiReason?.takeIf { it.isNotBlank() }?.let { "：$it" } ?: "")
        "error" -> "AI 初判失败，待人工确认"
        else -> target?.takeIf { it.isNotBlank() } ?: "请按核验要点拍照上报"
    }
}

/** GET /api/safety/progress 响应 */
@Serializable
data class SafetyProgressDto(
    val ok: Boolean = false,
    val date: String = "",
    @SerialName("total_points") val totalPoints: Int = 0,
    @SerialName("completed_points") val completedPoints: Int = 0,
    @SerialName("pass_count") val passCount: Int = 0,
    @SerialName("fail_count") val failCount: Int = 0,
    @SerialName("review_count") val reviewCount: Int = 0,
    @SerialName("error_count") val errorCount: Int = 0,
    /** true = BFF 内置种子点位（门店尚未落 data.safety.points） */
    @SerialName("using_defaults") val usingDefaults: Boolean = false,
    val points: List<SafetyProgressPointDto> = emptyList(),
    /** BFF 可能返回数字或字符串 */
    val rev: JsonElement? = null,
    /** no_snapshot = 尚未收到店内快照（仍回内置点位空开） */
    val hint: String? = null
) {
    /** 复核入口可见性（老板/店长） */
    fun canReview(role: String?): Boolean = role == "老板" || role == "店长"
}
