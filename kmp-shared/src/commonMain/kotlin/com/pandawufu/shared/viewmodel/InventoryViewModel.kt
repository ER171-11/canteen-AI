package com.pandawufu.shared.viewmodel

import com.pandawufu.shared.AppDispatchers
import com.pandawufu.shared.model.PosTableDto
import com.pandawufu.shared.model.RecvRecordDto
import com.pandawufu.shared.repository.InventoryRepository
import com.pandawufu.shared.repository.RestockSuggestion
import com.pandawufu.shared.repository.StockItem
import com.pandawufu.shared.repository.StockStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** 进销存 ViewModel（MVI）。4 子页：库存 / 补货 / 采购 / 进货。只读，无任何写操作。 */
class InventoryViewModel(
    private val inventoryRepository: InventoryRepository,
    /** 可注入调度器：生产用 AppDispatchers.main，单测注入 TestDispatcher */
    dispatcher: kotlinx.coroutines.CoroutineDispatcher = AppDispatchers.main
) {
    enum class InventoryTab(val label: String) { STOCK("库存"), RESTOCK("补货"), PURCHASE("采购"), RECV("进货") }

    data class InventoryState(
        val loading: Boolean = false,
        val tab: InventoryTab = InventoryTab.STOCK,
        val stock: List<StockItem> = emptyList(),
        val countEnough: Int = 0,
        val countLow: Int = 0,
        val countCritical: Int = 0,
        val restock: List<RestockSuggestion> = emptyList(),
        val recv: List<RecvRecordDto> = emptyList(),
        /** POS 桌台（模块页 p-m-pos 复用本快照数据） */
        val posTables: List<PosTableDto> = emptyList(),
        val rev: String? = null,
        val error: String? = null
    )

    sealed interface InventoryIntent {
        data class SelectTab(val tab: InventoryTab) : InventoryIntent
        data object Refresh : InventoryIntent
    }

    private val scope = CoroutineScope(SupervisorJob() + dispatcher)

    private val _state = MutableStateFlow(InventoryState())
    val state: StateFlow<InventoryState> = _state.asStateFlow()

    fun dispatch(intent: InventoryIntent) {
        when (intent) {
            is InventoryIntent.SelectTab -> _state.update { it.copy(tab = intent.tab) }
            InventoryIntent.Refresh -> refresh()
        }
    }

    private fun refresh() {
        scope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                val snapshot = inventoryRepository.snapshot()
                val stock = snapshot.data?.ings.orEmpty()
                    .map(com.pandawufu.shared.repository.StockPolicy::toStockItem)
                _state.update {
                    it.copy(
                        loading = false,
                        stock = stock,
                        countEnough = stock.count { s -> s.status == StockStatus.ENOUGH },
                        countLow = stock.count { s -> s.status == StockStatus.LOW },
                        countCritical = stock.count { s -> s.status == StockStatus.CRITICAL },
                        restock = stock
                            .filter { s -> s.status != StockStatus.ENOUGH }
                            .sortedByDescending { s -> s.safety - s.qty }
                            .map(com.pandawufu.shared.repository.StockPolicy::toSuggestion),
                        recv = snapshot.data?.recv.orEmpty(),
                        posTables = snapshot.data?.pos.orEmpty(),
                        rev = snapshot.rev
                    )
                }
            } catch (e: Exception) {
                _state.update { it.copy(loading = false, error = e.message ?: "network error") }
            }
        }
    }

    fun clear() = scope.cancel()
}
