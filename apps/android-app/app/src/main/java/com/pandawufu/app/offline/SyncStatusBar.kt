package com.pandawufu.app.offline

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.AppModule
import com.pandawufu.app.ui.designsystem.FiveYellow
import com.pandawufu.app.ui.designsystem.Ink
import kotlinx.coroutines.launch

/** 顶栏离线/待同步状态条；点按同步，长按清空卡死队列 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SyncStatusBar(modifier: Modifier = Modifier) {
    val online by AppModule.networkMonitor.online.collectAsState()
    val pending by AppModule.syncEngine.pendingCount.collectAsState()
    val syncing by AppModule.syncEngine.syncing.collectAsState()
    val msg by AppModule.syncEngine.lastMessage.collectAsState()
    val fromCache = AppModule.offlineCache.lastServeFromCache
    val scope = rememberCoroutineScope()

    val authStuck = msg?.let {
        it.contains("权限") || it.contains("登录") || it.contains("只读")
    } == true

    if (online && pending == 0 && !fromCache && !syncing && !authStuck) return

    val bg = when {
        !online -> Color(0xFF3A3A3A)
        pending > 0 -> FiveYellow
        authStuck -> Color(0xFFE8584A)
        fromCache -> Color(0xFF5C6BC0)
        else -> Color(0xFF2E7D32)
    }
    val text = when {
        syncing -> "正在同步离线拍板…"
        !online && pending > 0 -> "离线 · 待同步 $pending 条（联网后自动上传）"
        !online -> "离线模式 · 展示本地缓存，拍板将入队"
        pending > 0 -> (msg?.takeIf {
            it.contains("失败") || it.contains("权限") || it.contains("登录")
        } ?: "待同步 $pending 条 · 点此同步 · 长按清空")
        authStuck -> msg!!
        fromCache -> "当前为缓存数据 · 点此刷新"
        else -> return
    }

    Row(
        modifier
            .fillMaxWidth()
            .background(bg)
            .combinedClickable(
                onClick = {
                    if (!online && pending == 0) return@combinedClickable
                    scope.launch {
                        AppModule.ensureSession()
                        if (pending > 0) {
                            AppModule.syncEngine.flush()
                            AppModule.syncEngine.refreshPending()
                        }
                    }
                },
                onLongClick = {
                    if (pending <= 0 && !authStuck) return@combinedClickable
                    AppModule.syncEngine.clearPending("已清空待同步 · 请重新点智能关联")
                }
            )
            .padding(horizontal = 14.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text,
            color = Color.White,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.weight(1f)
        )
        if (online && pending > 0) {
            Text("同步", color = Ink, fontSize = 12.sp, fontWeight = FontWeight.Bold)
        }
    }
}
