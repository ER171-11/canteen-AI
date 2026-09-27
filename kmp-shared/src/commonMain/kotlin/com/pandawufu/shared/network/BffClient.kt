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
}
