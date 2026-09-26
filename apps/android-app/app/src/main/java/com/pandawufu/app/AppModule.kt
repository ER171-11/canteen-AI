package com.pandawufu.app

import android.content.Context
import android.util.Log
import com.pandawufu.app.auth.ModulePrefs
import com.pandawufu.app.auth.SessionStore
import com.pandawufu.app.offline.CachingHealthRepository
import com.pandawufu.app.offline.CachingModulesRepository
import com.pandawufu.app.offline.CachingReportRepository
import com.pandawufu.app.offline.CachingSnapshotRepository
import com.pandawufu.app.offline.NetworkMonitor
import com.pandawufu.app.offline.OfflineCache
import com.pandawufu.app.offline.OfflineOutbox
import com.pandawufu.app.offline.SyncEngine
import com.pandawufu.shared.auth.AuthTokenHolder
import com.pandawufu.shared.model.LoginResponse
import com.pandawufu.shared.network.BffClient
import com.pandawufu.shared.network.SseClient
import com.pandawufu.shared.redline.ConfirmGateway
import com.pandawufu.shared.repository.ActionRepository
import com.pandawufu.shared.repository.ActionRepositoryImpl
import com.pandawufu.shared.repository.AgentRepository
import com.pandawufu.shared.repository.AgentRepositoryImpl
import com.pandawufu.shared.repository.HealthRepository
import com.pandawufu.shared.repository.HealthRepositoryImpl
import com.pandawufu.shared.repository.InventoryRepository
import com.pandawufu.shared.repository.InventoryRepositoryImpl
import com.pandawufu.shared.repository.KimiRepository
import com.pandawufu.shared.repository.KimiRepositoryImpl
import com.pandawufu.shared.repository.KitchenRepository
import com.pandawufu.shared.repository.KitchenRepositoryImpl
import com.pandawufu.shared.repository.ModulesRepository
import com.pandawufu.shared.repository.ModulesRepositoryImpl
import com.pandawufu.shared.repository.ReportRepository
import com.pandawufu.shared.repository.ReportRepositoryImpl
import com.pandawufu.shared.repository.SnapshotRepository
import com.pandawufu.shared.repository.SnapshotRepositoryImpl
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * 极简服务定位。BFF 地址见 BuildConfig.BFF_BASE_URL。
 * 老板及下属岗位共用：联网主用，离线读缓存 + 写发件箱，联网后 SyncEngine 同步。
 */
object AppModule {
    private const val TAG = "AppModule"
    private val sessionMutex = Mutex()
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private lateinit var appContext: Context

    var sessionStore: SessionStore? = null
        private set

    lateinit var modulePrefs: ModulePrefs
        private set

    lateinit var networkMonitor: NetworkMonitor
        private set

    lateinit var offlineCache: OfflineCache
        private set

    lateinit var offlineOutbox: OfflineOutbox
        private set

    lateinit var syncEngine: SyncEngine
        private set

    @Volatile
    var role: String? = null
        private set

    @Volatile
    var account: String? = null
        private set

    @Volatile
    var storeName: String? = null
        private set

    @Volatile
    var displayName: String? = null
        private set

    @Volatile
    var permissions: Set<String> = emptySet()
        private set

    @Volatile
    private var canWriteFlag: Boolean = false

    val bffClient = BffClient(
        baseUrl = BuildConfig.BFF_BASE_URL,
        tokenProvider = { AuthTokenHolder.get() }
    )
    val sseClient = SseClient(bffClient)

    lateinit var healthRepository: HealthRepository
        private set
    lateinit var snapshotRepository: SnapshotRepository
        private set
    lateinit var reportRepository: ReportRepository
        private set
    lateinit var actionRepository: ActionRepository
        private set
    lateinit var kimiRepository: KimiRepository
        private set
    lateinit var kitchenRepository: KitchenRepository
        private set
    lateinit var inventoryRepository: InventoryRepository
        private set
    lateinit var modulesRepository: ModulesRepository
        private set
    lateinit var agentRepository: AgentRepository
        private set

