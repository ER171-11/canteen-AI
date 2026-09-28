package com.pandawufu.app.push

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context

/** SI 后台轮询调度（JobScheduler，15 分钟周期）。 */
object SiPushScheduler {
    private const val JOB_ID = 8801

    fun schedule(context: Context) {
        val cm = context.getSystemService(JobScheduler::class.java) ?: return
        if (cm.getPendingJob(JOB_ID) != null) return
        val comp = ComponentName(context, SiPushJobService::class.java)
        val info = JobInfo.Builder(JOB_ID, comp)
            .setPeriodic(15 * 60 * 1000L)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPersisted(true)
            .build()
        cm.schedule(info)
        SiNotifications.ensureChannel(context)
    }

    fun cancel(context: Context) {
        val cm = context.getSystemService(JobScheduler::class.java) ?: return
        cm.cancel(JOB_ID)
    }
}
