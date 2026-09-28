package com.pandawufu.app.features.inbox

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pandawufu.app.AppModule
import com.pandawufu.app.confirm.OpsSignal
import com.pandawufu.app.features.modules.ModuleCard
import com.pandawufu.app.features.modules.ModuleScaffold
import com.pandawufu.app.ui.BossIa
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.PandaCard
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.app.ui.designsystem.Txt
import com.pandawufu.shared.model.ActionDto
import com.pandawufu.shared.model.InboxItemDto
import com.pandawufu.shared.redline.ConfirmGateway
import com.pandawufu.shared.viewmodel.SiViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull

/**
 * SI 收件箱（原确认台升级）：需拍板 / 执行中 / 预警 / SI 通知。
 * 只读聚合；拍板仍走 ConfirmGateway → actions 队列，SI 不直写。
 */
@Composable
fun InboxScreen(onOpen: (String) -> Unit = {}) {
    val vm = remember { SiViewModel(AppModule.siRepository) }
    val state by vm.state.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val canWrite = AppModule.canWrite()
    var pill by remember { mutableStateOf(0) }
    val pills = listOf("需拍板", "执行中", "预警", "通知")
    var busyId by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) { vm.dispatch(SiViewModel.Intent.Refresh) }
    LaunchedEffect(OpsSignal.refreshHomeTick) {
        if (OpsSignal.refreshHomeTick > 0) vm.dispatch(SiViewModel.Intent.Refresh)
    }
    val hasDoing = state.inbox?.doing?.isNotEmpty() == true
    LaunchedEffect(hasDoing) {
        if (!hasDoing) return@LaunchedEffect
        while (true) {
            delay(5000)
            vm.dispatch(SiViewModel.Intent.Refresh)
        }
    }

    suspend fun latestRev() = runCatching {
        AppModule.bffClient.snapshotLatest().revText().ifBlank { null }
    }.getOrNull()

    fun confirm(item: InboxItemDto) {
        val id = item.id
        busyId = id
        scope.launch {
            try {
                AppModule.ensureSession()
                val op = AppModule.account ?: AppModule.role ?: "老板"
                val rev = latestRev()
                val confirmed = ConfirmGateway.shared.confirm(
                    ActionDto(
                        id = id,
                        type = item.type ?: "",
                        payload = JsonObject(emptyMap()),
                        operator = op,
                        rev = rev,
                        baseRev = rev
                    ),
                    operator = op,
                    rev = rev
                )
                Toast.makeText(context, "已批准 · ${confirmed.id}", Toast.LENGTH_SHORT).show()
                OpsSignal.afterConfirm(item.type ?: "action")
                vm.dispatch(SiViewModel.Intent.Refresh)
            } catch (e: Exception) {
                Toast.makeText(context, e.message ?: "确认失败", Toast.LENGTH_SHORT).show()
            } finally {
                busyId = null
            }
        }
    }

    fun reject(item: InboxItemDto) {
        busyId = item.id
        scope.launch {
            try {
                AppModule.ensureSession()
                val resp = AppModule.bffClient.rejectAction(item.id, "老板驳回")
                Toast.makeText(context, if (resp.ok) "已退回" else (resp.error ?: "退回失败"), Toast.LENGTH_SHORT).show()
                if (resp.ok) vm.dispatch(SiViewModel.Intent.Refresh)
            } catch (e: Exception) {
                Toast.makeText(context, e.message ?: "失败", Toast.LENGTH_SHORT).show()
            } finally {
                busyId = null
            }
        }
    }

    val briefing = state.briefing
    val inbox = state.inbox
    val list: List<InboxItemDto> = when (pill) {
        0 -> inbox?.decide.orEmpty()
        1 -> inbox?.doing.orEmpty()
        2 -> inbox?.alerts.orEmpty()
        else -> inbox?.feed.orEmpty()
    }

    ModuleScaffold(
        title = "SI 收件箱",
        subtitle = "系统算好了 · 你点一次才落库",
        loading = state.loading && inbox == null,
        error = state.error,
        empty = !state.loading && list.isEmpty(),
        emptyText = when (pill) {
            0 -> "没有等你拍板的事 · SI 会主动盯"
            1 -> "没有正在执行的动作"
            2 -> "暂无预警"
            else -> "暂无 SI 通知"
        },
        onRetry = { vm.dispatch(SiViewModel.Intent.Refresh) },
        pills = pills,
        selectedPill = pill,
        onPill = { pill = it },
        hint = if (inbox?.rev == null && inbox != null) "店内快照尚未推送，列表可能为空" else null
    ) {
        if (briefing != null && briefing.headline.isNotBlank()) {
            PandaCard {
                Text("SI 结论", fontWeight = FontWeight.Bold, color = Ink)
                Text(briefing.headline, color = Txt, fontWeight = FontWeight.SemiBold)
                briefing.bullets.take(4).forEach { Text("· $it", color = Sub) }
            }
        }

        if (pill == 3 && list.isNotEmpty() && canWrite) {
            OutlinedButton(
                onClick = { vm.dispatch(SiViewModel.Intent.AckAll) },
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth()
            ) { Text("全部标记已读") }
        }

        if (canWrite) {
            OutlinedButton(
                onClick = { onOpen(com.pandawufu.app.ui.Routes.M_SI_POLICY) },
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth()
            ) { Text("SI 授权与审计 ›") }
        }

        if (list.isNotEmpty()) {
            ModuleCard("${pills[pill]}（${list.size}）") {
                list.take(40).forEach { item ->
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .clickable {
                                item.route?.takeIf { it.isNotBlank() }?.let(onOpen)
                            }
                            .padding(vertical = 8.dp)
                    ) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(
                                levelDot(item.level),
                                color = levelColor(item.level),
                                fontWeight = FontWeight.Bold
                            )
                            Text(item.title, fontWeight = FontWeight.Bold, color = Txt)
                        }
                        if (item.summary.isNotBlank()) {
                            Text(item.summary, color = Sub, style = MaterialTheme.typography.bodySmall)
                        }
                        item.createdAt?.take(16)?.let {
                            Text(it, color = Sub, style = MaterialTheme.typography.bodySmall)
                        }
                        when {
                            pill == 0 && canWrite -> Row(
                                Modifier.fillMaxWidth().padding(top = 6.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                Button(
                                    onClick = { confirm(item) },
                                    enabled = busyId != item.id,
                                    shape = RoundedCornerShape(10.dp),
                                    modifier = Modifier.weight(1f)
                                ) { Text(if (busyId == item.id) "处理中…" else "批准执行") }
                                OutlinedButton(
                                    onClick = { reject(item) },
                                    enabled = busyId != item.id,
                                    shape = RoundedCornerShape(10.dp),
                                    modifier = Modifier.weight(1f)
                                ) { Text("退回") }
                            }
                            pill == 0 && !canWrite -> Text(
                                "当前岗位只读，老板/店长才能拍板",
                                color = Sub,
                                style = MaterialTheme.typography.bodySmall
                            )
                            pill == 1 -> Text("已拍板，等待店内执行器落地", color = Color(0xFF9A6B19))
                            pill == 3 && canWrite -> OutlinedButton(
                                onClick = {
                                    scope.launch {
                                        runCatching {
                                            AppModule.bffClient.ackInbox(item.id, false)
                                            vm.dispatch(SiViewModel.Intent.Refresh)
                                        }
                                    }
                                },
                                shape = RoundedCornerShape(10.dp),
                                modifier = Modifier.fillMaxWidth().padding(top = 4.dp)
                            ) { Text("标记已读") }
                        }
                    }
                }
            }
        }

        Text(
            "说明：SI 只读快照 + 工具取数，提案不会自动落库；" +
                "「需拍板」里的动作确认后才进入店内执行，逾 24 小时未执行会自动过期。",
            style = MaterialTheme.typography.bodySmall,
            color = Sub
        )
    }
}

private fun levelColor(level: String?): Color = when (level) {
    "critical", "warn" -> Color(0xFFE8584A)
    else -> Ink
}

private fun levelDot(level: String?): String = when (level) {
    "critical" -> "●"
    "warn" -> "●"
    else -> "○"
}

/* 供首页跳转复用 */
const val INBOX_TITLE = "SI 收件箱"
