package com.pandawufu.shared.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * A 块「AI 品控识别与视频教材」的媒体通道 DTO。
 *
 * 与 `bff/routes/qc_media.js` 一一对应。三条不可动摇的约定：
 *  1. 图片**永不**经过 BFF：App 先取预签名 URL，再把压缩后的 JPEG 直传对象存储；
 *     请求体里带 base64 会被 BFF 以 400 image_payload_rejected 驳回。
 *  2. 未配置对象存储时 BFF 返回 `configured=false`（降级而非报错），
 *     品控照常识别落库，只是 photoUrl 为空，UI 需明确标注「图片不可用」。
 *  3. `photoKey` 是对象键（长期可追溯），`photoUrl` 可能是 CDN 直链也可能为空；
 *     读图统一走 `/api/qc/media/sign` 换取带签名的临时 URL。
 */

/** GET /api/qc/media/status — 决定是否展示「图片不可用」降级标注 */
@Serializable
data class QcMediaStatusDto(
    val ok: Boolean = false,
    val configured: Boolean = false,
    /** 未配置时列出的缺失环境变量，用于给运维明确的补齐清单 */
    val missing: List<String> = emptyList(),
    val host: String? = null,
    val bucket: String? = null,
    val region: String? = null,
    val service: String? = null,
    @SerialName("path_style") val pathStyle: Boolean = false,
    @SerialName("public_base") val publicBase: Boolean = false,
    @SerialName("expire_sec") val expireSec: Int? = null
)

/** POST /api/qc/media/presign — 取上传 URL（请求体） */
@Serializable
data class QcPresignRequest(
    @SerialName("workorder_id") val workorderId: String,
    @SerialName("store_id") val storeId: String? = null,
    @SerialName("sku_id") val skuId: String? = null,
    val date: String? = null,
    /** 默认 jpg */
    val ext: String? = null,
    @SerialName("content_type") val contentType: String? = null
)

/** POST /api/qc/media/presign — 响应；configured=false 时只有 hint，无 key/uploadUrl */
@Serializable
data class QcPresignResponse(
    val ok: Boolean = false,
    val configured: Boolean = false,
    val code: String? = null,
    val key: String? = null,
    val method: String = "PUT",
    @SerialName("upload_url") val uploadUrl: String? = null,
    val headers: Map<String, String> = emptyMap(),
    @SerialName("expires_in") val expiresIn: Int? = null,
    @SerialName("photo_url") val photoUrl: String? = null,
    @SerialName("public_base") val publicBase: Boolean = false,
    @SerialName("store_id") val storeId: String? = null,
    val missing: List<String> = emptyList(),
    val hint: String? = null,
    val error: String? = null
) {
    /** 是否可直接上传（未配置对象存储时为 false，调用方须降级） */
    fun canUpload(): Boolean = ok && configured && !key.isNullOrBlank() && !uploadUrl.isNullOrBlank()
}

/** POST /api/qc/media/sign — 批量换取读图 URL（请求体） */
@Serializable
data class QcSignRequest(
    val keys: List<String> = emptyList(),
    val expires: Int? = null
)

/** 单条签名读图 URL */
@Serializable
data class QcSignedUrlDto(
    val key: String,
    val url: String,
    @SerialName("expires_in") val expiresIn: Int? = null,
    @SerialName("public_url") val publicUrl: String? = null
)

/** POST /api/qc/media/sign — 响应；skipped 为路径非法或无法签名的键数 */
@Serializable
data class QcSignResponse(
    val ok: Boolean = false,
    val configured: Boolean = false,
    val code: String? = null,
    val items: List<QcSignedUrlDto> = emptyList(),
    val skipped: Int = 0,
    val count: Int = 0
) {
    fun urlOf(key: String): String? =
        items.firstOrNull { it.key == key }?.let { it.publicUrl ?: it.url }
}

/**
 * 品控判定结果（端侧识别 + BFF 落库的同一份口径）。
 * 合格/不合格/临界三态直接决定判定卡颜色与能否锁定工单。
 */
@Serializable
data class QcVerdictDto(
    @SerialName("workorder_id") val workorderId: String? = null,
    @SerialName("sku_id") val skuId: String? = null,
    val name: String? = null,
    /** true=合格；false=不合格；null=临界/未判定 */
    val pass: Boolean? = null,
    /** 置信度 0-100 */
    val conf: Double? = null,
    /** 触发人工复核（置信度不足阈值或临界项） */
    @SerialName("manual_review") val manualReview: Boolean = false,
    /** 缺陷项，如「裂纹」「开口」「花纹不符」「褶纹不均」「色泽偏差」「形态塌陷」「重量偏差」 */
    @SerialName("defect_items") val defectItems: List<String> = emptyList(),
    /** 所属工序环节，用于环节追溯 */
    val stage: String? = null,
    val operator: String? = null,
    val station: String? = null,
    @SerialName("photo_key") val photoKey: String? = null,
    @SerialName("photo_url") val photoUrl: String? = null,
    val ts: String? = null
) {
    /** 判定三态：合格 / 不合格 / 临界待复核 */
    fun level(): QcVerdictLevel = when {
        manualReview -> QcVerdictLevel.REVIEW
        pass == true -> QcVerdictLevel.PASS
        pass == false -> QcVerdictLevel.FAIL
        else -> QcVerdictLevel.REVIEW
    }

    /** 不合格必须锁定工单，阻止标记完成/传菜 */
    fun locksWorkorder(): Boolean = pass == false
}

