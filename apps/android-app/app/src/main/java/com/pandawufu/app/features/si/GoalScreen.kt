package com.pandawufu.app.features.si

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
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.AppModule
import com.pandawufu.app.features.modules.ModuleCard
import com.pandawufu.app.features.modules.ModuleScaffold
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.PandaCard
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.app.ui.designsystem.Txt
import com.pandawufu.shared.model.GoalItemDto
import com.pandawufu.shared.model.GoalUpsertRequest
import com.pandawufu.shared.model.GoalsViewDto
import kotlinx.coroutines.launch

/**
 * SI 目标面板：老板设目标，SI 用只读快照持续评估达成度并给行动建议。
 */
@Composable
fun GoalScreen(onOpen: (String) -> Unit = {}) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val canWrite = AppModule.canWrite()
    var view by remember { mutableStateOf<GoalsViewDto?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf<GoalItemDto?>(null) }

    suspend fun reload() {
        loading = true
        error = null
        try {
            AppModule.ensureSession()
            view = AppModule.siRepository.goals()
        } catch (e: Exception) {
            val fail = com.pandawufu.shared.util.LoadFailure.from(e)
            error = fail.error ?: fail.hint ?: "加载失败"
        } finally {
            loading = false
        }
    }

    LaunchedEffect(Unit) { reload() }

    ModuleScaffold(
        title = "SI 目标",
        subtitle = "老板定标 · SI 盯进度 · 偏差给建议",
        loading = loading && view == null,
        error = error,
        onRetry = { scope.launch { reload() } }
    ) {
        val score = view?.score ?: 0
        PandaCard {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column {
                    Text("目标达成度", fontSize = 11.sp, color = Sub)
                    Text(
                        "$score%",
                        fontSize = 26.sp,
                        fontWeight = FontWeight.ExtraBold,
                        color = if (score >= 60) FiveGreen else FiveRed
                    )
                }
                Text(
                    when {
                        score >= 80 -> "状态很好"
                        score >= 60 -> "大体在轨"
                        else -> "需要干预"
                    },
                    fontWeight = FontWeight.Bold,
                    color = if (score >= 60) FiveGreen else FiveRed
                )
            }
            Text(
                "SI 只读快照评估 · 改目标须老板确认",
                color = Sub,
                style = MaterialTheme.typography.bodySmall
            )
        }

        val items = view?.items.orEmpty()
        items.forEach { g ->
            GoalCard(
                goal = g,
                canWrite = canWrite,
                onEdit = { editing = g },
                onOpen = onOpen,
                onMission = {
                    scope.launch {
                        try {
                            AppModule.ensureSession()
                            AppModule.siRepository.missionFromGoal(g.id)
                            Toast.makeText(context, "已立战役 · ${g.label}", Toast.LENGTH_SHORT).show()
                            onOpen(com.pandawufu.app.ui.Routes.M_SI_MISSIONS)
                        } catch (e: Exception) {
                            Toast.makeText(context, e.message ?: "立战役失败", Toast.LENGTH_SHORT).show()
                        }
                    }
                }
            )
        }

        if (editing != null) {
            EditGoalDialog(
                goal = editing!!,
                onDismiss = { editing = null },
                onSave = { target ->
                    val g = editing!!
                    editing = null
                    scope.launch {
                        try {
                            AppModule.ensureSession()
                            view = AppModule.siRepository.upsertGoal(
                                GoalUpsertRequest(id = g.id, target = target)
                            )
                            Toast.makeText(context, "目标已更新", Toast.LENGTH_SHORT).show()
                        } catch (e: Exception) {
                            Toast.makeText(context, e.message ?: "更新失败", Toast.LENGTH_SHORT).show()
                        }
                    }
                }
            )
        }

        Text(
            "说明：目标评估全部来自店内快照（营收/成本/损耗），确定性计算，不由大模型算账。",
            style = MaterialTheme.typography.bodySmall,
            color = Sub
        )
    }
}

@Composable
private fun GoalCard(
    goal: GoalItemDto,
    canWrite: Boolean,
    onEdit: () -> Unit,
    onOpen: (String) -> Unit,
    onMission: () -> Unit
) {
    val color = when (goal.status) {
        "on_track" -> FiveGreen
        "at_risk" -> Color(0xFFE4871A)
        "off_track" -> FiveRed
        else -> Sub
    }
    val label = when (goal.status) {
        "on_track" -> "达标"
        "at_risk" -> "接近"
        "off_track" -> "未达"
        else -> "数据不足"
    }
    ModuleCard(goal.label) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(
                goal.current?.let { fmt(it) + goal.unit } ?: "—",
                fontWeight = FontWeight.ExtraBold,
                color = Txt
            )
            Text("$label · 目标 ${fmt(goal.target)}${goal.unit}", color = color, fontWeight = FontWeight.Bold)
        }
        Text(goal.advice, color = Sub, style = MaterialTheme.typography.bodySmall)
        Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            goal.route?.takeIf { it.isNotBlank() }?.let { r ->
                OutlinedButton(
                    onClick = { onOpen(r) },
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.weight(1f)
                ) { Text("去处理") }
            }
            if (canWrite) {
                OutlinedButton(
                    onClick = onEdit,
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.weight(1f)
                ) { Text("改目标") }
                OutlinedButton(
                    onClick = onMission,
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.weight(1f)
                ) { Text("立战役") }
            }
        }
    }
}

@Composable
private fun EditGoalDialog(
    goal: GoalItemDto,
    onDismiss: () -> Unit,
    onSave: (Double) -> Unit
) {
    var text by remember { mutableStateOf(fmt(goal.target)) }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("改目标 · ${goal.label}") },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                label = { Text("目标值（${goal.unit}）") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
        },
        confirmButton = {
            Button(onClick = { text.toDoubleOrNull()?.let(onSave) }) { Text("保存") }
        },
        dismissButton = {
            OutlinedButton(onClick = onDismiss) { Text("取消") }
        }
    )
}

private fun fmt(v: Double): String {
    val r = Math.round(v * 10) / 10.0
    return if (r == r.toLong().toDouble()) r.toLong().toString() else r.toString()
}
