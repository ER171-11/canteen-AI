package com.pandawufu.shared.repository

import com.pandawufu.shared.model.BriefingDto
import com.pandawufu.shared.model.GoalUpsertRequest
import com.pandawufu.shared.model.GoalsViewDto
import com.pandawufu.shared.model.InboxAckResponse
import com.pandawufu.shared.model.InboxDto
import com.pandawufu.shared.model.KnowledgeAddRequest
import com.pandawufu.shared.model.KnowledgeAddResponse
import com.pandawufu.shared.model.KnowledgeResponse
import com.pandawufu.shared.model.MissionCreateRequest
import com.pandawufu.shared.model.MissionResponse
import com.pandawufu.shared.model.MissionTickDto
import com.pandawufu.shared.model.MissionsResponse
import com.pandawufu.shared.model.PolicyUpsertRequest
import com.pandawufu.shared.model.PolicyUpsertResponse
import com.pandawufu.shared.model.PolicyViewDto
import com.pandawufu.shared.model.PipelineDto
import com.pandawufu.shared.model.PreferencesDto
import com.pandawufu.shared.model.PreferencesResponse
import com.pandawufu.shared.model.PushRegisterResponse
import com.pandawufu.shared.model.SiAuditResponse
import com.pandawufu.shared.model.SimpleOkDto
import com.pandawufu.shared.model.SimRequest
import com.pandawufu.shared.model.SimResultDto
import com.pandawufu.shared.model.TeamReviewDto
import com.pandawufu.shared.network.BffClient

/** SI 收件箱/简报/政策/目标/模拟数据源 */
interface SiRepository {
    suspend fun briefing(): BriefingDto
    suspend fun inbox(): InboxDto
    suspend fun ackInbox(id: String? = null, all: Boolean = false): InboxAckResponse
    suspend fun registerPush(token: String, platform: String, account: String? = null): PushRegisterResponse
    suspend fun policies(): PolicyViewDto
    suspend fun togglePolicies(autoEnabled: Boolean): PolicyViewDto
    suspend fun upsertPolicy(req: PolicyUpsertRequest): PolicyUpsertResponse
    suspend fun deletePolicy(id: String): PolicyUpsertResponse
    suspend fun audit(limit: Int = 50): SiAuditResponse
    suspend fun goals(): GoalsViewDto
    suspend fun upsertGoal(req: GoalUpsertRequest): GoalsViewDto
    suspend fun simulate(req: SimRequest): SimResultDto
    suspend fun preferences(): PreferencesResponse
    suspend fun savePreferences(prefs: PreferencesDto): PreferencesResponse
    suspend fun team(): TeamReviewDto
    suspend fun pipeline(): PipelineDto
    suspend fun cockpit(): com.pandawufu.shared.model.CockpitDto
    suspend fun procurementWorkbench(date: String? = null): com.pandawufu.shared.model.ProcurementWorkbenchDto
    suspend fun kitchenWorkbench(date: String? = null): com.pandawufu.shared.model.KitchenWorkbenchDto
    suspend fun recvWorkbench(date: String? = null): com.pandawufu.shared.model.RecvWorkbenchDto
    suspend fun knowledge(): KnowledgeResponse
    suspend fun addKnowledge(req: KnowledgeAddRequest): KnowledgeAddResponse
    suspend fun deleteKnowledge(id: String): SimpleOkDto
    suspend fun missions(): MissionsResponse
    suspend fun createMission(req: MissionCreateRequest): MissionResponse
    suspend fun missionFromGoal(goalId: String): MissionResponse
    suspend fun advanceMission(id: String, stepId: String?): MissionResponse
    suspend fun setMissionStatus(id: String, action: String): MissionResponse
    suspend fun deleteMission(id: String): SimpleOkDto
    suspend fun tickMissions(): MissionTickDto
}

class SiRepositoryImpl(private val bff: BffClient) : SiRepository {
    override suspend fun briefing(): BriefingDto = bff.reportBriefing()
    override suspend fun inbox(): InboxDto = bff.inbox()
    override suspend fun ackInbox(id: String?, all: Boolean): InboxAckResponse = bff.ackInbox(id, all)
    override suspend fun registerPush(token: String, platform: String, account: String?): PushRegisterResponse =
        bff.registerPush(token, platform, account)
    override suspend fun policies(): PolicyViewDto = bff.policies()
    override suspend fun togglePolicies(autoEnabled: Boolean): PolicyViewDto = bff.togglePolicies(autoEnabled)
    override suspend fun upsertPolicy(req: PolicyUpsertRequest): PolicyUpsertResponse = bff.upsertPolicy(req)
    override suspend fun deletePolicy(id: String): PolicyUpsertResponse = bff.deletePolicy(id)
    override suspend fun audit(limit: Int): SiAuditResponse = bff.siAudit(limit)
    override suspend fun goals(): GoalsViewDto = bff.siGoals()
    override suspend fun upsertGoal(req: GoalUpsertRequest): GoalsViewDto = bff.upsertGoal(req)
    override suspend fun simulate(req: SimRequest): SimResultDto = bff.siSimulate(req)
    override suspend fun preferences(): PreferencesResponse = bff.siPreferences()
    override suspend fun savePreferences(prefs: PreferencesDto): PreferencesResponse = bff.saveSiPreferences(prefs)
    override suspend fun team(): TeamReviewDto = bff.siTeam()
    override suspend fun pipeline(): PipelineDto = bff.siPipeline()
    override suspend fun cockpit(): com.pandawufu.shared.model.CockpitDto = bff.siCockpit()
    override suspend fun procurementWorkbench(date: String?): com.pandawufu.shared.model.ProcurementWorkbenchDto =
        bff.workbenchProcurement(date)
    override suspend fun kitchenWorkbench(date: String?): com.pandawufu.shared.model.KitchenWorkbenchDto =
        bff.workbenchKitchen(date)
    override suspend fun recvWorkbench(date: String?): com.pandawufu.shared.model.RecvWorkbenchDto =
        bff.workbenchRecv(date)
    override suspend fun knowledge(): KnowledgeResponse = bff.siKnowledge()
    override suspend fun addKnowledge(req: KnowledgeAddRequest): KnowledgeAddResponse = bff.siAddKnowledge(req)
    override suspend fun deleteKnowledge(id: String): SimpleOkDto = bff.siDeleteKnowledge(id)
    override suspend fun missions(): MissionsResponse = bff.siMissions()
    override suspend fun createMission(req: MissionCreateRequest): MissionResponse = bff.siCreateMission(req)
    override suspend fun missionFromGoal(goalId: String): MissionResponse = bff.siMissionFromGoal(goalId)
    override suspend fun advanceMission(id: String, stepId: String?): MissionResponse = bff.siAdvanceMission(id, stepId)
    override suspend fun setMissionStatus(id: String, action: String): MissionResponse = bff.siSetMissionStatus(id, action)
    override suspend fun deleteMission(id: String): SimpleOkDto = bff.siDeleteMission(id)
    override suspend fun tickMissions(): MissionTickDto = bff.siTickMissions()
}
