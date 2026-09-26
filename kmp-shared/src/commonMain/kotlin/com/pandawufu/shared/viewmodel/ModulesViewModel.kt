package com.pandawufu.shared.viewmodel

import com.pandawufu.shared.AppDispatchers
import com.pandawufu.shared.model.*
import com.pandawufu.shared.repository.ModulesRepository
import com.pandawufu.shared.util.LoadFailure
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** 经营模块 ViewModel（员工/预订/食安/分析 + 会员/外卖/口碑/设备/财务/损耗） */
class ModulesViewModel(
    private val repo: ModulesRepository,
    dispatcher: CoroutineDispatcher = AppDispatchers.main
) {
    data class State(
        val loading: Boolean = false,
        val error: String? = null,
        val emptyHint: String? = null,
        val staff: StaffModuleDto? = null,
        val booking: BookingModuleDto? = null,
        val foodsafe: FoodsafeModuleDto? = null,
        val analysis: AnalysisModuleDto? = null,
        val vip: VipModuleDto? = null,
        val takeout: TakeoutModuleDto? = null,
        val review: ReviewModuleDto? = null,
        val equipment: EquipmentModuleDto? = null,
        val finance: FinanceModuleDto? = null,
        val loss: LossModuleDto? = null,
        val supply: SupplyModuleDto? = null
    )

    sealed interface Intent {
        data object LoadStaff : Intent
        data class LoadBooking(val date: String? = null) : Intent
        data object LoadFoodsafe : Intent
        data object LoadAnalysis : Intent
        data object LoadVip : Intent
        data object LoadTakeout : Intent
        data object LoadReview : Intent
        data object LoadEquipment : Intent
        data object LoadFinance : Intent
        data object LoadLoss : Intent
        data object LoadSupply : Intent
    }

    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun dispatch(intent: Intent) {
        when (intent) {
            Intent.LoadStaff -> load({ repo.staff() }) { s, d -> s.copy(staff = d) }
            is Intent.LoadBooking -> load({ repo.booking(intent.date) }) { s, d -> s.copy(booking = d) }
            Intent.LoadFoodsafe -> load({ repo.foodsafe() }) { s, d -> s.copy(foodsafe = d) }
            Intent.LoadAnalysis -> load({ repo.analysis() }) { s, d -> s.copy(analysis = d) }
            Intent.LoadVip -> load({ repo.vip() }) { s, d -> s.copy(vip = d) }
            Intent.LoadTakeout -> load({ repo.takeout() }) { s, d -> s.copy(takeout = d) }
            Intent.LoadReview -> load({ repo.review() }) { s, d -> s.copy(review = d) }
            Intent.LoadEquipment -> load({ repo.equipment() }) { s, d -> s.copy(equipment = d) }
            Intent.LoadFinance -> load({ repo.finance() }) { s, d -> s.copy(finance = d) }
            Intent.LoadLoss -> load({ repo.loss() }) { s, d -> s.copy(loss = d) }
            Intent.LoadSupply -> load({ repo.supply() }) { s, d -> s.copy(supply = d) }
        }
    }

    private fun softHintOf(data: Any): String? = when (data) {
        is StaffModuleDto -> LoadFailure.fromApiHint(data.hint, data.message)?.hint
        is BookingModuleDto -> LoadFailure.fromApiHint(data.hint, data.message)?.hint
        is FoodsafeModuleDto -> LoadFailure.fromApiHint(data.hint, data.message)?.hint
        is AnalysisModuleDto -> LoadFailure.fromApiHint(data.hint, data.message)?.hint
            ?: data.note?.takeIf { it.contains("快照") }
        is VipModuleDto -> LoadFailure.fromApiHint(data.hint, data.message)?.hint
        is TakeoutModuleDto -> LoadFailure.fromApiHint(data.hint, data.message)?.hint
        is ReviewModuleDto -> LoadFailure.fromApiHint(data.hint, data.message)?.hint
        is EquipmentModuleDto -> LoadFailure.fromApiHint(data.hint, data.message)?.hint
        is FinanceModuleDto -> LoadFailure.fromApiHint(data.hint, data.message)?.hint
        is LossModuleDto -> LoadFailure.fromApiHint(data.hint, data.message)?.hint
        is SupplyModuleDto -> LoadFailure.fromApiHint(data.hint, data.message)?.hint
        else -> null
    }

    private fun <T> load(
        block: suspend () -> T,
        merge: (State, T) -> State
    ) {
        scope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                val data = block()
                val soft = softHintOf(data as Any)
                _state.update {
                    merge(it, data).copy(
                        loading = false,
                        error = null,
                        emptyHint = soft ?: it.emptyHint
                    )
                }
            } catch (e: Exception) {
                val fail = LoadFailure.from(e)
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
