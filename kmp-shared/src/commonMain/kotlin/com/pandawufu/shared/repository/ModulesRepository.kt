package com.pandawufu.shared.repository

import com.pandawufu.shared.model.*
import com.pandawufu.shared.network.BffClient

interface ModulesRepository {
    suspend fun staff(): StaffModuleDto
    suspend fun booking(date: String? = null): BookingModuleDto
    suspend fun foodsafe(): FoodsafeModuleDto
    suspend fun analysis(): AnalysisModuleDto
    suspend fun vip(): VipModuleDto
    suspend fun takeout(): TakeoutModuleDto
    suspend fun review(): ReviewModuleDto
    suspend fun equipment(): EquipmentModuleDto
    suspend fun finance(): FinanceModuleDto
    suspend fun loss(): LossModuleDto
    suspend fun supply(): SupplyModuleDto
    suspend fun pos(): PosModuleDto
}

class ModulesRepositoryImpl(private val bff: BffClient) : ModulesRepository {
    override suspend fun staff(): StaffModuleDto = bff.modulesStaff()
    override suspend fun booking(date: String?): BookingModuleDto = bff.modulesBooking(date)
    override suspend fun foodsafe(): FoodsafeModuleDto = bff.modulesFoodsafe()
    override suspend fun analysis(): AnalysisModuleDto = bff.modulesAnalysis()
    override suspend fun vip(): VipModuleDto = bff.modulesVip()
    override suspend fun takeout(): TakeoutModuleDto = bff.modulesTakeout()
    override suspend fun review(): ReviewModuleDto = bff.modulesReview()
    override suspend fun equipment(): EquipmentModuleDto = bff.modulesEquipment()
    override suspend fun finance(): FinanceModuleDto = bff.modulesFinance()
    override suspend fun loss(): LossModuleDto = bff.modulesLoss()
    override suspend fun supply(): SupplyModuleDto = bff.modulesSupply()
    override suspend fun pos(): PosModuleDto = bff.modulesPos()
}

interface AgentRepository {
    suspend fun chat(question: String): AgentChatResponse
    /** 流式问店（SSE）：stage/delta/done/error；失败时调用方回退 [chat] */
    fun chatStream(question: String): kotlinx.coroutines.flow.Flow<com.pandawufu.shared.network.AgentSseEvent>
}

class AgentRepositoryImpl(
    private val bff: BffClient,
    private val sse: com.pandawufu.shared.network.SseClient? = null
) : AgentRepository {
    override suspend fun chat(question: String): AgentChatResponse = bff.agentChat(question)

    override fun chatStream(question: String): kotlinx.coroutines.flow.Flow<com.pandawufu.shared.network.AgentSseEvent> {
        val client = sse ?: throw IllegalStateException("SSE client not configured")
        return client.agentStream(question)
    }
}
