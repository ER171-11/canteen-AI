package com.pandawufu.shared.viewmodel

import com.pandawufu.shared.AppDispatchers
import com.pandawufu.shared.model.DishDto
import com.pandawufu.shared.model.PosTableDto
import com.pandawufu.shared.model.QuoteDto
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

/** 进销存 ViewModel（MVI）。6 子页：库存→缺货→下单→入库；产品库/供应商为主数据。 */
class InventoryViewModel(
    private val inventoryRepository: InventoryRepository,
    /** 可注入调度器：生产用 AppDispatchers.main，单测注入 TestDispatcher */
    dispatcher: kotlinx.coroutines.CoroutineDispatcher = AppDispatchers.main
) {
    enum class InventoryTab(val label: String) {
        /** 办货链：看库存 → 缺货建议 → 采购单 → 入库；档案垫底 */
        STOCK("库存"),
        RESTOCK("缺货"),
        PURCHASE("下单"),
        RECV("入库"),
        CATALOG("产品库"),
        VENDORS("供应商")
    }

    data class InventoryState(
        val loading: Boolean = false,
        val tab: InventoryTab = InventoryTab.STOCK,
        val stock: List<StockItem> = emptyList(),
        val countEnough: Int = 0,
        val countLow: Int = 0,
        val countCritical: Int = 0,
        val restock: List<RestockSuggestion> = emptyList(),
        /** 采购草稿/在途 PO（data.orders） */
        val orders: List<RecvRecordDto> = emptyList(),
        /** 进货入库（data.recv） */
        val recv: List<RecvRecordDto> = emptyList(),
        /** POS 桌台（模块页 p-m-pos 复用本快照数据） */
        val posTables: List<PosTableDto> = emptyList(),
        /** 堂食菜单（data.dishes）· 收银点菜 */
        val dishes: List<DishDto> = emptyList(),
        val quotes: List<QuoteDto> = emptyList(),
        val suppliers: List<String> = emptyList(),
        val vendors: List<com.pandawufu.shared.model.VendorDto> = emptyList(),
        val rev: String? = null,
        val error: String? = null,
        val emptyHint: String? = null
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
            is InventoryIntent.SelectTab -> {
                _state.update { it.copy(tab = intent.tab) }
                // 切到采购/进货时强制拉最新快照，避免补货刚执行后列表仍是旧 PO
                if (intent.tab == InventoryTab.PURCHASE || intent.tab == InventoryTab.RECV) {
                    refresh()
                }
            }
            InventoryIntent.Refresh -> refresh()
        }
    }

    private fun refresh() {
        scope.launch {
            val soft = _state.value.stock.isNotEmpty() ||
                _state.value.orders.isNotEmpty() ||
                _state.value.recv.isNotEmpty()
            _state.update { it.copy(loading = !soft, error = null) }
            try {
                val snapshot = inventoryRepository.snapshot()
                val stock = snapshot.data?.ings.orEmpty()
                    .map(com.pandawufu.shared.repository.StockPolicy::toStockItem)
                val restock = inventoryRepository.restockSuggestions()
                val vendorsRaw = snapshot.data?.vendors.orEmpty()
                val vendors = if (vendorsRaw.isNotEmpty()) {
                    vendorsRaw
                } else {
                    snapshot.data?.suppliers.orEmpty().map { n ->
                        com.pandawufu.shared.model.VendorDto(id = n, name = n, status = "合作中", period = "月结30天")
                    }
                }
                _state.update {
                    it.copy(
                        loading = false,
                        stock = stock,
                        countEnough = stock.count { s -> s.status == StockStatus.ENOUGH },
                        countLow = stock.count { s -> s.status == StockStatus.LOW },
                        countCritical = stock.count { s -> s.status == StockStatus.CRITICAL },
                        restock = restock,
                        orders = snapshot.data?.orders.orEmpty(),
                        recv = snapshot.data?.recv.orEmpty(),
                        posTables = snapshot.data?.pos.orEmpty(),
                        dishes = snapshot.data?.dishes.orEmpty().filter { it.on },
                        quotes = snapshot.data?.quotes.orEmpty(),
                        suppliers = snapshot.data?.suppliers.orEmpty().ifEmpty { vendors.map { v -> v.name } },
                        vendors = vendors,
                        rev = snapshot.revText().ifEmpty { null },
                        error = null,
                        emptyHint = if (stock.isEmpty() && snapshot.revText().isEmpty()) {
                            com.pandawufu.shared.util.LoadFailure.NO_SNAPSHOT_MSG
                        } else {
                            null
                        }
                    )
                }
            } catch (e: Exception) {
                val fail = com.pandawufu.shared.util.LoadFailure.from(e)
                _state.update {
                    it.copy(
                        loading = false,
                        error = fail.error,
                        emptyHint = fail.hint ?: it.emptyHint
                    )
                }
            }
        }
    }

    fun clear() = scope.cancel()
}
