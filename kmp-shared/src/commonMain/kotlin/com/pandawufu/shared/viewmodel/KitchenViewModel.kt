package com.pandawufu.shared.viewmodel

import com.pandawufu.shared.AppDispatchers
import com.pandawufu.shared.model.BaobenSummaryDto
import com.pandawufu.shared.model.BoardItemDto
import com.pandawufu.shared.model.BoardTablePassDto
import com.pandawufu.shared.model.BoardTakeoutDto
import com.pandawufu.shared.model.KitchenDemandDto
import com.pandawufu.shared.model.PosTableDto
import com.pandawufu.shared.model.QcRecordDto
import com.pandawufu.shared.model.RecipeCostCardDto
import com.pandawufu.shared.model.RecipeDto
import com.pandawufu.shared.model.SopStepDto
import com.pandawufu.shared.model.WorkorderDto
import com.pandawufu.shared.repository.InventoryRepository
import com.pandawufu.shared.repository.KitchenRepository
import com.pandawufu.shared.repository.StockItem
import com.pandawufu.shared.util.LoadFailure
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * 厨房中枢 ViewModel（MVI）。
 * 日路径：按菜谱标准做工单 → 出品 → 品控；菜谱页即出品标准（厨师须遵照执行）。
 * 无快照 / 断网：软提示 + 尽量保留已有数据，不整页「加载失败」。
 */
