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
    internal val json = Json {
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

    /** 唯一写入口的下层传输。调用方必须是 ConfirmGateway。 */
    suspend fun postAction(action: ActionDto): ActionDto =
        http.post("$baseUrl/api/actions") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(action)
        }.body()

    /** 非流式 Kimi 视觉。 */
    suspend fun kimiVision(request: KimiVisionRequest): KimiVisionResponse =
        http.post("$baseUrl/api/kimi/vision") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(request)
        }.body()

    /** POST /api/auth/login {account, device_fp} → Bearer token */
    suspend fun login(account: String, deviceFp: String): LoginResponse =
        http.post("$baseUrl/api/auth/login") {
            contentType(ContentType.Application.Json)
            setBody(LoginRequest(account, deviceFp))
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
}
