package com.pandawufu.shared.viewmodel

import com.pandawufu.shared.AppDispatchers
import com.pandawufu.shared.model.BoardItemDto
import com.pandawufu.shared.model.QcRecordDto
import com.pandawufu.shared.model.RecipeDto
import com.pandawufu.shared.model.SopStepDto
import com.pandawufu.shared.model.WorkorderDto
import com.pandawufu.shared.repository.KitchenRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** 厨房中枢 ViewModel（MVI）。4 子页：菜谱 / 工单 / 出品看板 / 品控。只读，无任何写操作。 */
class KitchenViewModel(
    private val kitchenRepository: KitchenRepository,
    private val today: String? = null,
    /** 可注入调度器：生产用 AppDispatchers.main，单测注入 TestDispatcher */
    dispatcher: kotlinx.coroutines.CoroutineDispatcher = AppDispatchers.main
) {
    enum class KitchenTab(val label: String) { RECIPES("菜谱"), WORKORDERS("工单"), BOARD("出品看板"), QC("品控") }

    data class KitchenState(
        val loading: Boolean = false,
        val tab: KitchenTab = KitchenTab.RECIPES,
        val recipes: List<RecipeDto> = emptyList(),
        /** 选中的配方（展开 BOM/参数/步骤） */
        val selectedRecipe: RecipeDto? = null,
        val selectedSteps: List<SopStepDto> = emptyList(),
        val detailLoading: Boolean = false,
        val workorders: List<WorkorderDto> = emptyList(),
        val board: List<BoardItemDto> = emptyList(),
        val qc: List<QcRecordDto> = emptyList(),
        val rev: String? = null,
        val error: String? = null
    )

    sealed interface KitchenIntent {
        data class SelectTab(val tab: KitchenTab) : KitchenIntent
        data object Refresh : KitchenIntent
        data class SelectRecipe(val skuId: String) : KitchenIntent
        data object CloseRecipe : KitchenIntent
    }

    private val scope = CoroutineScope(SupervisorJob() + dispatcher)

    private val _state = MutableStateFlow(KitchenState())
    val state: StateFlow<KitchenState> = _state.asStateFlow()

    fun dispatch(intent: KitchenIntent) {
        when (intent) {
            is KitchenIntent.SelectTab -> selectTab(intent.tab)
            KitchenIntent.Refresh -> refreshAll()
            is KitchenIntent.SelectRecipe -> selectRecipe(intent.skuId)
            KitchenIntent.CloseRecipe ->
                _state.update { it.copy(selectedRecipe = null, selectedSteps = emptyList()) }
        }
    }

    private fun selectTab(tab: KitchenTab) {
        _state.update { it.copy(tab = tab) }
        // 切子页时按需懒加载
        val s = _state.value
        when (tab) {
            KitchenTab.RECIPES -> if (s.recipes.isEmpty()) refreshAll()
            KitchenTab.WORKORDERS -> if (s.workorders.isEmpty()) loadWorkorders()
            KitchenTab.BOARD -> if (s.board.isEmpty()) loadBoard()
            KitchenTab.QC -> if (s.qc.isEmpty()) loadQc()
        }
    }

    private fun refreshAll() {
        scope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                val resp = kitchenRepository.recipes()
                _state.update { it.copy(loading = false, recipes = resp.items, rev = resp.rev) }
            } catch (e: Exception) {
                _state.update { it.copy(loading = false, error = e.message ?: "network error") }
            }
        }
    }

    private fun selectRecipe(skuId: String) {
        scope.launch {
            _state.update { it.copy(detailLoading = true) }
            try {
                val resp = kitchenRepository.recipeDetail(skuId)
                _state.update {
                    it.copy(
                        detailLoading = false,
                        selectedRecipe = resp.item ?: it.recipes.firstOrNull { r -> r.skuId == skuId },
                        selectedSteps = resp.steps
                    )
                }
            } catch (e: Exception) {
                _state.update { it.copy(detailLoading = false, error = e.message ?: "network error") }
            }
        }
    }

    private fun loadWorkorders() = load(
        call = { kitchenRepository.workorders(today).workorders },
        apply = { s, v -> s.copy(workorders = v) }
    )

    private fun loadBoard() = load(
        call = { kitchenRepository.board(today).items },
        apply = { s, v -> s.copy(board = v) }
    )

    private fun loadQc() = load(
        call = { kitchenRepository.qc(today).items },
        apply = { s, v -> s.copy(qc = v) }
    )

    private fun <T> load(call: suspend () -> T, apply: (KitchenState, T) -> KitchenState) {
        scope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                val v = call()
                _state.update { apply(it.copy(loading = false), v) }
            } catch (e: Exception) {
                _state.update { it.copy(loading = false, error = e.message ?: "network error") }
            }
        }
    }

    fun clear() = scope.cancel()
}
