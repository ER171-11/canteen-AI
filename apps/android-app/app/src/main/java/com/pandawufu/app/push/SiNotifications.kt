package com.pandawufu.app.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.pandawufu.shared.model.InboxDto

/**
 * SI 收件箱本地通知。
 * P0：无 FCM/APNs 凭证，用 JobScheduler 后台轮询 + 本地通知；接入云端通道后在 lib/push.js 替换。
 */
object SiNotifications {
    const val CHANNEL_ID = "si_inbox"
    const val NOTIFY_ID = 8801

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = context.getSystemService(NotificationManager::class.java) ?: return
        if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
        val ch = NotificationChannel(
            CHANNEL_ID,
            "SI 收件箱",
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply { description = "SI 需要你拍板 / 已代办 / 预警" }
        mgr.createNotificationChannel(ch)
    }

    fun hasPermission(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    /** 有需要老板处理的事项时发通知；返回是否已发送 */
    fun notifyInbox(context: Context, inbox: InboxDto): Boolean {
        ensureChannel(context)
        if (!hasPermission(context)) return false
        val counts = inbox.counts
        if (counts.total <= 0) return false
        val title = when {
            counts.decide > 0 -> "SI：${counts.decide} 件等你拍板"
            counts.alerts > 0 -> "SI：${counts.alerts} 条经营预警"
            else -> "SI：有 ${counts.total} 条新消息"
        }
        val text = buildString {
            if (counts.decide > 0) append("待批 ${counts.decide} · ")
            if (counts.doing > 0) append("执行中 ${counts.doing} · ")
            if (counts.alerts > 0) append("预警 ${counts.alerts} · ")
            if (counts.feed > 0) append("通知 ${counts.feed}")
        }.trim().trimEnd('·').trim()

        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        val pi = launch?.let {
            PendingIntent.getActivity(
                context,
                NOTIFY_ID,
                it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }
        val n = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        NotificationManagerCompat.from(context).notify(NOTIFY_ID, n)
        return true
    }
}
