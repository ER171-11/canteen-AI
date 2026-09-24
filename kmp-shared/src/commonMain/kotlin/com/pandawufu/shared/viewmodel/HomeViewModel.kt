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
            _state.update { it.copy(loading = true, error = null) }
            try {
                val health = healthRepository.health()
                val report = reportRepository.daily()
                val localRev = _state.value.report?.rev
                _state.update {
                    it.copy(
                        loading = false,
                        report = report,
                        rev = health.rev ?: report.rev,
                        stale = RedlineGuard.isStale(localRev, health.rev ?: report.rev)
                    )
                }
            } catch (e: Exception) {
                _state.update { it.copy(loading = false, error = e.message ?: "network error") }
            }
        }
    }

    fun clear() = scope.cancel()
}
