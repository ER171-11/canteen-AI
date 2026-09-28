package com.pandawufu.app.features.inbox

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
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
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.PandaCard
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.app.ui.designsystem.Txt
import com.pandawufu.shared.model.PolicyDto
import com.pandawufu.shared.model.PolicyMatchDto
import com.pandawufu.shared.model.PolicyUpsertRequest
import com.pandawufu.shared.model.PolicyViewDto
import com.pandawufu.shared.model.PreferencesDto
import com.pandawufu.shared.model.SiAuditResponse
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * SI 授权与审计：分级授权总开关 + 政策清单 + SI 决策审计。
 * 红线：政策只决定 queued→待执行 的提前量，写路径仍是队列→consumer→/api/sync。
 */
@Composable
fun PolicyScreen() {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val canWrite = AppModule.canWrite()

    var view by remember { mutableStateOf<PolicyViewDto?>(null) }
    var audit by remember { mutableStateOf<SiAuditResponse?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    var name by remember { mutableStateOf("") }
    var types by remember { mutableStateOf("restock.create") }
    var maxAmount by remember { mutableStateOf("200") }

    var briefingAt by remember { mutableStateOf("08:00") }
    var eveningAt by remember { mutableStateOf("21:30") }
    var watchMetrics by remember { mutableStateOf("营收,毛利率,损耗") }
    var mutedAlerts by remember { mutableStateOf("") }

    suspend fun reload() {
        loading = true
        error = null
        try {
            AppModule.ensureSession()
            view = AppModule.siRepository.policies()
            audit = AppModule.siRepository.audit(20)
            val p = AppModule.siRepository.preferences().preferences
            briefingAt = p.briefingAt
            eveningAt = p.eveningAt
            watchMetrics = p.watchMetrics.joinToString(",")
            mutedAlerts = p.mutedAlerts.joinToString(",")
        } catch (e: Exception) {
            val fail = com.pandawufu.shared.util.LoadFailure.from(e)
            error = fail.error ?: fail.hint ?: "加载失败"
        } finally {
            loading = false
        }
    }

    LaunchedEffect(Unit) { reload() }

    ModuleScaffold(
        title = "SI 授权与审计",
        subtitle = "政策内自动执行 · 高风险仍须老板确认",
        loading = loading && view == null,
        error = error,
        onRetry = { scope.launch { reload() } }
    ) {
        val autoOn = view?.autoEnabled == true
        PandaCard {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(Modifier.weight(1f)) {
                    Text("自动执行总开关", fontWeight = FontWeight.Bold, color = Ink)
                    Text(
                        if (autoOn) "已开启：命中政策的 SI 动作可直接进入店内执行"
                        else "已关闭：所有 SI 动作仍须你点「批准执行」",
                        color = Sub,
                        style = MaterialTheme.typography.bodySmall
                    )
                }
                Switch(
                    checked = autoOn,
                    enabled = canWrite && !busy,
                    onCheckedChange = { on ->
                        busy = true
                        scope.launch {
                            try {
                                AppModule.ensureSession()
                                view = AppModule.siRepository.togglePolicies(on)
                                Toast.makeText(context, if (on) "已开启自动执行" else "已关闭自动执行", Toast.LENGTH_SHORT).show()
                            } catch (e: Exception) {
                                Toast.makeText(context, e.message ?: "操作失败", Toast.LENGTH_SHORT).show()
                            } finally {
                                busy = false
                            }
                        }
                    }
                )
            }
            Text(
                "今日已自动执行 ${view?.todayAuto ?: 0} 条 · 高风险类型（调价/改配方/人事/对外）永不自动",
                color = Sub,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(top = 6.dp)
            )
        }

        ModuleCard("SI 偏好") {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = briefingAt,
                    onValueChange = { briefingAt = it },
                    label = { Text("早报时间") },
                    singleLine = true,
                    enabled = canWrite,
                    modifier = Modifier.weight(1f)
                )
                OutlinedTextField(
                    value = eveningAt,
                    onValueChange = { eveningAt = it },
                    label = { Text("晚结时间") },
                    singleLine = true,
                    enabled = canWrite,
                    modifier = Modifier.weight(1f)
                )
            }
            OutlinedTextField(
                value = watchMetrics,
                onValueChange = { watchMetrics = it },
                label = { Text("关注指标（逗号分隔）") },
                singleLine = true,
                enabled = canWrite,
                modifier = Modifier.fillMaxWidth().padding(top = 6.dp)
            )
            OutlinedTextField(
                value = mutedAlerts,
                onValueChange = { mutedAlerts = it },
                label = { Text("免打扰预警类型（逗号分隔，可空）") },
                singleLine = true,
                enabled = canWrite,
                modifier = Modifier.fillMaxWidth().padding(top = 6.dp)
            )
            if (canWrite) {
                Button(
                    onClick = {
                        busy = true
                        scope.launch {
                            try {
                                AppModule.ensureSession()
                                AppModule.siRepository.savePreferences(
                                    PreferencesDto(
                                        briefingAt = briefingAt.trim().ifBlank { "08:00" },
                                        eveningAt = eveningAt.trim().ifBlank { "21:30" },
                                        watchMetrics = watchMetrics.split(",", "，").map { it.trim() }.filter { it.isNotBlank() },
                                        mutedAlerts = mutedAlerts.split(",", "，").map { it.trim() }.filter { it.isNotBlank() }
                                    )
                                )
                                Toast.makeText(context, "偏好已保存", Toast.LENGTH_SHORT).show()
                            } catch (e: Exception) {
                                Toast.makeText(context, e.message ?: "保存失败", Toast.LENGTH_SHORT).show()
                            } finally {
                                busy = false
                            }
                        }
                    },
                    enabled = !busy,
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp)
                ) { Text("保存偏好") }
            }
        }

        ModuleCard("政策（${view?.policies?.size ?: 0}）") {
            val list = view?.policies.orEmpty()
            if (list.isEmpty()) {
                Text("暂无政策 · 默认全部动作都需人工确认", color = Sub)
            }
            list.forEach { p ->
                PolicyRow(
                    policy = p,
                    canWrite = canWrite,
                    busy = busy,
                    onToggle = { on ->
                        busy = true
                        scope.launch {
                            try {
                                AppModule.ensureSession()
                                AppModule.siRepository.upsertPolicy(
                                    PolicyUpsertRequest(
                                        id = p.id, name = p.name, enabled = on, match = p.match
                                    )
                                )
                                reload()
                            } catch (e: Exception) {
                                Toast.makeText(context, e.message ?: "操作失败", Toast.LENGTH_SHORT).show()
                            } finally {
                                busy = false
                            }
                        }
                    },
                    onDelete = {
                        busy = true
                        scope.launch {
                            try {
                                AppModule.ensureSession()
                                AppModule.siRepository.deletePolicy(p.id)
                                reload()
                            } catch (e: Exception) {
                                Toast.makeText(context, e.message ?: "删除失败", Toast.LENGTH_SHORT).show()
                            } finally {
                                busy = false
                            }
                        }
                    }
                )
            }
        }

        if (canWrite) {
            ModuleCard("新增政策") {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("政策名，如「小额补货自动执行」") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = types,
                    onValueChange = { types = it },
                    label = { Text("动作类型（逗号分隔，空=不限）") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().padding(top = 6.dp)
                )
                OutlinedTextField(
                    value = maxAmount,
                    onValueChange = { maxAmount = it },
                    label = { Text("单笔金额上限（0=不限）") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().padding(top = 6.dp)
                )
                Button(
                    onClick = {
                        busy = true
                        scope.launch {
                            try {
                                AppModule.ensureSession()
                                val typeList = types.split(",", "，").map { it.trim() }.filter { it.isNotBlank() }
                                AppModule.siRepository.upsertPolicy(
                                    PolicyUpsertRequest(
                                        name = name.ifBlank { "未命名政策" },
                                        enabled = true,
                                        match = PolicyMatchDto(
                                            types = typeList,
                                            maxAmount = maxAmount.toDoubleOrNull() ?: 0.0
                                        )
                                    )
                                )
                                name = ""
                                Toast.makeText(context, "已新增政策", Toast.LENGTH_SHORT).show()
                                reload()
                            } catch (e: Exception) {
                                Toast.makeText(context, e.message ?: "新增失败", Toast.LENGTH_SHORT).show()
                            } finally {
                                busy = false
                            }
                        }
                    },
                    enabled = !busy && name.isNotBlank(),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp)
                ) { Text("保存政策") }
            }
        }

        ModuleCard("SI 决策审计（近 20 条）") {
            val items = audit?.items.orEmpty()
            if (items.isEmpty()) {
                Text("暂无审计记录", color = Sub)
            }
            items.forEach { obj ->
                val decision = (obj["decision"] as? JsonPrimitive)?.contentOrNull ?: ""
                val type = (obj["type"] as? JsonPrimitive)?.contentOrNull ?: "-"
                val reason = (obj["reason"] as? JsonPrimitive)?.contentOrNull ?: ""
                val ts = (obj["ts"] as? JsonPrimitive)?.contentOrNull?.take(19) ?: ""
                Text(
                    "【${decisionLabel(decision)}】$type",
                    fontWeight = FontWeight.SemiBold,
                    color = if (decision == "auto_execute") Color(0xFFE4871A) else Txt
                )
                if (reason.isNotBlank()) Text(reason, color = Sub, style = MaterialTheme.typography.bodySmall)
                if (ts.isNotBlank()) Text(ts, color = Sub, style = MaterialTheme.typography.bodySmall)
            }
        }

        Text(
            "说明：政策命中后动作直接置「待执行」，由店内消费者按三向合并 rev 落库；" +
                "高风险类型不参与自动；每条决策都写入审计。",
            style = MaterialTheme.typography.bodySmall,
            color = Sub
        )
    }
}