class KitchenViewModel(
    private val kitchenRepository: KitchenRepository,
    private val inventoryRepository: InventoryRepository? = null,
    private val today: String? = null,
    dispatcher: kotlinx.coroutines.CoroutineDispatcher = AppDispatchers.main
) {
    enum class KitchenTab(val label: String) {
        /** 日路径：工单 → 出品 → 品控；菜谱属配方配置 */
        WORKORDERS("工单"),
        BOARD("出品"),
        QC("品控"),
        RECIPES("菜谱")
    }

    data class KitchenState(
        val loading: Boolean = false,
        val tab: KitchenTab = KitchenTab.WORKORDERS,
        val recipes: List<RecipeDto> = emptyList(),
        /** 保本测算店级 KPI / 类型结构 */
        val baobenSummary: BaobenSummaryDto? = null,
        val selectedRecipe: RecipeDto? = null,
        val selectedSteps: List<SopStepDto> = emptyList(),
        /** 菜谱成本卡（BFF 未部署 cost_card 时为 null，UI 不渲染） */
        val selectedCostCard: RecipeCostCardDto? = null,
        val detailLoading: Boolean = false,
        /** 菜谱换算：下剂个数（默认一批 ≈67 个，非堂食「份」） */
        val scaleQty: Int = 67,
        val workorders: List<WorkorderDto> = emptyList(),
        /** 转工单后高亮该 SKU */
        val highlightSkuId: String? = null,
        val board: List<BoardItemDto> = emptyList(),
        /** 未完成工单按桌聚合 · 前厅传菜 */
        val boardTables: List<BoardTablePassDto> = emptyList(),
        val demand: KitchenDemandDto? = null,
        val takeoutOpen: List<BoardTakeoutDto> = emptyList(),
        val qc: List<QcRecordDto> = emptyList(),
        /** 缺料对照用库存快照 */
        val stock: List<StockItem> = emptyList(),
        /** 就餐桌 · 转工单挂桌 */
        val posTables: List<PosTableDto> = emptyList(),
        val rev: String? = null,
        /** 硬错误（断网/鉴权等） */
        val error: String? = null,
        /** 软提示（无快照空开等），不阻断浏览 */
        val emptyHint: String? = null
    )

    sealed interface KitchenIntent {
        data class SelectTab(val tab: KitchenTab) : KitchenIntent
        data object Refresh : KitchenIntent
        data class SelectRecipe(val skuId: String) : KitchenIntent
        data object CloseRecipe : KitchenIntent
        data class SetScaleQty(val qty: Int) : KitchenIntent
        /** 工单 → 菜谱回链（保留/带入计划份数） */
        data class OpenRecipeFromWorkorder(val skuId: String, val qty: Int? = null) : KitchenIntent
        /** 菜谱转工单成功后：切工单 Tab 并刷新 */
        data class AfterWorkorderQueued(val skuId: String, val qty: Int) : KitchenIntent
        data object LoadStock : KitchenIntent
    }

    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val _state = MutableStateFlow(KitchenState())
    val state: StateFlow<KitchenState> = _state.asStateFlow()

    fun dispatch(intent: KitchenIntent) {
        when (intent) {
            is KitchenIntent.SelectTab -> selectTab(intent.tab)
            KitchenIntent.Refresh -> {
                refreshAll()
                loadStock()
            }
            is KitchenIntent.SelectRecipe -> selectRecipe(intent.skuId)
            KitchenIntent.CloseRecipe ->
                _state.update {
                    it.copy(selectedRecipe = null, selectedSteps = emptyList(), selectedCostCard = null, scaleQty = 67)
                }
            is KitchenIntent.SetScaleQty ->
                _state.update { it.copy(scaleQty = intent.qty.coerceIn(1, 2000)) }
            is KitchenIntent.OpenRecipeFromWorkorder -> openFromWorkorder(intent.skuId, intent.qty)
            is KitchenIntent.AfterWorkorderQueued -> afterWorkorderQueued(intent.skuId, intent.qty)
            KitchenIntent.LoadStock -> loadStock()
        }
    }

    private fun selectTab(tab: KitchenTab) {
        _state.update { it.copy(tab = tab) }
        val s = _state.value
        when (tab) {
            KitchenTab.RECIPES -> if (s.recipes.isEmpty()) refreshAll()
            KitchenTab.WORKORDERS -> loadWorkorders(force = true)
            KitchenTab.BOARD -> loadBoard(force = true)
            KitchenTab.QC -> loadQc(force = true)
        }
    }

    private fun openFromWorkorder(skuId: String, qty: Int?) {
        _state.update {
            it.copy(
                tab = KitchenTab.RECIPES,
                scaleQty = qty?.coerceIn(1, 2000) ?: it.scaleQty,
                highlightSkuId = skuId
            )
        }
        selectRecipe(skuId, resetScaleToBatch = qty == null)
    }

    private fun afterWorkorderQueued(skuId: String, qty: Int) {
        _state.update {
            it.copy(
                tab = KitchenTab.WORKORDERS,
                highlightSkuId = skuId,
                scaleQty = qty.coerceIn(1, 2000)
            )
        }
        loadWorkorders(force = true)
    }

    private fun applySoft(hint: String?, message: String?): String? =
        LoadFailure.fromApiHint(hint, message)?.hint

    private fun applyFail(e: Exception, keepData: Boolean = true) {
        val fail = LoadFailure.from(e)
        _state.update {
            it.copy(
                loading = false,
                detailLoading = false,
                error = if (fail.soft) null else fail.error,
                emptyHint = fail.hint ?: it.emptyHint,
                // 软失败不清已有列表
                recipes = if (keepData) it.recipes else emptyList()
            )
        }
    }

    private fun refreshAll() {
        scope.launch {
            val soft = _state.value.recipes.isNotEmpty()
            _state.update { it.copy(loading = !soft, error = null) }
            try {
                val resp = kitchenRepository.recipes()
                val softHint = applySoft(resp.hint, resp.message)
                _state.update {
                    it.copy(
                        loading = false,
                        recipes = resp.items,
                        baobenSummary = resp.baobenSummary,
                        rev = resp.revText().ifEmpty { null },
                        emptyHint = softHint ?: it.emptyHint,
                        error = null
                    )
                }
                // 进后厨默认在工单席：一并拉工单+出品，前厅传菜也能用
                loadWorkorders(force = true)
                loadBoard(force = true)
                when (_state.value.tab) {
                    KitchenTab.QC -> loadQc(force = true)
                    else -> { /* recipes/workorders/board already */ }
                }
            } catch (e: Exception) {
                applyFail(e)
            }
        }
    }

    private fun selectRecipe(skuId: String, resetScaleToBatch: Boolean = true) {
        scope.launch {
            _state.update { it.copy(detailLoading = true) }
            try {
                val resp = kitchenRepository.recipeDetail(skuId)
                val item = resp.item ?: _state.value.recipes.firstOrNull { r -> r.skuId == skuId }
                val batch = batchYieldFromParams(item)
                _state.update {
                    it.copy(
                        detailLoading = false,
                        selectedRecipe = item,
                        selectedSteps = resp.steps,
                        selectedCostCard = resp.costCard,
                        highlightSkuId = skuId,
                        scaleQty = if (resetScaleToBatch) batch else it.scaleQty.coerceIn(1, 2000),
                        error = null
                    )
                }
                if (_state.value.stock.isEmpty()) loadStock()
            } catch (e: Exception) {
                applyFail(e)
            }
        }
    }

    /** 从配方 params 读一批出成个数；缺省 67（金丰标准红黄绿白） */
    private fun batchYieldFromParams(recipe: RecipeDto?): Int {
        val p = recipe?.params ?: return 67
        for (key in listOf("一批出成_个", "一批出成_中位")) {
            val el = p[key] ?: continue
            val n = el.jsonPrimitive.intOrNull
                ?: el.jsonPrimitive.doubleOrNull?.toInt()
                ?: el.jsonPrimitive.contentOrNull?.toDoubleOrNull()?.toInt()
            if (n != null && n > 0) return n
        }
        return 67
    }

    private fun loadStock() {
        val repo = inventoryRepository ?: return
        scope.launch {
            try {
                val items = repo.stockItems()
                val tables = runCatching { repo.posTables() }.getOrElse { emptyList() }
                _state.update { it.copy(stock = items, posTables = tables) }
            } catch (_: Exception) {
                // 缺料为增强能力，失败不阻断主链路
            }
        }
    }

    private fun loadWorkorders(force: Boolean = false) {
        if (!force && _state.value.workorders.isNotEmpty()) return
        scope.launch {
            val soft = _state.value.workorders.isNotEmpty()
            _state.update { it.copy(loading = !soft, error = null) }
            try {
                val resp = kitchenRepository.workorders(today)
                val demand = runCatching { kitchenRepository.demand(today) }.getOrNull()
                val softHint = applySoft(resp.hint, resp.message)
                _state.update {
                    it.copy(
                        loading = false,
                        workorders = resp.workorders,
                        demand = demand ?: it.demand,
                        takeoutOpen = demand?.takeoutOrders ?: it.takeoutOpen,
                        rev = resp.revText().ifBlank { it.rev },
                        emptyHint = softHint ?: it.emptyHint,
                        error = null
                    )
                }
            } catch (e: Exception) {
                applyFail(e)
            }
        }
    }

    private fun loadBoard(force: Boolean = false) {
        if (!force && _state.value.board.isNotEmpty()) return
        scope.launch {
            val soft = _state.value.board.isNotEmpty()
            _state.update { it.copy(loading = !soft, error = null) }
            try {
                val resp = kitchenRepository.board(today)
                _state.update {
                    it.copy(
                        loading = false,
                        board = resp.boardItems(),
                        boardTables = resp.tables,
                        demand = resp.demand,
                        takeoutOpen = resp.takeoutOpen,
                        rev = resp.revText().ifBlank { it.rev },
                        error = null
                    )
                }
            } catch (e: Exception) {
                applyFail(e)
            }
        }
    }

    private fun loadQc(force: Boolean = false) {
        if (!force && _state.value.qc.isNotEmpty()) return
        scope.launch {
            val soft = _state.value.qc.isNotEmpty()
            _state.update { it.copy(loading = !soft, error = null) }
            try {
                val v = kitchenRepository.qc(today).items
                _state.update { it.copy(loading = false, qc = v, error = null) }
            } catch (e: Exception) {
                applyFail(e)
            }
        }
    }

    private fun <T> load(call: suspend () -> T, apply: (KitchenState, T) -> KitchenState) {
        scope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                val v = call()
                _state.update { apply(it.copy(loading = false), v) }
            } catch (e: Exception) {
                applyFail(e)
            }
        }
    }

    fun clear() = scope.cancel()
}
