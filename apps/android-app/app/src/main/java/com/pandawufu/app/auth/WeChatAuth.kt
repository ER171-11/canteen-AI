package com.pandawufu.app.auth

import android.content.Context
import com.pandawufu.app.BuildConfig
import com.tencent.mm.opensdk.modelbase.BaseResp
import com.tencent.mm.opensdk.modelmsg.SendAuth
import com.tencent.mm.opensdk.openapi.IWXAPI
import com.tencent.mm.opensdk.openapi.WXAPIFactory
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

/**
 * 微信授权登录。
 * - 配置了 [BuildConfig.WECHAT_APP_ID] 且已安装微信：走开放平台 SendAuth
 * - 否则返回 demo: 前缀 code，由 BFF 开发模拟换身份
 */
object WeChatAuth {
    private const val TIMEOUT_MS = 120_000L

    @Volatile
    private var api: IWXAPI? = null

    @Volatile
    private var pending: CompletableDeferred<Result<String>>? = null

    private val mutex = Mutex()

    fun appId(): String = BuildConfig.WECHAT_APP_ID.trim()

    fun isSdkReady(): Boolean = appId().isNotBlank()

    fun ensureApi(context: Context): IWXAPI? {
        val id = appId()
        if (id.isBlank()) return null
        api?.let { return it }
        val created = WXAPIFactory.createWXAPI(context.applicationContext, id, true)
        created.registerApp(id)
        api = created
        return created
    }

    fun isWeChatInstalled(context: Context): Boolean {
        val wx = ensureApi(context) ?: return false
        return wx.isWXAppInstalled
    }

    /** WXEntryActivity 回调 */
    fun onAuthResp(resp: BaseResp?) {
        val def = pending ?: return
        when {
            resp == null -> def.complete(Result.failure(IllegalStateException("微信无响应")))
            resp.errCode == BaseResp.ErrCode.ERR_OK && resp is SendAuth.Resp -> {
                val code = resp.code
                if (code.isNullOrBlank()) def.complete(Result.failure(IllegalStateException("微信未返回 code")))
                else def.complete(Result.success(code))
            }
            resp.errCode == BaseResp.ErrCode.ERR_USER_CANCEL ->
                def.complete(Result.failure(IllegalStateException("已取消微信登录")))
            else ->
                def.complete(Result.failure(IllegalStateException("微信授权失败(${resp.errCode})")))
        }
    }

    /**
     * 拉取授权 code。无 AppId / 未装微信时返回 `demo:<device>` 供 BFF 模拟。
     */
    suspend fun requestAuthCode(context: Context, deviceFp: String): Result<String> = mutex.withLock {
        val id = appId()
        if (id.isBlank()) {
            return@withLock Result.success("demo:$deviceFp")
        }
        val wx = ensureApi(context)
            ?: return@withLock Result.success("demo:$deviceFp")
        if (!wx.isWXAppInstalled) {
            return@withLock Result.success("demo:no_wechat_$deviceFp")
        }
        val def = CompletableDeferred<Result<String>>()
        pending = def
        val req = SendAuth.Req().apply {
            scope = "snsapi_userinfo"
            state = "panda_wufu_${System.currentTimeMillis()}"
        }
        val sent = wx.sendReq(req)
        if (!sent) {
            pending = null
            return@withLock Result.failure(IllegalStateException("无法拉起微信，请检查 AppId 与签名"))
        }
        val result = withTimeoutOrNull(TIMEOUT_MS) { def.await() }
        pending = null
        result ?: Result.failure(IllegalStateException("微信授权超时"))
    }
}
