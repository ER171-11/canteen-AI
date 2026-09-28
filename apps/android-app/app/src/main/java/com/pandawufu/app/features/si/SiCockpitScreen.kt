package com.pandawufu.app.features.si

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.AppModule
import com.pandawufu.app.features.modules.ModuleCard
import com.pandawufu.app.features.modules.ModuleScaffold
import com.pandawufu.app.ui.Routes
import com.pandawufu.app.ui.designsystem.AiPink
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.model.CockpitDto
import kotlinx.coroutines.launch

/**
 * 老板全局 SI 驾驶舱：一屏看全店态势（KPI + 六域 + 下一步 + 目标 + 在办）。
 */
@Composable
fun SiCockpitScreen(onOpen: (String) -> Unit = {}) {
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<CockpitDto?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    suspend fun load() {
        loading = true
        error = null
        try {
            AppModule.ensureSession()
            data = AppModule.siRepository.cockpit()
        } catch (e: Exception) {
            val fail = com.pandawufu.shared.util.LoadFailure.from(e)
            error = fail.error ?: fail.hint ?: "加载失败"
        } finally {
            loading = false
        }
    }

    LaunchedEffect(Unit) { load() }

    ModuleScaffold(
        title = "全局驾驶舱",
        subtitle = "一屏看全店 · SI 只读汇总",
        loading = loading && data == null,
        error = error,
        onRetry = { scope.launch { load() } },
        siSpecialist = ""
    ) {
        val c = data ?: return@ModuleScaffold

        // hero：今日营收 + 保本达成
        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(18.dp))
                .background(Ink)
                .padding(16.dp)
        ) {
            Text(c.headline.ifBlank { "正在读取门店数据…" }, color = Color.White, fontSize = 13.sp, lineHeight = 19.sp)
            Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                HeroStat("今日营收", "¥${(c.kpis?.revenueToday ?: 0.0).toInt()}")
                HeroStat("保本", "¥${(c.kpis?.breakevenDay ?: 0.0).toInt()}")
                HeroStat("达成", c.kpis?.attainPct?.let { "${it}%" } ?: "—")
            }
        }

        // 写队列健康
        c.queue?.let { q ->
            if (q.stalled) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(FiveRed.copy(alpha = 0.10f))
                        .padding(12.dp)
                ) {
                    Text("⚠ 写队列可能卡死", color = FiveRed, fontWeight = FontWeight.Bold, fontSize = 12.5.sp)
                    Text(
                        "${q.pendingExecute} 条已确认但超 ${q.oldestExecuteMin} 分钟未落库 · 检查店内执行器（token/进程）",
                        color = FiveRed, fontSize = 11.sp
                    )
                }
            }
        }
        c.advice.forEach { Text("· $it", color = FiveRed, fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold) }

        // KPI tiles
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            KpiTile("毛利率", c.kpis?.grossMarginPct?.let { "$it%" } ?: "—", Modifier.weight(1f))
            KpiTile("损耗率", c.kpis?.lossRatePct?.let { "$it%" } ?: "—", Modifier.weight(1f))
            KpiTile("客单价", c.kpis?.avgTicket?.let { "¥${it.toInt()}" } ?: "—", Modifier.weight(1f))
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            KpiTile("日均营收", c.kpis?.dailyAvgRevenue?.let { "¥${it.toInt()}" } ?: "—", Modifier.weight(1f))
            KpiTile("目标达成", "${c.goalScore}%", Modifier.weight(1f))
            KpiTile("待拍板", "${c.inbox?.decide ?: 0}", Modifier.weight(1f))
        }

        if (c.trend.size >= 2) {
            ModuleCard("近 ${c.trend.size} 日营收趋势") {
                val revs = c.trend.map { it.revenue.toFloat() }
                com.pandawufu.app.ui.designsystem.DualSparkline(revs)
                Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(c.trend.first().date.takeLast(5), color = Sub, fontSize = 10.sp)
                    Text("峰值 ¥${c.trend.maxOf { it.revenue }.toInt()} · 日均 ¥${(c.trend.sumOf { it.revenue } / c.trend.size).toInt()}", color = Sub, fontSize = 10.sp)
                    Text(c.trend.last().date.takeLast(5), color = Sub, fontSize = 10.sp)
                }
            }
        }

        // 下一步
        val nx = c.next
        if (nx != null) {
            val col = statusColor(nx.status)
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .background(col.copy(alpha = 0.10f))
                    .clickable { nx.route?.takeIf { it.isNotBlank() }?.let(onOpen) }
                    .padding(14.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(Modifier.weight(1f)) {
                    Text("下一步 · ${nx.label}", fontWeight = FontWeight.Bold, color = Ink, fontSize = 13.sp)
                    Text(nx.text, color = Sub, fontSize = 11.5.sp)
                }
                if (nx.count > 0) Text("${nx.count}", color = col, fontWeight = FontWeight.ExtraBold, fontSize = 16.sp)
            }
        }

        // 六域专家
        c.team?.let { t ->
            ModuleCard("六域值守 · ${t.summary}") {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    t.specialists.take(7).forEach { s ->
                        Column(
                            Modifier.weight(1f),
                            horizontalAlignment = Alignment.CenterHorizontally
                        ) {
                            Box(
                                Modifier
                                    .size(30.dp)
                                    .clip(CircleShape)
                                    .background(statusColor(s.status).copy(alpha = 0.16f)),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(s.icon, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = statusColor(s.status))
                            }
                            Text(s.name.take(3), fontSize = 9.sp, color = Sub)
                        }
                    }
                }
            }
        }

        // 目标偏离
        if (c.goalsAlert.isNotEmpty()) {
            ModuleCard("目标偏离") {
                c.goalsAlert.forEach { g ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(g.label, color = Ink, fontWeight = FontWeight.SemiBold)
                        Text(
                            (g.current?.let { "$it" } ?: "—") + g.unit + " / 目标 " + (g.target?.toString() ?: "-") + g.unit,
                            color = if (g.status == "off_track") FiveRed else Color(0xFFE4871A),
                            fontWeight = FontWeight.Bold
                        )
                    }
                    Text(g.advice, color = Sub, fontSize = 11.sp)
                }
                Text(
                    "去目标面板 ›",
                    color = AiPink, fontWeight = FontWeight.Bold, fontSize = 12.sp,
                    modifier = Modifier.padding(top = 6.dp).clickable { onOpen(Routes.M_SI_GOALS) }
                )
            }
        }

        // 在办战役
        if (c.missions.isNotEmpty()) {
            ModuleCard("SI 在办战役") {
                c.missions.forEach { m ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(m.title, color = Ink, fontWeight = FontWeight.SemiBold)
                        Text("${m.progress}%", color = FiveGreen, fontWeight = FontWeight.Bold)
                    }
                }
                Text(
                    "全部战役 ›",
                    color = AiPink, fontWeight = FontWeight.Bold, fontSize = 12.sp,
                    modifier = Modifier.padding(top = 6.dp).clickable { onOpen(Routes.M_SI_MISSIONS) }
                )
            }
        }

        Text("SI 只读汇总 · 写操作仍走确认台", color = Sub, fontSize = 10.sp)
    }
}

@Composable
private fun HeroStat(label: String, value: String) {
    Column {
        Text(label, color = Color.White.copy(alpha = 0.72f), fontSize = 10.sp)
        Text(value, color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.ExtraBold)
    }
}

@Composable
private fun KpiTile(label: String, value: String, modifier: Modifier = Modifier) {
    Column(
        modifier
            .clip(RoundedCornerShape(12.dp))
            .background(Color.White)
            .padding(10.dp)
    ) {
        Text(label, color = Sub, fontSize = 10.sp)
        Text(value, color = Ink, fontSize = 16.sp, fontWeight = FontWeight.ExtraBold)
    }
}

private fun statusColor(status: String): Color = when (status) {
    "alert", "off_track" -> FiveRed
    "warn", "at_risk" -> Color(0xFFE4871A)
    "info" -> AiPink
    else -> FiveGreen
}
