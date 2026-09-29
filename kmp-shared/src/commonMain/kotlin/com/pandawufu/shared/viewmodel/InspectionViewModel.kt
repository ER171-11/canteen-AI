package com.pandawufu.shared.viewmodel

import com.pandawufu.shared.AppDispatchers
import com.pandawufu.shared.model.InspectionBoardProgressDto
import com.pandawufu.shared.model.InspectionBoardResponse
import com.pandawufu.shared.model.InspectionEvery30Dto
import com.pandawufu.shared.model.InspectionNodeDto
import com.pandawufu.shared.model.InspectionRecordDto
import com.pandawufu.shared.model.InspectionSummaryDto
import com.pandawufu.shared.repository.InspectionRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * C、D 块闭店巡检 ViewModel（MVI）。
 *
 * 服务端只回答「拍没拍、谁拍的、几点拍的」，照片本体在手机本地。
 * 因此本地拍完一张照片后，必须通过 [InspectionIntent.NoteLocalPhoto] 把
 * 「该节点今天已完成」并进状态，否则界面上刚拍完的点位还会显示成漏项。
 *
 * 无快照 / 断网：软提示 + 保留已有数据，不整页「加载失败」。
 */
class InspectionViewModel(
    private val repository: InspectionRepository,
    private val today: String? = null,
    dispatcher: kotlinx.coroutines.CoroutineDispatcher = AppDispatchers.main
) {
    data class InspectionState(
        val loading: Boolean = false,
        val refreshing: Boolean = false,
        val date: String? = null,
        /** 数据更新时间（必须显式展示，避免把旧数据当成实时状态） */
        val updatedAt: String? = null,
        val summary: InspectionSummaryDto = InspectionSummaryDto(),
        val boards: List<InspectionBoardProgressDto> = emptyList(),
        val nodes: List<InspectionNodeDto> = emptyList(),
        val groups: List<String> = emptyList(),
        val records: List<InspectionRecordDto> = emptyList(),
        val every30: InspectionEvery30Dto = InspectionEvery30Dto(),
        /** null = 全店；否则只看某板块 */
        val selectedBoard: String? = null,
        /** 本地已拍照完成的节点（当天），与服务端记录合并后才是最终完成集合 */
        val localDoneNodeIds: Set<String> = emptySet(),
        val localPhotoCount: Int = 0,
        val error: String? = null,
        val emptyHint: String? = null
    ) {
        /** 服务端记录 + 本地照片，合并成最终「今天已完成」的节点集合 */
        fun doneNodeIds(): Set<String> {
            val fromServer = records.filter { it.isDone() }.map { it.nodeId }.filter { it.isNotBlank() }
            return fromServer.toSet() + localDoneNodeIds
        }

        fun isDone(nodeId: String): Boolean = nodeId in doneNodeIds()

        fun nodesOf(board: String): List<InspectionNodeDto> = nodes.filter { it.board == board }

        fun visibleBoards(): List<String> =
            if (selectedBoard.isNullOrBlank()) boards.map { it.board } else listOf(selectedBoard!!)

        fun progressOf(board: String): InspectionBoardProgressDto? =
            boards.firstOrNull { it.board == board }

        /**
         * 本地实时漏项：以节点主数据为准逐个核对，比服务端返回的 missing 更新更快
         * （刚拍完照的那一秒就已经不在漏项里了）。
         */
        fun missingNodes(board: String): List<InspectionNodeDto> {
            val done = doneNodeIds()
            return nodesOf(board)
                .filter { it.id !in done }
                // 卫生间类（每 30 分钟一次）排前面，超时风险最高
                .sortedWith(compareByDescending<InspectionNodeDto> { it.every30 }.thenBy { it.id })
        }

        fun allMissingNodes(): List<InspectionNodeDto> {
            val done = doneNodeIds()
            return nodes.filter { it.id !in done }
                .sortedWith(compareByDescending<InspectionNodeDto> { it.every30 }.thenBy { it.board })
        }

        /** 某板块已完成数（含本地照片） */
        fun doneCount(board: String): Int {
            val done = doneNodeIds()
            return nodesOf(board).count { it.id in done }
        }

        fun rate(board: String): Int {
            val total = nodesOf(board).size
            if (total <= 0) return 0
            return (doneCount(board) * 100) / total
        }

        /** 全店完成率（含本地照片） */
        fun overallRate(): Int {
            if (nodes.isEmpty()) return summary.rate
            return (nodes.count { it.id in doneNodeIds() } * 100) / nodes.size
        }

        fun overallDone(): Int = nodes.count { it.id in doneNodeIds() }
    }

    sealed interface InspectionIntent {
        /** null 表示回到全店视图 */
        data class SelectBoard(val board: String?) : InspectionIntent
        data object Refresh : InspectionIntent
        /** 本地刚拍完一张照片：立刻把该节点标成已完成 */
        data class NoteLocalPhoto(val nodeId: String) : InspectionIntent
        /** 本地照片被清理/删除后回退完成态 */
        data class ForgetLocalPhoto(val nodeId: String) : InspectionIntent
        /** 进入页面时用本地台账初始化（已拍过的不再算漏项） */
        data class SyncLocalPhotos(val doneNodeIds: Set<String>, val photoCount: Int) : InspectionIntent
    }

    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val _state = MutableStateFlow(InspectionState())
    val state: StateFlow<InspectionState> = _state.asStateFlow()

    fun dispatch(intent: InspectionIntent) {
        when (intent) {
            is InspectionIntent.SelectBoard -> _state.update { it.copy(selectedBoard = intent.board) }
            InspectionIntent.Refresh -> load(force = true)
            is InspectionIntent.NoteLocalPhoto -> _state.update {
                it.copy(
                    localDoneNodeIds = it.localDoneNodeIds + intent.nodeId,
                    localPhotoCount = it.localPhotoCount + 1
                )
            }
            is InspectionIntent.ForgetLocalPhoto -> _state.update {
                it.copy(
                    localDoneNodeIds = it.localDoneNodeIds - intent.nodeId,
                    localPhotoCount = (it.localPhotoCount - 1).coerceAtLeast(0)
                )
            }
            is InspectionIntent.SyncLocalPhotos -> _state.update {
                it.copy(localDoneNodeIds = intent.doneNodeIds, localPhotoCount = intent.photoCount)
            }
        }
    }

    fun load(force: Boolean = false) {
        val s = _state.value
        if (s.loading || (s.refreshing && !force)) return
        _state.update { it.copy(loading = it.nodes.isEmpty(), refreshing = it.nodes.isNotEmpty(), error = null) }
        scope.launch {
            val resp = runCatching { repository.board(date = today) }.getOrNull()
            _state.update { prev ->
                if (resp == null) {
                    prev.copy(
                        loading = false,
                        refreshing = false,
                        error = "网络异常，巡检数据未能刷新",
                        emptyHint = prev.emptyHint ?: "已展示上次结果，请稍后重试"
                    )
                } else {
                    applyResponse(prev, resp)
                }
            }
        }
    }

    /** 单个板块刷新，店长逐块核对时用（避免整页重载） */
    fun loadBoard(board: String) {
        scope.launch {
            val resp = runCatching { repository.board(date = today, board = board) }.getOrNull() ?: return@launch
            _state.update { applyResponse(it, resp) }
        }
    }

    private fun applyResponse(prev: InspectionState, resp: InspectionBoardResponse): InspectionState {
        val boards = resp.boards
        val hint = when {
            resp.hint == "no_snapshot" -> "尚未生成今日快照，巡检记录会在首次拍照后建立"
            !resp.message.isNullOrBlank() -> resp.message
            else -> null
        }
        return prev.copy(
            loading = false,
            refreshing = false,
            date = resp.date ?: prev.date,
            updatedAt = resp.updatedAt ?: prev.updatedAt,
            summary = resp.summary,
            boards = boards,
            // nodes 为空时保留主数据：空快照下 BFF 仍会下发 50 个标准节点
            nodes = resp.nodes.ifEmpty { prev.nodes },
            groups = resp.groups.ifEmpty { prev.groups },
            records = resp.records.ifEmpty { prev.records },
            every30 = resp.every30,
            error = null,
            emptyHint = hint
        )
    }

    fun close() {
        scope.cancel()
    }
}