@Composable
private fun PolicyRow(
    policy: PolicyDto,
    canWrite: Boolean,
    busy: Boolean,
    onToggle: (Boolean) -> Unit,
    onDelete: () -> Unit
) {
    val typesText = if (policy.match.types.isEmpty()) "全部类型" else policy.match.types.joinToString("、")
    val capText = if (policy.match.maxAmount > 0) "上限 ¥${policy.match.maxAmount}" else "不限金额"
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f)) {
                Text(policy.name, fontWeight = FontWeight.Bold, color = Txt)
                Text("$typesText · $capText · L${policy.tier}", color = Sub, style = MaterialTheme.typography.bodySmall)
            }
            Switch(
                checked = policy.enabled,
                enabled = canWrite && !busy,
                onCheckedChange = onToggle
            )
        }
        if (canWrite) {
            OutlinedButton(
                onClick = onDelete,
                enabled = !busy,
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp)
            ) { Text("删除") }
        }
    }
}

private fun decisionLabel(d: String): String = when (d) {
    "auto_execute" -> "自动执行"
    "hold" -> "待人工"
    "rollback" -> "回滚"
    "rollback_denied" -> "回滚被拒"
    "policy_upsert" -> "改政策"
    "policy_remove" -> "删政策"
    "toggle_auto" -> "开关"
    else -> d
}
