package com.pandawufu.shared.repository

import com.pandawufu.shared.model.*
import com.pandawufu.shared.network.BffClient

/**
 * A 块品控照片的媒体通道（只读 + 上传，**不含任何业务写**）。
 *
 * 为什么单独一个仓库：
 *  - 品控照片走「App 直传对象存储」，与其它业务数据走快照/动作队列是两条完全不同的通道；
 *  - 业务写（qc.record / qc.force_pass）仍然必须经 redline.ConfirmGateway，
 *    所以本接口刻意不提供任何入队能力，避免被绕过。
 *
 * 降级契约：对象存储未配置时 [uploadQcPhoto] 返回 `configured=false` 而不是抛错，
 * 品控识别与落库照常完成，只是 photoUrl 为空——UI 必须明确标注「图片不可用」。
 */
interface QcMediaRepository {
    /** 对象存储是否可用（决定 UI 是否展示「图片不可用」标注） */
    suspend fun status(): QcMediaStatusDto

    /** 压缩后的 JPEG 直传；返回上传结果（含 photoKey / photoUrl 引用） */
    suspend fun uploadQcPhoto(
        workorderId: String,
        skuId: String? = null,
        bytes: ByteArray,
        contentType: String = "image/jpeg"
    ): QcUploadResult

    /** 对象键 → 带签名的临时读图 URL（品控台账点开大图用） */
    suspend fun signUrl(key: String): String?

    /** 批量签名，避免台账列表 N 次请求 */
    suspend fun signUrls(keys: List<String>): Map<String, String>
}

/** 一次直传的结果。uploaded=false 时 uploadedReason 说明降级原因 */
data class QcUploadResult(
    val configured: Boolean,
    val uploaded: Boolean,
    val photoKey: String? = null,
    val photoUrl: String? = null,
    val skippedReason: String? = null
) {
    companion object {
        val NOT_CONFIGURED = QcUploadResult(
            configured = false,
            uploaded = false,
            skippedReason = "对象存储未配置，图片暂不可用"
        )

        fun failed(reason: String) = QcUploadResult(
            configured = true,
            uploaded = false,
            skippedReason = reason
        )
    }
}

class QcMediaRepositoryImpl(private val bff: BffClient) : QcMediaRepository {

    override suspend fun status(): QcMediaStatusDto =
        runCatching { bff.qcMediaStatus() }.getOrNull()
            ?: QcMediaStatusDto(ok = false, configured = false, missing = emptyList())

    override suspend fun uploadQcPhoto(
        workorderId: String,
        skuId: String?,
        bytes: ByteArray,
        contentType: String
    ): QcUploadResult {
        if (bytes.isEmpty()) return QcUploadResult.failed("照片为空，未上传")
        val ext = if (contentType.contains("png")) "png" else "jpg"
        val signed = runCatching {
            bff.qcMediaPresign(
                QcPresignRequest(
                    workorderId = workorderId,
                    skuId = skuId,
                    ext = ext,
                    contentType = contentType
                )
            )
        }.getOrNull() ?: return QcUploadResult.failed("取上传地址失败，请检查网络")

        if (!signed.configured) return QcUploadResult.NOT_CONFIGURED
        if (!signed.canUpload()) {
            return QcUploadResult.failed(signed.error ?: signed.hint ?: "上传地址不可用")
        }

        val ok = runCatching {
            bff.uploadToPresignedUrl(signed.uploadUrl!!, bytes, contentType)
        }.getOrDefault(false)

        return if (ok) {
            QcUploadResult(
                configured = true,
                uploaded = true,
                photoKey = signed.key,
                photoUrl = signed.photoUrl
            )
        } else {
            QcUploadResult.failed("图片上传失败，品控结论仍已记录")
        }
    }

    override suspend fun signUrl(key: String): String? =
        signUrls(listOf(key))[key]

    override suspend fun signUrls(keys: List<String>): Map<String, String> {
        val clean = keys.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        if (clean.isEmpty()) return emptyMap()
        val resp = runCatching { bff.qcMediaSign(QcSignRequest(keys = clean)) }.getOrNull()
            ?: return emptyMap()
        if (!resp.configured) return emptyMap()
        return resp.items.associate { it.key to (it.publicUrl ?: it.url) }
    }
}
