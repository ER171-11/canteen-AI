package com.pandawufu.shared.network

import com.pandawufu.shared.model.*
import io.ktor.client.*
import io.ktor.client.call.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.request.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import kotlinx.serialization.json.Json

/**
 * BFF HTTP 客户端。
 * @param baseUrl 可配：Android 模拟器用 http://10.0.2.2:8787，真机/iOS 用 http://127.0.0.1:8787 或局域网地址。
 * @param tokenProvider 鉴权 Bearer token 注入点（登录态由端侧持有，不写入 kmp-shared）。
 */
class BffClient(
    val baseUrl: String,
    private val tokenProvider: () -> String? = { null }
) {
    val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    internal val http = HttpClient {
        install(ContentNegotiation) { json(json) }
    }

    private fun HttpRequestBuilder.auth() {
        tokenProvider()?.let { header(HttpHeaders.Authorization, "Bearer $it") }
    }

    suspend fun health(): HealthDto =
        http.get("$baseUrl/api/health") { auth() }.body()

    suspend fun snapshotLatest(): SnapshotDto =
        http.get("$baseUrl/api/snapshot/latest") { auth() }.body()

    suspend fun reportDaily(): ReportDailyDto =
        http.get("$baseUrl/api/report/daily") { auth() }.body()

    /** 补货建议（日耗优先，只读；写仍走 restock.create） */
    suspend fun restockSuggest(): RestockSuggestResponse =
        http.get("$baseUrl/api/inventory/restock-suggest") { auth() }.body()

    /** 食材验收标准库 */
    suspend fun acceptStandards(): AcceptStandardsResponse =
        http.get("$baseUrl/api/inventory/accept-standards") { auth() }.body()

    /** 逐项验收记录 */
    suspend fun recvAccept(date: String? = null): RecvAcceptResponse =
        http.get("$baseUrl/api/inventory/recv-accept") {
            auth()
            if (!date.isNullOrBlank()) parameter("date", date)
        }.body()

    /** 唯一写入口的下层传输。调用方必须是 ConfirmGateway。 */
    suspend fun postAction(action: ActionDto): ActionEnqueueResponse =
        http.post("$baseUrl/api/actions") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(ActionEnqueueRequest(action.type, action.payload, action.operator))
        }.body()

    suspend fun confirmAction(id: String, operator: String?, rev: String?): ActionConfirmResponse =
        http.post("$baseUrl/api/actions/$id/confirm") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(ActionConfirmRequest(operator, rev))
        }.body()

    /** POST /api/actions/{id}/reject — 老板驳回草稿/待执行 */
    suspend fun rejectAction(id: String, reason: String?): ActionRejectResponse =
        http.post("$baseUrl/api/actions/$id/reject") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(ActionRejectRequest(reason = reason))
        }.body()

    /** GET /api/actions/{id}/status — 等店内消费器执行 */
    suspend fun actionStatus(id: String): ActionStatusResponse =
        http.get("$baseUrl/api/actions/$id/status") { auth() }.body()

    /** 非流式 Kimi 视觉。 */
    suspend fun kimiVision(request: KimiVisionRequest): KimiVisionResponse =
        http.post("$baseUrl/api/kimi/vision") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(request)
        }.body()

    /** POST /api/auth/login {account, password?, device_fp} → Bearer token */
    suspend fun login(account: String, deviceFp: String, password: String? = null): LoginResponse =
        http.post("$baseUrl/api/auth/login") {
            contentType(ContentType.Application.Json)
            setBody(LoginRequest(account, deviceFp, password))
        }.body()

    /** GET /api/auth/wechat/config */
    suspend fun wechatAuthConfig(): WechatAuthConfig =
        http.get("$baseUrl/api/auth/wechat/config").body()

    /** POST /api/auth/wechat {code, device_fp, ...} */
    suspend fun wechatLogin(
        code: String,
        deviceFp: String,
        account: String? = null,
        password: String? = null,
        inviteCode: String? = null
    ): LoginResponse =
        http.post("$baseUrl/api/auth/wechat") {
            contentType(ContentType.Application.Json)
            setBody(WechatLoginRequest(code, deviceFp, account, password, inviteCode))
        }.body()

    suspend fun register(
        account: String,
        password: String,
        inviteCode: String,
        displayName: String? = null,
        deviceFp: String? = null
    ): LoginResponse =
        http.post("$baseUrl/api/auth/register") {
            contentType(ContentType.Application.Json)
            setBody(RegisterRequest(account, password, inviteCode, displayName, deviceFp))
        }.body()

    /** GET /api/auth/me — 刷新岗位权限 */
    suspend fun authMe(): AuthMeResponse =
        http.get("$baseUrl/api/auth/me") { auth() }.body()

    /** GET /api/actions?status= */
    suspend fun listActions(status: String? = null): ActionsListResponse =
        http.get("$baseUrl/api/actions") {
            auth()
            if (!status.isNullOrBlank()) parameter("status", status)
        }.body()

    suspend fun kitchenRecipes(): RecipesResponse =
        http.get("$baseUrl/api/kitchen/recipes") { auth() }.body()

    suspend fun kitchenRecipeDetail(skuId: String): RecipeDetailResponse =
        http.get("$baseUrl/api/kitchen/recipes/$skuId") { auth() }.body()

    suspend fun kitchenWorkorders(date: String? = null): WorkordersResponse =
        http.get("$baseUrl/api/sop/workorder") {
            auth()
            if (date != null) parameter("date", date)
        }.body()

    suspend fun kitchenQc(date: String? = null): QcResponse =
        http.get("$baseUrl/api/kitchen/qc") {
            auth()
            if (date != null) parameter("date", date)
        }.body()

    suspend fun kitchenBoard(date: String? = null): BoardResponse =
        http.get("$baseUrl/api/kitchen/board") {
            auth()
            if (date != null) parameter("date", date)
        }.body()

    suspend fun kitchenDemand(date: String? = null): KitchenDemandDto =
        http.get("$baseUrl/api/kitchen/demand") {
            auth()
            if (date != null) parameter("date", date)
        }.body()

    suspend fun modulesStaff(): StaffModuleDto =
        http.get("$baseUrl/api/modules/staff") { auth() }.body()

    suspend fun modulesBooking(date: String? = null): BookingModuleDto =
        http.get("$baseUrl/api/modules/booking") {
            auth()
            if (date != null) parameter("date", date)
        }.body()

    suspend fun modulesFoodsafe(): FoodsafeModuleDto =
        http.get("$baseUrl/api/modules/foodsafe") { auth() }.body()

    suspend fun modulesAnalysis(): AnalysisModuleDto =
        http.get("$baseUrl/api/modules/analysis") { auth() }.body()

    suspend fun modulesVip(): VipModuleDto =
        http.get("$baseUrl/api/modules/vip") { auth() }.body()

    suspend fun modulesTakeout(): TakeoutModuleDto =
        http.get("$baseUrl/api/modules/takeout") { auth() }.body()

    suspend fun modulesReview(): ReviewModuleDto =
        http.get("$baseUrl/api/modules/review") { auth() }.body()

    suspend fun modulesEquipment(): EquipmentModuleDto =
        http.get("$baseUrl/api/modules/equipment") { auth() }.body()

    suspend fun modulesFinance(): FinanceModuleDto =
        http.get("$baseUrl/api/modules/finance") { auth() }.body()

    suspend fun modulesLoss(): LossModuleDto =
        http.get("$baseUrl/api/modules/loss") { auth() }.body()

    suspend fun modulesSupply(): SupplyModuleDto =
        http.get("$baseUrl/api/modules/supply") { auth() }.body()

    suspend fun modulesPos(): PosModuleDto =
        http.get("$baseUrl/api/modules/pos") { auth() }.body()

    /** GET /api/org — 门店/岗位/用户概览 */
    suspend fun orgOverview(): OrgOverviewResponse =
        http.get("$baseUrl/api/org") { auth() }.body()

    /** POST /api/org/users — 开账号（需 org.write） */
    suspend fun orgCreateUser(req: OrgCreateUserRequest): OrgCreateUserResponse =
        http.post("$baseUrl/api/org/users") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(req)
        }.body()

    /** POST /api/org/stores — 新店筹备 */
    suspend fun orgCreateStore(req: OrgCreateStoreRequest): OrgCreateStoreResponse =
        http.post("$baseUrl/api/org/stores") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(req)
        }.body()

    /** POST /api/org/stores/update — 改门店资料 */
    suspend fun orgUpdateStore(req: OrgUpdateStoreRequest): OrgUpdateStoreResponse =
        http.post("$baseUrl/api/org/stores/update") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(req)
        }.body()

    /** GET /api/admin/config — 店内经营配置（快照 data.config） */
    suspend fun adminConfig(): AdminConfigResponse =
        http.get("$baseUrl/api/admin/config") { auth() }.body()

    /** POST /api/org/users/update — 改岗/停用 */
    suspend fun orgUpdateUser(req: OrgUpdateUserRequest): OrgUpdateUserResponse =
        http.post("$baseUrl/api/org/users/update") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(req)
        }.body()

    /** POST /api/org/users/reset-password — 重置员工密码（org 直连写既有约定） */
    suspend fun orgResetPassword(req: OrgResetPasswordRequest): OrgResetPasswordResponse =
        http.post("$baseUrl/api/org/users/reset-password") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(req)
        }.body()

    suspend fun agentChat(question: String, ctx: Map<String, String> = emptyMap()): AgentChatResponse =
        http.post("$baseUrl/api/agent/chat") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(AgentChatRequest(question, ctx))
        }.body()

    /** GET /api/report/briefing — SI 早报（确定性，无 LLM） */
    suspend fun reportBriefing(): BriefingDto =
        http.get("$baseUrl/api/report/briefing") { auth() }.body()

    /** GET /api/inbox — SI 收件箱聚合（需拍板/正在办/异常/通知） */
    suspend fun inbox(): InboxDto =
        http.get("$baseUrl/api/inbox") { auth() }.body()

    /** POST /api/inbox/ack — 标记 SI 通知已读 */
    suspend fun ackInbox(id: String? = null, all: Boolean = false): InboxAckResponse =
        http.post("$baseUrl/api/inbox/ack") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(InboxAckRequest(id = id, all = if (all) true else null))
        }.body()

    /** POST /api/push/register — 登记设备（P0 后台轮询；P1 走 FCM/APNs） */
    suspend fun registerPush(token: String, platform: String, account: String? = null): PushRegisterResponse =
        http.post("$baseUrl/api/push/register") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(PushRegisterRequest(token, platform, account))
        }.body()

    /* ---------------- 分级授权政策 / 审计 ---------------- */

    /** GET /api/policies — 政策总览（含自动执行总开关 + 今日自动数） */
    suspend fun policies(): PolicyViewDto =
        http.get("$baseUrl/api/policies") { auth() }.body()

    /** POST /api/policies/toggle — 开/关自动执行总开关 */
    suspend fun togglePolicies(autoEnabled: Boolean): PolicyViewDto =
        http.post("$baseUrl/api/policies/toggle") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(PolicyToggleRequest(autoEnabled))
        }.body()

    /** POST /api/policies — 新增/更新一条政策 */
    suspend fun upsertPolicy(req: PolicyUpsertRequest): PolicyUpsertResponse =
        http.post("$baseUrl/api/policies") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(req)
        }.body()

    /** DELETE /api/policies/{id} */
    suspend fun deletePolicy(id: String): PolicyUpsertResponse =
        http.delete("$baseUrl/api/policies/$id") { auth() }.body()

    /** GET /api/si/audit — SI 决策审计 */
    suspend fun siAudit(limit: Int = 50): SiAuditResponse =
        http.get("$baseUrl/api/si/audit") {
            auth()
            parameter("limit", limit)
        }.body()

    /** GET /api/si/goals — 经营目标达成评估（只读） */
    suspend fun siGoals(): GoalsViewDto =
        http.get("$baseUrl/api/si/goals") { auth() }.body()

    /** POST /api/si/goals — 设/改目标 */
    suspend fun upsertGoal(req: GoalUpsertRequest): GoalsViewDto =
        http.post("$baseUrl/api/si/goals") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(req)
        }.body()

    /** POST /api/si/simulate — What-if 数字孪生模拟（只读） */
    suspend fun siSimulate(req: SimRequest): SimResultDto =
        http.post("$baseUrl/api/si/simulate") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(req)
        }.body()

    /** GET /api/si/preferences — 老板偏好（简报时间/关注指标/免打扰） */
    suspend fun siPreferences(): PreferencesResponse =
        http.get("$baseUrl/api/si/preferences") { auth() }.body()

    /** POST /api/si/preferences — 保存偏好 */
    suspend fun saveSiPreferences(prefs: PreferencesDto): PreferencesResponse =
        http.post("$baseUrl/api/si/preferences") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(prefs)
        }.body()

    /* ---------------- SI 专家团 / 战役 / 知识 ---------------- */

    /** GET /api/si/team — 六域专家巡检 */
    suspend fun siTeam(): TeamReviewDto =
        http.get("$baseUrl/api/si/team") { auth() }.body()

    /** GET /api/si/pipeline — SI 主线流程（看盘→抓异常→出方案→执行→追踪→沉淀） */
    suspend fun siPipeline(): PipelineDto =
        http.get("$baseUrl/api/si/pipeline") { auth() }.body()

    /** GET /api/si/cockpit — 老板全局驾驶舱（一次拿全店态势） */
    suspend fun siCockpit(): CockpitDto =
        http.get("$baseUrl/api/si/cockpit") { auth() }.body()

    /** GET /api/workbench/procurement — 采购工作台 */
    suspend fun workbenchProcurement(date: String? = null): ProcurementWorkbenchDto =
        http.get("$baseUrl/api/workbench/procurement") {
            auth()
            if (!date.isNullOrBlank()) parameter("date", date)
        }.body()

    /** GET /api/workbench/kitchen — 厨师工作台 */
    suspend fun workbenchKitchen(date: String? = null): KitchenWorkbenchDto =
        http.get("$baseUrl/api/workbench/kitchen") {
            auth()
            if (!date.isNullOrBlank()) parameter("date", date)
        }.body()

    /** GET /api/workbench/recv — 到货验收 */
    suspend fun workbenchRecv(date: String? = null): RecvWorkbenchDto =
        http.get("$baseUrl/api/workbench/recv") {
            auth()
            if (!date.isNullOrBlank()) parameter("date", date)
        }.body()

    /** GET /api/si/knowledge — SI 沉淀的打法 */
    suspend fun siKnowledge(): KnowledgeResponse =
        http.get("$baseUrl/api/si/knowledge") { auth() }.body()

    /** POST /api/si/knowledge — 沉淀一条人工打法 */
    suspend fun siAddKnowledge(req: KnowledgeAddRequest): KnowledgeAddResponse =
        http.post("$baseUrl/api/si/knowledge") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(req)
        }.body()

    /** DELETE /api/si/knowledge/{id} */
    suspend fun siDeleteKnowledge(id: String): SimpleOkDto =
        http.delete("$baseUrl/api/si/knowledge/$id") { auth() }.body()

    /** GET /api/si/missions — 战役列表 */
    suspend fun siMissions(): MissionsResponse =
        http.get("$baseUrl/api/si/missions") { auth() }.body()

    /** POST /api/si/missions — 新建战役（模板） */
    suspend fun siCreateMission(req: MissionCreateRequest): MissionResponse =
        http.post("$baseUrl/api/si/missions") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(req)
        }.body()

    /** POST /api/si/missions/from-goal — 由目标派生战役 */
    suspend fun siMissionFromGoal(goalId: String): MissionResponse =
        http.post("$baseUrl/api/si/missions/from-goal") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(mapOf("goal_id" to goalId))
        }.body()

    /** POST /api/si/missions/{id}/advance — 完成某步骤 */
    suspend fun siAdvanceMission(id: String, stepId: String?): MissionResponse =
        http.post("$baseUrl/api/si/missions/$id/advance") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(MissionAdvanceRequest(stepId))
        }.body()

    /** POST /api/si/missions/{id}/(pause|resume) */
    suspend fun siSetMissionStatus(id: String, action: String): MissionResponse =
        http.post("$baseUrl/api/si/missions/$id/$action") { auth() }.body()

    /** DELETE /api/si/missions/{id} */
    suspend fun siDeleteMission(id: String): SimpleOkDto =
        http.delete("$baseUrl/api/si/missions/$id") { auth() }.body()

    /** POST /api/si/missions/tick — 手动推进一轮值守 */
    suspend fun siTickMissions(): MissionTickDto =
        http.post("$baseUrl/api/si/missions/tick") { auth() }.body()
}
