package com.pandawufu.shared.viewmodel

import com.pandawufu.shared.AppDispatchers
import com.pandawufu.shared.model.ReportDailyDto
import com.pandawufu.shared.redline.RedlineGuard
import com.pandawufu.shared.repository.HealthRepository
import com.pandawufu.shared.repository.ReportRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 简报 Tab 首页 ViewModel（MVI 样例，两端共享）。
 * iOS 侧经 SKIE / KMP-NativeCoroutines 订阅 [state]。
 */
class HomeViewModel(
    private val healthRepository: HealthRepository,
    private val reportRepository: ReportRepository
) {
    data class HomeState(
        val loading: Boolean = false,
        val report: ReportDailyDto? = null,
        /** 服务端最新 rev（来自 health/snapshot），作为写操作 baseRev 与过期检测基准 */
        val rev: String? = null,
        /** 本地基准 rev 是否已过期 */
        val stale: Boolean = false,
        val error: String? = null
    )

    sealed interface HomeIntent {
        data object Refresh : HomeIntent
    }

    private val scope = CoroutineScope(SupervisorJob() + AppDispatchers.main)

    private val _state = MutableStateFlow(HomeState())
    val state: StateFlow<HomeState> = _state.asStateFlow()

    fun dispatch(intent: HomeIntent) {
        when (intent) {
            HomeIntent.Refresh -> refresh()
        }
    }

    private fun refresh() {
        scope.launch {
            val soft = _state.value.report != null
            _state.update { it.copy(loading = !soft, error = null) }
            try {
                val health = runCatching { healthRepository.health() }.getOrNull()
                val report = reportRepository.daily()
                val reportRev = report.revText().ifEmpty { null }
                val healthRev = health?.revText()?.ifEmpty { null }
                val localRev = _state.value.rev
                _state.update {
                    it.copy(
                        loading = false,
                        report = report,
                        rev = healthRev ?: reportRev,
                        stale = RedlineGuard.isStale(localRev, healthRev ?: reportRev),
                        error = null
                    )
                }
            } catch (e: Exception) {
                val fail = com.pandawufu.shared.util.LoadFailure.from(e)
                _state.update {
                    it.copy(
                        loading = false,
                        error = fail.error ?: fail.hint ?: "暂时连不上门店数据"
                    )
                }
            }
        }
    }

    fun clear() = scope.cancel()
}
