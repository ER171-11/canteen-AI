package com.pandawufu.app.push

import android.app.job.JobParameters
import android.app.job.JobService
import com.pandawufu.app.AppModule
import com.pandawufu.shared.auth.AuthTokenHolder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * SI 收件箱后台轮询（零第三方依赖：JobScheduler，最小周期 15 分钟）。
 * 拉取 /api/inbox，相对上次计数有新增时发本地通知。
 * 接入 FCM/APNs 后可停用本 Job，改由云端推送触发。
 */
class SiPushJobService : JobService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onStartJob(params: JobParameters?): Boolean {
        scope.launch {
            try {
                AppModule.init(applicationContext)
                AppModule.ensureSession()
                if (AuthTokenHolder.get().isNullOrBlank()) return@launch
                if (!AppModule.isOnline()) return@launch
                val inbox = AppModule.siRepository.inbox()
                val total = inbox.counts.total
                val decide = inbox.counts.decide
                val prefs = applicationContext.getSharedPreferences("si_push", 0)
                val lastTotal = prefs.getInt("last_total", -1)
                val lastDecide = prefs.getInt("last_decide", -1)
                // 有新事项，或待拍板数上升 → 通知
                if (total > lastTotal || decide > lastDecide) {
                    SiNotifications.notifyInbox(applicationContext, inbox)
                }
                prefs.edit().putInt("last_total", total).putInt("last_decide", decide).apply()
            } catch (e: Exception) {
                // 后台失败静默，等下次周期
            } finally {
                jobFinished(params, false)
            }
        }
        return true
    }

    override fun onStopJob(params: JobParameters?): Boolean = true
}