    fun init(context: Context) {
        appContext = context.applicationContext
        sessionStore = SessionStore(appContext).also {
            it.restoreToHolder()
            applySession(it)
        }
        modulePrefs = ModulePrefs(appContext)

        networkMonitor = NetworkMonitor(appContext).also { it.start() }
        offlineCache = OfflineCache(appContext)
        offlineOutbox = OfflineOutbox(appContext)

        healthRepository = CachingHealthRepository(HealthRepositoryImpl(bffClient), offlineCache, bffClient)
        snapshotRepository = CachingSnapshotRepository(SnapshotRepositoryImpl(bffClient), offlineCache, bffClient)
        reportRepository = CachingReportRepository(ReportRepositoryImpl(bffClient), offlineCache, bffClient)
        actionRepository = ActionRepositoryImpl(bffClient)
        kimiRepository = KimiRepositoryImpl(bffClient, sseClient)
        kitchenRepository = KitchenRepositoryImpl(bffClient)
        inventoryRepository = InventoryRepositoryImpl(bffClient)
        modulesRepository = CachingModulesRepository(ModulesRepositoryImpl(bffClient), offlineCache, bffClient)
        agentRepository = AgentRepositoryImpl(bffClient)

        ConfirmGateway.init(actionRepository)
        syncEngine = SyncEngine(
            network = networkMonitor,
            outbox = offlineOutbox,
            cache = offlineCache,
            bff = bffClient,
            scope = appScope,
            ensureAuth = { ensureSession() }
        ).also { it.start() }
    }

    fun isOnline(): Boolean =
        if (::networkMonitor.isInitialized) networkMonitor.isOnline() else true

    private fun applySession(store: SessionStore) {
        role = store.role
        account = store.account
        storeName = store.storeName
        displayName = store.displayName
        permissions = store.permissions
        canWriteFlag = store.canWrite ||
            store.role == "老板" || store.role == "店长" ||
            store.permissions.contains("actions.write")
    }

    fun canWrite(): Boolean = canWriteFlag

    /**
     * 模块读/写权限。老板/店长全开；其它岗看 permissions 中 `{module}.read|write`。
     */
    fun can(module: String, write: Boolean = false): Boolean {
        if (role == "老板" || role == "店长") return true
        val key = "$module.${if (write) "write" else "read"}"
        if (permissions.contains(key)) return true
        if (!write && permissions.any { it.startsWith("$module.") }) return true
        return false
    }

    /** 经营模块路由 → 权限模块名（与 BFF org.MODULES 对齐） */
    fun moduleOfRoute(route: String): String? = when {
        route == "front" -> "pos"
        route == "m/analysis" -> "analysis"
        route == "m/staff" -> "staff"
        route == "m/vip" -> "vip"
        route == "m/pos" -> "pos"
        route == "m/takeout" -> "takeout"
        route == "m/booking" -> "booking"
        route == "m/foodsafe" -> "foodsafe"
        route == "m/equipment" -> "equipment"
        route == "m/finance" -> "finance"
        route == "m/supply" -> "supply"
        route == "m/review" -> "review"
        route == "m/loss" -> "loss"
        route == "m/actions" -> "actions"
        route == "m/org" || route == "m/restaurant" -> "org"
        route == "inventory" || route.startsWith("inventory/") -> "inventory"
        route == "kitchen" -> "kitchen"
        else -> null
    }

    fun canOpenRoute(route: String): Boolean {
        val mod = moduleOfRoute(route) ?: return true
        return can(mod, write = false)
    }

    fun logout() {
        sessionStore?.clear()
        role = null
        account = null
        storeName = null
        displayName = null
        permissions = emptySet()
        canWriteFlag = false
    }

