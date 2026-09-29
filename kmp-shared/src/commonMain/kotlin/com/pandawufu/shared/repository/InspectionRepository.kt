package com.pandawufu.shared.repository

import com.pandawufu.shared.model.*
import com.pandawufu.shared.network.BffClient

/**
 * C、D 块闭店巡检（只读 + payload 构造，**不含业务写**）。
 *
 * 三条边界：
 *  1. 50 个标准节点是 BFF 内置主数据，App 只读；本接口不提供任何增删改节点能力。
 *  2. 服务端只知道「拍没拍、谁拍的、几点拍的」；照片本体由端侧 PhotoStore 管理，
 *     所以本接口的所有 DTO 里都不存在图片字段。
 *  3. 上报巡检结果属于业务写，必须经 redline.ConfirmGateway；
 *     本接口只负责把 DTO 转成动作 payload（[recordPayload] / [assignPayload]）。
 */
interface InspectionRepository {
    /**
     * 巡检统筹看板（店长视角）：全店完成率、各板块进度、漏项清单、历史台账。
     * @param date 缺省由 BFF 按当天算
     */
    suspend fun board(
        date: String? = null,
        board: String? = null,
        operator: String? = null,
        nodeId: String? = null
    ): InspectionBoardResponse

    /** 50 个标准节点主数据（App 只读，供点位卡渲染） */
    suspend fun nodes(): List<InspectionNodeDto>

    /** 某板块负责到人（payload 交给 ConfirmGateway 入队） */
    fun assignPayload(board: String, operator: String, storeId: String? = null): kotlinx.serialization.json.JsonObject

    /** 一次巡检上报（payload 交给 ConfirmGateway 入队） */
    fun recordPayload(
        nodeId: String,
        operator: String,
        photoTaken: Boolean,
        storeId: String? = null,
        station: String? = null,
        note: String? = null,
        round: Int? = null,
        ts: String? = null
    ): kotlinx.serialization.json.JsonObject
}

class InspectionRepositoryImpl(private val bff: BffClient) : InspectionRepository {

    override suspend fun board(
        date: String?,
        board: String?,
        operator: String?,
        nodeId: String?
    ): InspectionBoardResponse =
        runCatching { bff.inspectionBoard(date, board, operator, nodeId) }.getOrNull()
            ?: InspectionBoardResponse(ok = false, hint = "offline")

    override suspend fun nodes(): List<InspectionNodeDto> = board().nodes

    override fun assignPayload(
        board: String,
        operator: String,
        storeId: String?
    ): kotlinx.serialization.json.JsonObject =
        toPayload(InspectionAssignRequest(board = board, operator = operator, storeId = storeId))

    override fun recordPayload(
        nodeId: String,
        operator: String,
        photoTaken: Boolean,
        storeId: String?,
        station: String?,
        note: String?,
        round: Int?,
        ts: String?
    ): kotlinx.serialization.json.JsonObject = toPayload(
        InspectionRecordRequest(
            nodeId = nodeId,
            operator = operator,
            photoTaken = photoTaken,
            storeId = storeId,
            station = station,
            note = note,
            round = round,
            ts = ts
        )
    )
}
