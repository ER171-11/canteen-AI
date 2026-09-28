package com.pandawufu.app.features.si

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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
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
import com.pandawufu.shared.model.KnowledgeAddRequest
import com.pandawufu.shared.model.KnowledgeResponse
import com.pandawufu.shared.model.SpecialistDto
import com.pandawufu.shared.model.TeamReviewDto
import kotlinx.coroutines.launch

/**
 * SI 专家团 + 知识库：六域专家值守巡检 + SI 沉淀的经营打法（数据挖掘 + 人工沉淀）。
 */
@Composable
fun TeamScreen(onOpen: (String) -> Unit = {}) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val canWrite = AppModule.canWrite()
    var team by remember { mutableStateOf<TeamReviewDto?>(null) }
    var kb by remember { mutableStateOf<KnowledgeResponse?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var showAdd by remember { mutableStateOf(false) }
    var kbTitle by remember { mutableStateOf("") }
    var kbInsight by remember { mutableStateOf("") }

    suspend fun reload() {
        loading = true
        error = null
        try {
            AppModule.ensureSession()
            team = AppModule.siRepository.team()
            kb = AppModule.siRepository.knowledge()
        } catch (e: Exception) {
            val fail = com.pandawufu.shared.util.LoadFailure.from(e)
            error = fail.error ?: fail.hint ?: "加载失败"
        } finally {
            loading = false
        }
    }

    LaunchedEffect(Unit) { reload() }

    ModuleScaffold(
        title = "SI 专家团",
        subtitle = "六域值守 · 知识沉淀 · 统筹门店系统",
        loading = loading && team == null,
        error = error,
        onRetry = { scope.launch { reload() } }
    ) {
        team?.let { t ->
            PandaCard {
                Text("总协调", fontWeight = FontWeight.Bold, color = Ink)
                Text(t.summary, color = Txt, fontWeight = FontWeight.SemiBold)
                Text(
                    "告警 ${t.counts.off} · 提醒 ${t.counts.risk} · 正常 ${t.counts.on}",
                    color = Sub, style = MaterialTheme.typography.bodySmall
                )
            }
            t.specialists.forEach { s -> SpecialistCard(s, onOpen) }
        }

        ModuleCard("SI 沉淀的打法（知识创造）") {
            val derived = kb?.derived.orEmpty()
            derived.forEach { p ->
                Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                    Text(p.title, fontWeight = FontWeight.Bold, color = Txt)
                    Text(p.insight, color = Sub, style = MaterialTheme.typography.bodySmall)
                    p.recommend?.let { Text("建议：$it", color = Ink, style = MaterialTheme.typography.bodySmall) }
                    p.route?.takeIf { it.isNotBlank() }?.let { r ->
                        OutlinedButton(
                            onClick = { onOpen(r) },
                            shape = RoundedCornerShape(8.dp),
                            modifier = Modifier.padding(top = 4.dp)
                        ) { Text("去办") }
                    }
                }
            }
            if (derived.isEmpty()) Text("暂无数据型打法（需销售/报损/配方样本）", color = Sub)
        }

        ModuleCard("人工沉淀（跨战役可迁移）") {
            val custom = kb?.custom.orEmpty()
            custom.forEach { p ->
                Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                    Text(p.title, fontWeight = FontWeight.Bold, color = Txt)
                    Text(p.insight, color = Sub, style = MaterialTheme.typography.bodySmall)
                    if (p.tags.isNotEmpty()) {
                        Text(p.tags.joinToString(" · "), color = Sub, style = MaterialTheme.typography.bodySmall)
                    }
                    if (canWrite) {
                        OutlinedButton(
                            onClick = {
                                busy = true
                                scope.launch {
                                    try {
                                        AppModule.ensureSession()
                                        AppModule.siRepository.deleteKnowledge(p.id)
                                        reload()
                                    } catch (e: Exception) {
                                        Toast.makeText(context, e.message ?: "失败", Toast.LENGTH_SHORT).show()
                                    } finally { busy = false }
                                }
                            },
                            enabled = !busy,
                            shape = RoundedCornerShape(8.dp),
                            modifier = Modifier.padding(top = 4.dp)
                        ) { Text("删除") }
                    }
                }
            }
            if (custom.isEmpty()) Text("还没有人工打法 · 把你的经验交给 SI", color = Sub)

            if (canWrite) {
                if (!showAdd) {
                    Button(
                        onClick = { showAdd = true },
                        enabled = !busy,
                        shape = RoundedCornerShape(10.dp),
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp)
                    ) { Text("沉淀一条打法") }
                } else {
                    OutlinedTextField(
                        value = kbTitle, onValueChange = { kbTitle = it },
                        label = { Text("打法标题，如「周六晚高峰加排1人」") },
                        singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)
                    )
                    OutlinedTextField(
                        value = kbInsight, onValueChange = { kbInsight = it },
                        label = { Text("洞察/依据") },
                        modifier = Modifier.fillMaxWidth().padding(top = 6.dp)
                    )
                    Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            onClick = {
                                busy = true
                                scope.launch {
                                    try {
                                        AppModule.ensureSession()
                                        AppModule.siRepository.addKnowledge(
                                            KnowledgeAddRequest(title = kbTitle, insight = kbInsight)
                                        )
                                        kbTitle = ""; kbInsight = ""; showAdd = false
                                        reload()
                                    } catch (e: Exception) {
                                        Toast.makeText(context, e.message ?: "失败", Toast.LENGTH_SHORT).show()
                                    } finally { busy = false }
                                }
                            },
                            enabled = !busy && kbTitle.isNotBlank(),
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.weight(1f)
                        ) { Text("保存") }
                        OutlinedButton(
                            onClick = { showAdd = false },
                            enabled = !busy,
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.weight(1f)
                        ) { Text("取消") }
                    }
                }
            }
        }

        Text(
            "专家团全部只读巡检；建议落地走确认台或战役。知识由 SI 从数据中创造，也可人工沉淀后跨战役迁移。",
            style = MaterialTheme.typography.bodySmall, color = Sub
        )
    }
}

@Composable
private fun SpecialistCard(s: SpecialistDto, onOpen: (String) -> Unit) {
    val color = when (s.status) {
        "off_track" -> FiveRed
        "at_risk" -> Color(0xFFE4871A)
        else -> FiveGreen
    }
    ModuleCard("${s.icon} ${s.name} · ${s.domain}") {
        s.findings.forEach {
            Text("· $it", color = Txt, style = MaterialTheme.typography.bodySmall)
        }
        s.recommends.forEach { rec ->
            Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(rec.text, color = color, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                rec.route?.takeIf { it.isNotBlank() }?.let { r ->
                    OutlinedButton(onClick = { onOpen(r) }, shape = RoundedCornerShape(8.dp)) { Text("去办") }
                }
            }
        }
    }
}