    /** 用 /api/auth/me 刷新权限；网络失败时保留本地会话（支持离线）。 */
    suspend fun refreshSession(): Boolean = sessionMutex.withLock {
        if (AuthTokenHolder.get().isNullOrBlank()) {
            sessionStore?.restoreToHolder()
        }
        if (AuthTokenHolder.get().isNullOrBlank()) return false
        return withContext(Dispatchers.IO) {
            try {
                val resp = bffClient.authMe()
                val u = resp.user
                if (!resp.ok || u == null) {
                    Log.w(TAG, "auth/me failed: ${resp.error}")
                    // 明确鉴权失败才清；离线或临时错误保留本地岗权
                    if (!isOnline() || looksLikeNetwork(resp.error)) {
                        sessionStore?.let { applySession(it) }
                        return@withContext true
                    }
                    clearSessionLocked()
                    return@withContext false
                }
                role = u.role
                account = u.account ?: account
                storeName = u.storeName
                displayName = u.displayName ?: displayName
                permissions = u.permissions.toSet()
                canWriteFlag = u.canWrite == true ||
                    u.role == "老板" || u.role == "店长" ||
                    u.permissions.contains("actions.write")
                sessionStore?.let { store ->
                    store.role = role
                    store.account = account
                    store.storeId = u.storeId
                    store.storeName = storeName
                    store.displayName = displayName
                    store.canWrite = canWriteFlag
                    store.permissionsCsv = u.permissions.joinToString(",")
                }
                true
            } catch (e: Exception) {
                Log.e(TAG, "auth/me error (keep local session if any)", e)
                if (sessionStore?.token != null) {
                    sessionStore?.let { applySession(it) }
                    true
                } else {
                    false
                }
            }
        }
    }

    private fun looksLikeNetwork(err: String?): Boolean {
        val e = err?.lowercase() ?: return false
        return e.contains("network") || e.contains("timeout") || e.contains("unreachable")
    }

    private fun clearSessionLocked() {
        sessionStore?.clear()
        role = null
        account = null
        storeName = null
        displayName = null
        permissions = emptySet()
        canWriteFlag = false
    }

    sealed class AuthResult {
        data object Ok : AuthResult()
        data class Fail(val message: String, val offlineHint: Boolean = false) : AuthResult()
    }

    suspend fun login(accountName: String, password: String? = null): Boolean =
        loginDetailed(accountName, password) is AuthResult.Ok

    suspend fun loginDetailed(accountName: String, password: String? = null): AuthResult =
        sessionMutex.withLock { doLoginDetailed(accountName, password) }

    suspend fun register(
        accountName: String,
        password: String,
        inviteCode: String,
        displayName: String? = null
    ): Boolean = registerDetailed(accountName, password, inviteCode, displayName) is AuthResult.Ok

    suspend fun registerDetailed(
        accountName: String,
        password: String,
        inviteCode: String,
        displayName: String? = null
    ): AuthResult = sessionMutex.withLock {
        withContext(Dispatchers.IO) {
            try {
                val store = sessionStore
                val deviceFp = store?.deviceFp(appContext) ?: "android-app"
                val resp = bffClient.register(
                    account = accountName,
                    password = password,
                    inviteCode = inviteCode,
                    displayName = displayName,
                    deviceFp = deviceFp
                )
                if (persistLogin(accountName, resp)) AuthResult.Ok
                else AuthResult.Fail(resp.error ?: "注册失败（邀请码无效或账号已存在）")
            } catch (e: Exception) {
                Log.e(TAG, "register error", e)
                AuthResult.Fail(humanNetworkError(e), offlineHint = true)
            }
        }
    }

    suspend fun loginWechatDetailed(
        code: String,
        bindAccount: String? = null,
        bindPassword: String? = null,
        inviteCode: String? = null
    ): AuthResult = sessionMutex.withLock {
        withContext(Dispatchers.IO) {
            try {
                val store = sessionStore
                val deviceFp = store?.deviceFp(appContext) ?: "android-app"
                val resp = bffClient.wechatLogin(
                    code = code,
                    deviceFp = deviceFp,
                    account = bindAccount,
                    password = bindPassword,
                    inviteCode = inviteCode
                )
                val accountName = resp.account?.takeIf { it.isNotBlank() }
                    ?: bindAccount
                    ?: "wx_user"
                if (persistLogin(accountName, resp)) AuthResult.Ok
                else AuthResult.Fail(resp.error ?: "微信登录失败")
            } catch (e: Exception) {
                Log.e(TAG, "wechat login error", e)
                AuthResult.Fail(humanNetworkError(e), offlineHint = true)
            }
        }
    }