/** 判定三态（对应绿 / 红 / 橙三种判定卡） */
enum class QcVerdictLevel(val label: String) {
    PASS("合格"),
    FAIL("不合格"),
    REVIEW("人工复核")
}

/** 品控识别请求（走 POST /api/actions，type=qc.record；图片走 photoKey/photoUrl 引用） */
@Serializable
data class QcRecordRequest(
    @SerialName("workorder_id") val workorderId: String,
    @SerialName("sku_id") val skuId: String? = null,
    val pass: Boolean,
    val conf: Double? = null,
    @SerialName("manual_review") val manualReview: Boolean = false,
    @SerialName("defect_items") val defectItems: List<String> = emptyList(),
    val stage: String? = null,
    val operator: String? = null,
    val station: String? = null,
    @SerialName("photo_key") val photoKey: String? = null,
    @SerialName("photo_url") val photoUrl: String? = null,
    @SerialName("store_id") val storeId: String? = null,
    val note: String? = null
)

/**
 * 强制放行（POST /api/actions，type=qc.force_pass）。
 * 需求硬约束：厨师长可以放行，但**必须填原因**，且系统留痕操作人与时刻。
 * BFF 侧 reason 缺失会直接驳回，故这里 reason 设为必填。
 */
@Serializable
data class QcForcePassRequest(
    @SerialName("workorder_id") val workorderId: String,
    val reason: String,
    val operator: String,
    /** 关联的品控记录 id（可追溯是哪次判定被放行） */
    @SerialName("qc_record_id") val qcRecordId: String? = null,
    val skuId: String? = null,
    @SerialName("store_id") val storeId: String? = null
)

/** 菜品 SOP 视频教材（C 块后台：上传后与菜品绑定） */
@Serializable
data class SopVideoDto(
    val id: String? = null,
    @SerialName("sku_id") val skuId: String? = null,
    val title: String? = null,
    @SerialName("video_url") val videoUrl: String? = null,
    @SerialName("video_key") val videoKey: String? = null,
    @SerialName("duration_sec") val durationSec: Int? = null,
    @SerialName("cover_url") val coverUrl: String? = null,
    val uploader: String? = null,
    val ts: String? = null
)

/** GET /api/kitchen/sop-videos 响应（BFF 未部署该表时 items 为空，UI 只渲染占位入口） */
@Serializable
data class SopVideoListDto(
    val ok: Boolean = false,
    val items: List<SopVideoDto> = emptyList(),
    val rev: String? = null,
    val hint: String? = null,
    val message: String? = null
)

/**
 * 把 Kimi 视觉识别结果映射成品控判定。
 *
 * `rows` 是三元组 [检查项, 实测值, 状态]，状态 ∈ pass|fail|warn：
 *  - 任一 fail ⇒ 不合格（红色判定卡，必须锁定工单）
 *  - 无 fail 但有 warn ⇒ 临界（橙色，强制人工复核）
 *  - 全 pass 且置信度达标 ⇒ 合格（绿色）
 *
 * 置信度解析失败或低于 [MIN_CONF] 时一律加 `manual_review`，
 * 这是需求里「置信度不足时强制标注人工复核」的落地点。
 */
fun KimiResultDto.toQcVerdict(
    workorderId: String? = null,
    skuId: String? = null,
    operator: String? = null,
    station: String? = null,
    stage: String? = null,
    photoKey: String? = null,
    photoUrl: String? = null,
    ts: String? = null,
    minConf: Double = MIN_CONF
): QcVerdictDto {
    val parsed = rows.mapNotNull { row ->
        if (row.size < 3) null else Triple(row[0], row[1], KimiRowStatus.of(row[2]))
    }
    val fails = parsed.filter { it.third == KimiRowStatus.FAIL }
    val warns = parsed.filter { it.third == KimiRowStatus.WARN }
    val confValue = parseConf(conf)

    val verdict: Boolean? = when {
        fails.isNotEmpty() -> false
        parsed.isNotEmpty() && warns.isEmpty() -> true
        else -> null
    }
    return QcVerdictDto(
        workorderId = workorderId,
        skuId = skuId,
        name = title,
        pass = verdict,
        conf = confValue,
        manualReview = warns.isNotEmpty() || verdict == null || (confValue ?: 0.0) < minConf,
        defectItems = (fails + warns).map { it.first },
        stage = stage,
        operator = operator,
        station = station,
        photoKey = photoKey,
        photoUrl = photoUrl,
        ts = ts
    )
}

/** BFF 的 conf 形如 "95%" 或 "0.95"，也可能是空串 */
fun parseConf(raw: String?): Double? {
    val s = raw?.trim().orEmpty()
    if (s.isEmpty()) return null
    val num = s.removeSuffix("%").trim().toDoubleOrNull() ?: return null
    return if (s.endsWith("%")) num else if (num <= 1.0) num * 100.0 else num
}

/** 低于该置信度必须人工复核 */
const val MIN_CONF: Double = 85.0
