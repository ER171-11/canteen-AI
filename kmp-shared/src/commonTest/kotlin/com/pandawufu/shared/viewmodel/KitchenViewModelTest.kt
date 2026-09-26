package com.pandawufu.shared.viewmodel

import com.pandawufu.shared.model.BoardItemDto
import com.pandawufu.shared.model.BoardResponse
import com.pandawufu.shared.model.QcRecordDto
import com.pandawufu.shared.model.QcResponse
import com.pandawufu.shared.model.RecipeDetailResponse
import com.pandawufu.shared.model.RecipeDto
import com.pandawufu.shared.model.RecipesResponse
import com.pandawufu.shared.model.SopStepDto
import com.pandawufu.shared.model.WorkorderDto
import com.pandawufu.shared.model.WorkordersResponse
import com.pandawufu.shared.repository.KitchenRepository
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest

private class FakeKitchenRepository : KitchenRepository {
    var failOn: String? = null
    var softNoSnapshot: Boolean = false

    private val red = RecipeDto(skuId = "dum-red", name = "红色·冬菇荸荠饺", color = "红", blessing = "长寿")

    override suspend fun recipes(): RecipesResponse {
        if (failOn == "recipes") throw RuntimeException("boom")
        if (failOn == "no_snap") throw RuntimeException("no snapshot")
        return RecipesResponse(
            ok = true,
            items = listOf(red),
            rev = if (softNoSnapshot) null else kotlinx.serialization.json.JsonPrimitive("r1"),
            hint = if (softNoSnapshot) "no_snapshot" else null,
            message = if (softNoSnapshot) "店内快照未接通 · 演示" else null
        )
    }

    override suspend fun recipeDetail(skuId: String): RecipeDetailResponse =
        RecipeDetailResponse(
            ok = true,
            item = red,
            steps = listOf(
                SopStepDto(stepNo = 1, stage = "和面", durationMin = 20),
                SopStepDto(stepNo = 2, stage = "包制", durationMin = 20)
            )
        )

    override suspend fun workorders(date: String?): WorkordersResponse {
        if (failOn == "workorders") throw RuntimeException("Failed to connect to /api/kitchen/workorders")
        return WorkordersResponse(
            ok = true,
            workorders = if (softNoSnapshot) emptyList() else listOf(
                WorkorderDto(id = "w1", skuId = "dum-red", name = "红色饺子", qty = 68, status = "doing")
            ),
            hint = if (softNoSnapshot) "no_snapshot" else null,
            message = if (softNoSnapshot) "店内快照未接通 · 演示" else null
        )
    }

    override suspend fun qc(date: String?): QcResponse =
        QcResponse(ok = true, items = listOf(QcRecordDto(id = "q1", checkType = "褶纹", result = "pass")))

    override suspend fun board(date: String?): BoardResponse =
        BoardResponse(ok = true, items = listOf(BoardItemDto(color = "红", planned = 68, done = 48, qcPassRate = 0.96)))

    override suspend fun demand(date: String?): com.pandawufu.shared.model.KitchenDemandDto =
        com.pandawufu.shared.model.KitchenDemandDto(ok = true, date = date)
}

@OptIn(ExperimentalCoroutinesApi::class)
class KitchenViewModelTest {

    private fun newVm(repo: KitchenRepository) =
        KitchenViewModel(repo, dispatcher = UnconfinedTestDispatcher())

    @Test
    fun refreshLoadsRecipesAndRev() = runTest {
        val vm = newVm(FakeKitchenRepository())
        vm.dispatch(KitchenViewModel.KitchenIntent.Refresh)
        assertEquals(1, vm.state.value.recipes.size)
        assertEquals("r1", vm.state.value.rev)
        assertEquals(false, vm.state.value.loading)
        vm.clear()
    }

    @Test
    fun selectTabLazyLoadsWorkordersAndBoard() = runTest {
        val vm = newVm(FakeKitchenRepository())
        vm.dispatch(KitchenViewModel.KitchenIntent.SelectTab(KitchenViewModel.KitchenTab.WORKORDERS))
        assertEquals(KitchenViewModel.KitchenTab.WORKORDERS, vm.state.value.tab)
        assertEquals("w1", vm.state.value.workorders.single().id)

        vm.dispatch(KitchenViewModel.KitchenIntent.SelectTab(KitchenViewModel.KitchenTab.BOARD))
        assertEquals(68, vm.state.value.board.single().planned)

        vm.dispatch(KitchenViewModel.KitchenIntent.SelectTab(KitchenViewModel.KitchenTab.QC))
        assertEquals("q1", vm.state.value.qc.single().id)
        vm.clear()
    }

    @Test
    fun selectAndCloseRecipe() = runTest {
        val vm = newVm(FakeKitchenRepository())
        vm.dispatch(KitchenViewModel.KitchenIntent.Refresh)
        vm.dispatch(KitchenViewModel.KitchenIntent.SelectRecipe("dum-red"))
        assertEquals("红色·冬菇荸荠饺", vm.state.value.selectedRecipe?.name)
        assertEquals(2, vm.state.value.selectedSteps.size)
        assertEquals("和面", vm.state.value.selectedSteps.first().stage)

        vm.dispatch(KitchenViewModel.KitchenIntent.CloseRecipe)
        assertNull(vm.state.value.selectedRecipe)
        assertTrue(vm.state.value.selectedSteps.isEmpty())
        vm.clear()
    }

    @Test
    fun errorPropagatesToState() = runTest {
        val repo = FakeKitchenRepository().apply { failOn = "recipes" }
        val vm = newVm(repo)
        vm.dispatch(KitchenViewModel.KitchenIntent.Refresh)
        assertEquals("boom", vm.state.value.error)
        assertTrue(vm.state.value.recipes.isEmpty())
        vm.clear()
    }

    @Test
    fun noSnapshotIsSoftHintNotHardError() = runTest {
        val repo = FakeKitchenRepository().apply { softNoSnapshot = true }
        val vm = newVm(repo)
        vm.dispatch(KitchenViewModel.KitchenIntent.Refresh)
        assertNull(vm.state.value.error)
        assertEquals(1, vm.state.value.recipes.size)
        assertTrue(vm.state.value.emptyHint?.contains("快照") == true)
        assertTrue(vm.state.value.workorders.isEmpty())
        vm.clear()
    }

    @Test
    fun networkFailureIsHumanized() = runTest {
        val repo = FakeKitchenRepository().apply { failOn = "no_snap" }
        val vm = newVm(repo)
        vm.dispatch(KitchenViewModel.KitchenIntent.Refresh)
        assertNull(vm.state.value.error)
        assertTrue(vm.state.value.emptyHint?.contains("快照") == true)
        vm.clear()
    }
}
