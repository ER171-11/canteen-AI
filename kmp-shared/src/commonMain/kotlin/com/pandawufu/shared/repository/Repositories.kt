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
    override suspend fun create(action: ActionDto): ActionDto =
        bff.postAction(action.copy(status = ActionStatus.PENDING))

    override suspend fun confirm(action: ActionDto): ActionDto =
        bff.postAction(action.copy(status = ActionStatus.CONFIRMED))
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
