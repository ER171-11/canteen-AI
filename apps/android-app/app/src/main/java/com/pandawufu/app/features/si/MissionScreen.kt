package com.pandawufu.app.features.si

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pandawufu.app.AppModule
import com.pandawufu.app.features.modules.ModuleCard
import com.pandawufu.app.features.modules.ModuleScaffold
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.PandaCard
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.app.ui.designsystem.Txt
import com.pandawufu.shared.model.MissionCreateRequest
import com.pandawufu.shared.model.MissionDto
import com.pandawufu.shared.model.MissionsResponse
import kotlinx.coroutines.launch

/**
 * SI 战役：超长期经营目标，SI 值守推进（低风险步骤可政策内自动），跨天持续执行。
 */
@Composable
fun MissionScreen(onOpen: (String) -> Unit = {}) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val canWrite = AppModule.canWrite()
    var view by remember { mutableStateOf<MissionsResponse?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var autoMode by remember { mutableStateOf(false) }

    suspend fun reload() {
        loading = true
        error = null
        try {
            AppModule.ensureSession()
            view = AppModule.siRepository.missions()
        } catch (e: Exception) {
            val fail = com.pandawufu.shared.util.LoadFailure.from(e)
            error = fail.error ?: fail.hint ?: "加载失败"
        } finally {
            loading = false
        }
    }

    LaunchedEffect(Unit) { reload() }

    ModuleScaffold(
        title = "SI 战役",
        subtitle = "超长期目标 · SI 持续执行 · 低风险可自动",
        loading = loading && view == null,
        error = error,
        onRetry = { scope.launch { reload() } }
    ) {
        if (canWrite) {
            PandaCard {
                Text("让 SI 立一个战役", fontWeight = FontWeight.Bold, color = Ink)
                Text(
                    "选中一个长期目标，SI 会拆步骤、持续跟踪、低风险动作走确认台（开户自动后政策内直接办）。",
                    color = Sub, style = MaterialTheme.typography.bodySmall
                )
                val tpls = listOf(
                    "stock" to "保障不断料",
                    "gross_margin" to "守住毛利率",
                    "revenue" to "冲刺保本",
                    "loss" to "压降损耗",
                    "foodsafe" to "食安零失分"
                )
                Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("低风险步骤自动执行（政策内）", color = Sub, style = MaterialTheme.typography.bodySmall)
                    androidx.compose.material3.Switch(checked = autoMode, onCheckedChange = { autoMode = it })
                }
                tpls.chunked(3).forEach { row ->
                    Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        row.forEach { (tpl, label) ->
                            OutlinedButton(
                                onClick = {
                                    busy = true
                                    scope.launch {
                                        try {
                                            AppModule.ensureSession()
                                            AppModule.siRepository.createMission(
                                                MissionCreateRequest(template = tpl, autonomy = if (autoMode) "auto" else "advise")
                                            )
                                            Toast.makeText(context, "已立战役·$label", Toast.LENGTH_SHORT).show()
                                            reload()
                                        } catch (e: Exception) {
                                            Toast.makeText(context, e.message ?: "创建失败", Toast.LENGTH_SHORT).show()
                                        } finally { busy = false }
                                    }
                                },
                                enabled = !busy,
                                shape = RoundedCornerShape(10.dp),
                                modifier = Modifier.weight(1f)
                            ) { Text(label, fontSize = MaterialTheme.typography.bodySmall.fontSize) }
                        }
                        if (row.size < 3) androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
                    }
                }
                OutlinedButton(
                    onClick = {
                        busy = true
                        scope.launch {
                            try {
                                AppModule.ensureSession()
                                val out = AppModule.siRepository.tickMissions()
                                Toast.makeText(context, "SI 推进 ${out.advanced} 项", Toast.LENGTH_SHORT).show()
                                reload()
                            } catch (e: Exception) {
                                Toast.makeText(context, e.message ?: "推进失败", Toast.LENGTH_SHORT).show()
                            } finally { busy = false }
                        }
                    },
                    enabled = !busy,
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp)
                ) { Text("让 SI 现在推进一轮") }
            }
        }

        val missions = view?.missions.orEmpty()
        if (missions.isEmpty()) {
            PandaCard { Text("暂无战役 · 上面挑一个长期目标交给 SI", color = Sub) }
        }
        missions.forEach { m ->
            MissionCard(
                mission = m,
                canWrite = canWrite,
                busy = busy,
                onOpen = onOpen,
                onAdvance = { stepId ->
                    busy = true
                    scope.launch {
                        try {
                            AppModule.ensureSession()
                            AppModule.siRepository.advanceMission(m.id, stepId)
                            reload()
                        } catch (e: Exception) {
                            Toast.makeText(context, e.message ?: "失败", Toast.LENGTH_SHORT).show()
                        } finally { busy = false }
                    }
                },
                onStatus = { action ->
                    busy = true
                    scope.launch {
                        try {
                            AppModule.ensureSession()
                            AppModule.siRepository.setMissionStatus(m.id, action)
                            reload()
                        } catch (e: Exception) {
                            Toast.makeText(context, e.message ?: "失败", Toast.LENGTH_SHORT).show()
                        } finally { busy = false }
                    }
                },
                onDelete = {
                    busy = true
                    scope.launch {
                        try {
                            AppModule.ensureSession()
                            AppModule.siRepository.deleteMission(m.id)
                            reload()
                        } catch (e: Exception) {
                            Toast.makeText(context, e.message ?: "失败", Toast.LENGTH_SHORT).show()
                        } finally { busy = false }
                    }
                }
            )
        }

        Text(
            "SI 每 15 分钟自动推进一轮；命中政策的低风险步骤会在店内按 rev 乐观锁落库，全程留审计。",
            style = MaterialTheme.typography.bodySmall, color = Sub
        )
    }
}

