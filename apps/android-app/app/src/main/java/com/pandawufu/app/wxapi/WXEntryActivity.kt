package com.pandawufu.app.wxapi

import android.app.Activity
import android.os.Bundle
import com.pandawufu.app.BuildConfig
import com.pandawufu.app.auth.WeChatAuth
import com.tencent.mm.opensdk.modelbase.BaseReq
import com.tencent.mm.opensdk.modelbase.BaseResp
import com.tencent.mm.opensdk.openapi.IWXAPIEventHandler
import com.tencent.mm.opensdk.openapi.WXAPIFactory

/**
 * 微信开放平台回调页（包名必须为 {applicationId}.wxapi.WXEntryActivity）。
 */
class WXEntryActivity : Activity(), IWXAPIEventHandler {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val api = WXAPIFactory.createWXAPI(this, BuildConfig.WECHAT_APP_ID, false)
        try {
            api.handleIntent(intent, this)
        } catch (_: Exception) {
            WeChatAuth.onAuthResp(null)
            finish()
        }
    }

    override fun onNewIntent(intent: android.content.Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        val api = WXAPIFactory.createWXAPI(this, BuildConfig.WECHAT_APP_ID, false)
        api.handleIntent(intent, this)
    }

    override fun onReq(req: BaseReq?) {
        finish()
    }

    override fun onResp(resp: BaseResp?) {
        WeChatAuth.onAuthResp(resp)
        finish()
    }
}