    fun canEnterOffline(): Boolean {
        sessionStore?.restoreToHolder()
        return !AuthTokenHolder.get().isNullOrBlank()
    }

    /** 本地会话摘要（登录页展示） */
    fun localSessionSummary(): String? {
        val store = sessionStore ?: return null
        if (store.token.isNullOrBlank()) return null
        val who = store.displayName?.takeIf { it.isNotBlank() }
            ?: store.account
            ?: return null
        val role = store.role ?: ""
        val shop = store.storeName?.takeIf { it.isNotBlank() }
        return buildString {
            append(who)
            if (role.isNotBlank()) append(" · $role")
            if (!shop.isNullOrBlank()) append(" · $shop")
        }
    }

    suspend fun ensureSession(@Suppress("UNUSED_PARAMETER") accountHint: String? = null): Boolean = sessionMutex.withLock {
        if (AuthTokenHolder.get().isNullOrBlank()) {
            sessionStore?.restoreToHolder()
        }
        if (AuthTokenHolder.get().isNullOrBlank()) return false
        sessionStore?.let { applySession(it) }
        true
    }

    private suspend fun doLoginDetailed(accountName: String, password: String?): AuthResult =
        withContext(Dispatchers.IO) {
            try {
                val store = sessionStore
                val deviceFp = if (store != null && ::appContext.isInitialized) {
                    store.deviceFp(appContext)
                } else {
                    "android-app"
                }
                val resp = bffClient.login(accountName, deviceFp = deviceFp, password = password)
                if (persistLogin(accountName, resp)) AuthResult.Ok
                else AuthResult.Fail(resp.error ?: "账号或密码错误")
            } catch (e: Exception) {
                Log.e(TAG, "login error", e)
                val store = sessionStore
                if ((e is IOException || e.message?.contains("Connection", true) == true) &&
                    store?.account == accountName && !store.token.isNullOrBlank()
                ) {
                    store.restoreToHolder()
                    applySession(store)
                    Log.i(TAG, "offline resume account=$accountName")
                    return@withContext AuthResult.Ok
                }
                AuthResult.Fail(humanNetworkError(e), offlineHint = true)
            }
        }

    private fun humanNetworkError(e: Exception): String {
        val m = e.message.orEmpty()
        return when {
            m.contains("Unable to resolve host", true) ||
                m.contains("Failed to connect", true) ||
                m.contains("Connection refused", true) ||
                e is IOException ->
                "连不上门店服务（${BuildConfig.BFF_BASE_URL}）"
            m.contains("timeout", true) -> "连接超时，请检查网络后重试"
            else -> m.ifBlank { "网络异常，请稍后重试" }
        }
    }

    private fun persistLogin(accountName: String, resp: LoginResponse): Boolean {
        val token = resp.token
        if (resp.ok && !token.isNullOrBlank()) {
            AuthTokenHolder.set(token)
            val store = sessionStore
            role = resp.role
            account = accountName
            storeName = resp.storeName
            displayName = resp.displayName
            permissions = resp.permissions.toSet()
            canWriteFlag = resp.canWrite == true ||
                resp.role == "老板" || resp.role == "店长" ||
                resp.permissions.contains("actions.write")
            store?.token = token
            store?.role = resp.role
            store?.account = accountName
            store?.storeId = resp.storeId
            store?.storeName = resp.storeName
            store?.displayName = resp.displayName
            store?.canWrite = canWriteFlag
            store?.permissionsCsv = resp.permissions.joinToString(",")
            Log.i(TAG, "login ok role=${resp.role} store=${resp.storeName} perms=${resp.permissions.size}")
            return true
        }
        Log.w(TAG, "login failed: ${resp.error}")
        return false
    }
}
