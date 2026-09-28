package com.pandawufu.shared.viewmodel

import com.pandawufu.shared.AppDispatchers
import com.pandawufu.shared.model.BriefingDto
import com.pandawufu.shared.model.InboxDto
import com.pandawufu.shared.repository.SiRepository
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * SI 驾驶舱 ViewModel：聚合「简报 + 收件箱」，供今日页与收件箱页共用。
 * 两端共享；Android Compose 直接 collectAsState，iOS 经 SKIE 订阅。
 */
class SiViewModel(
    private val repo: SiRepository,
    dispatcher: CoroutineDispatcher = AppDispatchers.main
) {
    data class State(
        val loading: Boolean = false,
        val briefing: BriefingDto? = null,
        val inbox: InboxDto? = null,
        val pipeline: com.pandawufu.shared.model.PipelineDto? = null,
        val error: String? = null
    ) {
        val badge: Int get() = inbox?.counts?.total ?: 0
    }

    sealed interface Intent {
        data object Refresh : Intent
        data class AckItem(val id: String) : Intent
        data object AckAll : Intent
    }

    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun dispatch(intent: Intent) {
        when (intent) {
            Intent.Refresh -> refresh()
            is Intent.AckItem -> ack(intent.id, all = false)
            Intent.AckAll -> ack(null, all = true)
        }
    }

    private fun refresh() {
        scope.launch {
            val soft = _state.value.briefing != null || _state.value.inbox != null
            _state.update { it.copy(loading = !soft, error = null) }
            try {
                val briefing = runCatching { repo.briefing() }.getOrNull()
                val pipeline = runCatching { repo.pipeline() }.getOrNull()
                val inbox = repo.inbox()
                _state.update {
                    it.copy(
                        loading = false,
                        briefing = briefing ?: it.briefing,
                        inbox = inbox,
                        pipeline = pipeline ?: it.pipeline,
                        error = null
                    )
                }
            } catch (e: Exception) {
                val fail = com.pandawufu.shared.util.LoadFailure.from(e)
                _state.update {
                    it.copy(
                        loading = false,
                        error = fail.error ?: fail.hint ?: "SI 暂时连不上门店"
                    )
                }
            }
        }
    }

    private fun ack(id: String?, all: Boolean) {
        scope.launch {
            runCatching { repo.ackInbox(id, all) }
            refresh()
        }
    }

    fun clear() = scope.cancel()
}
