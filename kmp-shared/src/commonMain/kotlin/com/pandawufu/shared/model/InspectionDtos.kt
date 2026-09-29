package com.pandawufu.shared.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * C、D 块「闭店巡检节点配置与拍照验证 / 水印相机追溯」DTO。
 *
 * 与 `bff/lib/inspection_nodes.js`（50 个内置标准节点主数据）和
 * `bff/lib/inspection_board.js`（看板聚合）一一对应。
 *
 * 红线：巡检照片只存在手机本地，**服务端 DTO 里不存在任何图片字段**。
 * 服务端只回答「这个点位今天拍过没有、谁拍的、几点拍的」，
 * 照片本身由端侧 [com.pandawufu.app.media.PhotoStore] 按时间/点位/责任人检索。
 */

/** 单个标准节点（BFF 内置主数据，App 只读） */
@Serializable
data class InspectionNodeDto(
    val id: String,
    val name: String,
    /** 后厨 / 前厅 / 仓库 */
    val board: String = "",
    /** 门窗 / 煤气 / 冰箱柜门 / 电源开关 / 水龙头 / 卫生间 等 */
    @SerialName("node_group") val nodeGroup: String = "",
    /** 是否需每 30 分钟拍一次（卫生间类，替代纸质签到） */
    val every30: Boolean = false
)

/** 漏项清单条目：未拍照即未完成 */
@Serializable
data class InspectionMissingDto(
    @SerialName("node_id") val nodeId: String,
    val name: String = "",
    @SerialName("node_group") val nodeGroup: String = "",
    val every30: Boolean = false,
    @SerialName("photo_taken") val photoTaken: Boolean = false,
    val operator: String? = null,
    val ts: String? = null
)

/** 单个板块的完成进度（后厨 / 前厅 / 仓库） */
@Serializable
data class InspectionBoardProgressDto(
    val board: String,
    val total: Int = 0,
    val done: Int = 0,
    @SerialName("missing_count") val missingCount: Int = 0,
    /** 完成率 0-100 */
    val rate: Int = 0,
    /** 板块负责人（负责到人） */
    val operator: String? = null,
    @SerialName("last_ts") val lastTs: String? = null,
    @SerialName("every30_pending") val every30Pending: Int = 0,
    val missing: List<InspectionMissingDto> = emptyList()
)

/** 一条巡检记录（服务端只存状态与元数据，不含图片） */
@Serializable
data class InspectionRecordDto(
    @SerialName("node_id") val nodeId: String = "",
    @SerialName("node_name") val nodeName: String? = null,
    val board: String? = null,
    @SerialName("node_group") val nodeGroup: String? = null,
    val date: String? = null,
    /** 1=已完成（已拍照），0=未完成 */
    val done: Int = 0,
    @SerialName("photo_taken") val photoTaken: Int = 0,
    val every30: Int = 0,
    /** 30 分钟轮次序号 0-47 */
    val round: Int? = null,
    val operator: String? = null,
    val station: String? = null,
    /** 曾收到图片载荷但已拒绝入库的留痕（恒不应为 1，出现即说明上层写错） */
    @SerialName("photo_local_only") val photoLocalOnly: Int = 0,
    val ts: String? = null
) {
    fun isDone(): Boolean = done == 1
}

/** 总览汇总：全店 50 个节点的完成情况 */
@Serializable
data class InspectionSummaryDto(
    val total: Int = 0,
    val done: Int = 0,
    val missing: Int = 0,
    val rate: Int = 0
)

/** 卫生间类节点的 30 分钟轮次核对 */
@Serializable
data class InspectionEvery30Dto(
    @SerialName("node_total") val nodeTotal: Int = 0,
    @SerialName("rounds_per_day") val roundsPerDay: Int = 48,
    @SerialName("rounds_recorded") val roundsRecorded: List<Int> = emptyList(),
    @SerialName("rounds_missing") val roundsMissing: List<Int> = emptyList()
)

/** GET /api/modules/inspection —— 巡检统筹看板（App 与 admin-web 共用同一份口径） */
@Serializable
data class InspectionBoardResponse(
    val ok: Boolean = false,
    val date: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    val summary: InspectionSummaryDto = InspectionSummaryDto(),
    val boards: List<InspectionBoardProgressDto> = emptyList(),
    val nodes: List<InspectionNodeDto> = emptyList(),
    val groups: List<String> = emptyList(),
    val records: List<InspectionRecordDto> = emptyList(),
    @SerialName("records_total") val recordsTotal: Int = 0,
    val every30: InspectionEvery30Dto = InspectionEvery30Dto(),
    val rev: String? = null,
    val hint: String? = null,
    val message: String? = null
) {
    fun progressOf(board: String): InspectionBoardProgressDto? = boards.firstOrNull { it.board == board }

    /** 全店漏项（各板块合并），用于「店长统筹查看漏项清单」 */
    fun allMissing(): List<InspectionMissingDto> = boards.flatMap { it.missing }
}

/** 一次巡检上报（POST /api/actions，type=inspection.record） */
@Serializable
data class InspectionRecordRequest(
    @SerialName("node_id") val nodeId: String,
    val operator: String,
    /** 是否已拍照——**唯一**完成凭据；未拍照时服务端强制记为未完成 */
    @SerialName("photo_taken") val photoTaken: Boolean,
    @SerialName("store_id") val storeId: String? = null,
    val date: String? = null,
    @SerialName("station") val station: String? = null,
    val note: String? = null,
    /** 30 分钟轮次；缺省由服务端按 ts 推算（仅卫生间类节点生效） */
    val round: Int? = null,
    val ts: String? = null,
    val source: String? = "app"
)

/** 板块负责到人（POST /api/actions，type=inspection.assign） */
@Serializable
data class InspectionAssignRequest(
    val board: String,
    val operator: String,
    @SerialName("store_id") val storeId: String? = null,
    val source: String? = "manual"
)
