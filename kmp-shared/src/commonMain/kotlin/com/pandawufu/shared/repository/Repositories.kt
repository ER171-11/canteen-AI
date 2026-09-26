package com.pandawufu.shared.repository

import com.pandawufu.shared.model.*
import com.pandawufu.shared.network.BffClient
import com.pandawufu.shared.network.SseClient
import com.pandawufu.shared.network.SseEvent
import kotlinx.coroutines.flow.Flow

/** 健康检查（只读） */
interface HealthRepository {
    suspend fun health(): HealthDto
}

class HealthRepositoryImpl(private val bff: BffClient) : HealthRepository {
    override suspend fun health(): HealthDto = bff.health()
}

/** 进销存快照（只读） */
interface SnapshotRepository {
    suspend fun latest(): SnapshotDto
}

class SnapshotRepositoryImpl(private val bff: BffClient) : SnapshotRepository {
    override suspend fun latest(): SnapshotDto = bff.snapshotLatest()
}

/** 日报（只读） */
interface ReportRepository {
    suspend fun daily(): ReportDailyDto
}

class ReportRepositoryImpl(private val bff: BffClient) : ReportRepository {
    override suspend fun daily(): ReportDailyDto = bff.reportDaily()
}

/**
 * 写操作仓库。注意：端侧任何写都必须经由 redline.ConfirmGateway 进入，
 * 禁止 UI/ViewModel 直接持有本接口调用。
 */
interface ActionRepository {
    suspend fun create(action: ActionDto): ActionDto
    suspend fun confirm(action: ActionDto): ActionDto
}

class ActionRepositoryImpl(private val bff: BffClient) : ActionRepository {
    override suspend fun create(action: ActionDto): ActionDto {
        val resp = bff.postAction(action)
        if (!resp.ok || resp.id.isNullOrBlank()) {
            error(resp.error ?: "enqueue failed")
        }
        return action.copy(
            id = resp.id,
            status = ActionStatus.fromWire(resp.status),
            rev = resp.revText().ifEmpty { action.baseRev },
            createdAt = resp.createdAt,
            traceId = resp.traceId
        )
    }

    override suspend fun confirm(action: ActionDto): ActionDto {
        // 无店内快照时 rev 可为 null（BFF 两侧均为 null 即放行）
        val rev = action.rev ?: action.baseRev
        val resp = bff.confirmAction(action.id, action.operator, rev)
        if (!resp.ok) {
            val hint = listOfNotNull(
                resp.error,
                resp.expectedRev?.let { "期望 rev=$it" },
                resp.gotRev?.let { "本地 rev=$it" }
            ).joinToString(" · ").ifBlank { "confirm failed" }
            error(hint)
        }
        return action.copy(
            status = ActionStatus.fromWire(resp.status),
            confirmedAt = resp.confirmedAt,
            updatedAt = resp.confirmedAt
        )
    }
}

/** Kimi 视觉（图片仅内存传递，不落盘） */
interface KimiRepository {
    suspend fun callVision(type: String, imageBase64: String, ctx: Map<String, String> = emptyMap()): KimiVisionResponse
    fun callVisionStream(type: String, imageBase64: String, ctx: Map<String, String> = emptyMap()): Flow<SseEvent>
}

class KimiRepositoryImpl(
    private val bff: BffClient,
    private val sse: SseClient
) : KimiRepository {
    override suspend fun callVision(type: String, imageBase64: String, ctx: Map<String, String>): KimiVisionResponse =
        bff.kimiVision(KimiVisionRequest(type, imageBase64, ctx))

    override fun callVisionStream(type: String, imageBase64: String, ctx: Map<String, String>): Flow<SseEvent> =
        sse.visionStream(KimiVisionRequest(type, imageBase64, ctx))
}