@Composable
private fun MissionCard(
    mission: MissionDto,
    canWrite: Boolean,
    busy: Boolean,
    onOpen: (String) -> Unit,
    onAdvance: (String?) -> Unit,
    onStatus: (String) -> Unit,
    onDelete: () -> Unit
) {
    val statusColor = when (mission.status) {
        "done" -> FiveGreen
        "paused" -> Sub
        else -> Ink
    }
    val statusLabel = when (mission.status) {
        "done" -> "已完成"
        "paused" -> "已暂停"
        else -> "进行中"
    }
    ModuleCard("${mission.title} · $statusLabel") {
        Text(mission.objective, color = Sub, style = MaterialTheme.typography.bodySmall)
        LinearProgressIndicator(
            progress = { mission.progress / 100f },
            modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
            color = statusColor
        )
        Text(
            "进度 ${mission.progress}% · ${mission.autonomyLabel()} · 值守 ${mission.checkpoints} 次",
            color = Sub, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 4.dp)
        )
        mission.kpi?.let { k ->
            if (k.metric != null) {
                Text("KPI：${k.metric} 目标 ${k.dir.let { if (it == "lte") "≤" else "≥" }}${k.target}${k.unit}", color = Txt)
            }
        }
        mission.steps.forEach { s ->
            Row(
                Modifier.fillMaxWidth().padding(vertical = 4.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        (if (s.status == "done") "✓ " else "• ") + s.label,
                        color = if (s.status == "done") FiveGreen else Txt,
                        fontWeight = FontWeight.SemiBold
                    )
                    Text("负责人：${s.owner}", color = Sub, style = MaterialTheme.typography.bodySmall)
                }
                s.route?.takeIf { it.isNotBlank() }?.let { r ->
                    OutlinedButton(onClick = { onOpen(r) }, shape = RoundedCornerShape(8.dp)) { Text("去办") }
                }
            }
        }
        if (canWrite) {
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (mission.status == "active") {
                    OutlinedButton(
                        onClick = { onAdvance(null) },
                        enabled = !busy,
                        shape = RoundedCornerShape(10.dp),
                        modifier = Modifier.weight(1f)
                    ) { Text("完成当前步骤") }
                    OutlinedButton(
                        onClick = { onStatus("pause") },
                        enabled = !busy,
                        shape = RoundedCornerShape(10.dp),
                        modifier = Modifier.weight(1f)
                    ) { Text("暂停") }
                } else if (mission.status == "paused") {
                    Button(
                        onClick = { onStatus("resume") },
                        enabled = !busy,
                        shape = RoundedCornerShape(10.dp),
                        modifier = Modifier.weight(1f)
                    ) { Text("继续") }
                }
                OutlinedButton(
                    onClick = onDelete,
                    enabled = !busy,
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.weight(1f)
                ) { Text("删除") }
            }
        }
    }
}

private fun MissionDto.autonomyLabel(): String =
    if (autonomy == "auto") "低风险自动授权" else "仅建议·须确认"
