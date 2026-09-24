package com.pandawufu.shared.redline

import com.pandawufu.shared.model.ActionDto
import com.pandawufu.shared.model.ActionStatus
import com.pandawufu.shared.repository.ActionRepository
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

private class FakeActionRepository : ActionRepository {
    val created = mutableListOf<ActionDto>()
    val confirmed = mutableListOf<ActionDto>()

    override suspend fun create(action: ActionDto): ActionDto {
        created += action
        return action.copy(status = ActionStatus.PENDING, createdAt = "t0")
    }

    override suspend fun confirm(action: ActionDto): ActionDto {
        confirmed += action
        return action.copy(status = ActionStatus.CONFIRMED, updatedAt = "t1")
    }
}

class ConfirmGatewayTest {

    @Test
    fun proposeCreatesPendingAction() = runTest {
        val repo = FakeActionRepository()
        val gateway = ConfirmGateway(repo)
        val action = gateway.propose("restock", mapOf("item" to "火龙果汁", "qty" to "2.4kg"), baseRev = "20260924")
        assertEquals(ActionStatus.PENDING, action.status)
        assertEquals("restock", action.type)
        assertEquals("20260924", action.baseRev)
        assertEquals(1, repo.created.size)
    }

    @Test
    fun confirmTransitionsToConfirmed() = runTest {
        val repo = FakeActionRepository()
        val gateway = ConfirmGateway(repo)
        val pending = gateway.propose("stock_in", mapOf("batch" to "B-0924"))
        val confirmed = gateway.confirm(pending)
        assertEquals(ActionStatus.CONFIRMED, confirmed.status)
        assertEquals(pending.id, repo.confirmed.single().id)
    }

    @Test
    fun initReturnsStableSingleton() {
        val repo = FakeActionRepository()
        val first = ConfirmGateway.init(repo)
        val second = ConfirmGateway.init(FakeActionRepository())
        assertTrue(first === second)
        assertTrue(ConfirmGateway.shared === first)
    }

    @Test
    fun redlineGuardDetectsStaleRev() {
        assertTrue(RedlineGuard.isStale("20260923", "20260924"))
        assertTrue(RedlineGuard.isStale(null, "20260924"))
        assertTrue(RedlineGuard.checkBeforeConfirm("20260924", "20260924"))
        assertTrue(!RedlineGuard.checkBeforeConfirm("1", "2"))
    }
}
