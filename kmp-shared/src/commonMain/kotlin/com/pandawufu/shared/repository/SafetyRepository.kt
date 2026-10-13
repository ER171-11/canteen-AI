package com.pandawufu.shared.repository

import com.pandawufu.shared.model.SafetyCheckRequest
import com.pandawufu.shared.model.SafetyProgressDto
import com.pandawufu.shared.model.toPayload
import com.pandawufu.shared.network.BffClient

/**
 * 食安拍照上报（**只读 + payload 构造，不含业务写**）。
 *
 * 边界：
 *  1. 读进度只走只读端点 `GET /api/safety/progress`（BFF 只调快照，不写库、不入队）；
 *  2. 上报属于业务写，必须经 `redline.ConfirmGateway`（type=`safety.check`）——
 *     本接口只把请求 DTO 转成动作 payload（[checkPayload]），刻意不提供入队能力，避免绕过红线；
 *  3. 照片走「App 预签名直传对象存储」通道，本接口只透传 `photoUrl` 引用，不接收图片字节。
 *
 * 员工端**不等待 AI**：上报后服务端记录 `ai_result=pending`，AI 初判由 BFF 异步回填。
 */
interface SafetyRepository {
    /**
     * 今日食安拍照进度（点位 + 当日最新记录）。
     * @param date 缺省由 BFF 按当天算
     */
    suspend fun progress(date: String? = null): SafetyProgressDto

    /** 上报载荷（交给 ConfirmGateway 入队，type=safety.check） */
    fun checkPayload(
        pointId: String,
        photoUrl: String? = null,
        operator: String? = null,
        storeId: String? = null,
        takenAt: String? = null
    ): kotlinx.serialization.json.JsonObject
}

class SafetyRepositoryImpl(private val bff: BffClient) : SafetyRepository {

    override suspend fun progress(date: String?): SafetyProgressDto =
        runCatching { bff.safetyProgress(date) }.getOrNull()
            ?: SafetyProgressDto(ok = false, hint = "offline")

    override fun checkPayload(
        pointId: String,
        photoUrl: String?,
        operator: String?,
        storeId: String?,
        takenAt: String?
    ): kotlinx.serialization.json.JsonObject = toPayload(
        SafetyCheckRequest(
            pointId = pointId,
            photoUrl = photoUrl,
            takenAt = takenAt,
            operator = operator,
            storeId = storeId
        )
    )
}
