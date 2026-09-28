package com.pandawufu.app.features.modules

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.AppModule
import com.pandawufu.app.ui.designsystem.PageBg
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.model.StaffInsightDto
import com.pandawufu.shared.model.StaffShiftDto
import com.pandawufu.shared.viewmodel.ModulesViewModel
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.LocalDate
import java.time.format.DateTimeFormatter

/** 对应原型 p-m-staff：排班 / 打卡 / 人效 / 培训 */
@Composable
fun StaffScreen() {
    val viewModel = remember { ModulesViewModel(AppModule.modulesRepository) }
    val state by viewModel.state.collectAsState()
    var tab by remember { mutableIntStateOf(0) }
    val pills = listOf("排班", "打卡", "人效", "培训")

    LaunchedEffect(Unit) {
        AppModule.ensureSession()
        viewModel.dispatch(ModulesViewModel.Intent.LoadStaff)
    }

    val staff = state.staff
    ModuleScaffold(
        title = "排班员工",
        subtitle = "班表 · 打卡 · 人效 · 培训记录",
        loading = state.loading && staff == null,
        error = state.error,
        hint = state.emptyHint,
        onRetry = { viewModel.dispatch(ModulesViewModel.Intent.LoadStaff) },
        empty = staff != null && staff.shifts.isEmpty() && staff.clock.isEmpty() &&
            staff.perf.isEmpty() && staff.train.isEmpty(),
        emptyText = "暂无排班数据，可先补录出勤或登记换班",
        pills = pills,
        selectedPill = tab,
        onPill = { tab = it }
    ) {
        StaffInsightCard(staff?.insight)
        DraftWriteButton(
            label = "补打卡（上班）",
            type = "staff.clock",
            fields = mapOf(
                "账号" to (AppModule.account ?: "boss"),
                "类型" to "上班",
                "状态" to "补录"
            ),
            summaryOf = { d -> "补录 ${d["账号"]} ${d["类型"]}" },
            buildPayload = { d ->
                buildJsonObject {
                    put("staff_id", d["账号"] ?: (AppModule.account ?: "boss"))
                    put("kind", d["类型"] ?: "上班")
                    put("status", d["状态"] ?: "补录")
                }
            },
            onSuccess = { viewModel.dispatch(ModulesViewModel.Intent.LoadStaff) },
            baseRev = staff?.rev?.toString()
        )
        when (tab) {
            0 -> {
                DraftWriteButton(
                    label = "登记换班",
                    type = "staff.shift_upsert",
                    fields = mapOf(
                        "员工" to (AppModule.displayName ?: AppModule.account ?: "老板"),
                        "班次" to "早班",
                        "岗位" to (AppModule.role ?: "店长")
                    ),
                    summaryOf = { d -> "${d["员工"]} · ${d["班次"]} · ${d["岗位"]}" },
                    buildPayload = { d ->
                        buildJsonObject {
                            put("staff_id", AppModule.account ?: "boss")
                            put("staff_name", d["员工"] ?: "老板")
                            put("shift", d["班次"] ?: "早班")
                            put("role", d["岗位"] ?: "店长")
                        }
                    },
                    onSuccess = { viewModel.dispatch(ModulesViewModel.Intent.LoadStaff) }
                )
                ModuleCard("周排班表") {
                    WeekShiftGrid(
                        staff?.shifts.orEmpty(),
                        blocked = staff?.insight?.certs?.blockedScheduled?.toSet().orEmpty()
                    )
                }
                ModuleCard("本周排班明细（${staff?.shifts?.size ?: 0}）") {
                    val list = staff?.shifts.orEmpty()
                    if (list.isEmpty()) Text("暂无排班", color = Sub, fontSize = 12.sp)
                    list.take(20).forEach { s ->
                        KvRow(
                            "${s.date ?: "-"} ${s.staffName ?: s.staffId ?: "-"}",
                            listOfNotNull(s.shift, s.role).joinToString(" · ")
                        )
                    }
                }
            }
            1 -> {
                ModuleCard("打卡明细（${staff?.clock?.size ?: 0}）") {
                    val list = staff?.clock.orEmpty()
                    if (list.isEmpty()) Text("暂无打卡", color = Sub, fontSize = 12.sp)
                    list.take(15).forEach { c ->
                        KvRow("${c.ts ?: "-"}", "${c.kind ?: ""} ${c.status ?: ""}".trim())
                    }
                }
            }
            2 -> ModuleCard("人效 TOP（${staff?.perf?.size ?: 0}）") {
                val list = staff?.perf.orEmpty()
                if (list.isEmpty()) Text("暂无人效", color = Sub, fontSize = 12.sp)
                list.take(12).forEach { p ->
                    KvRow(
                        p.staffName ?: p.staffId ?: "-",
                        listOfNotNull(p.metric, p.value?.toString(), p.hours?.let { "${it}h" })
                            .joinToString(" · ")
                    )
                }
            }
            else -> ModuleCard("培训（${staff?.train?.size ?: 0}）") {
                val list = staff?.train.orEmpty()
                if (list.isEmpty()) Text("暂无培训记录", color = Sub, fontSize = 12.sp)
                list.take(12).forEach { t ->
                    KvRow(t.displayTitle, listOfNotNull(t.staffName, t.status, t.date).joinToString(" · "))
                }
            }
        }
    }
}

@Composable
private fun WeekShiftGrid(shifts: List<StaffShiftDto>, blocked: Set<String> = emptySet()) {
    val today = LocalDate.now()
    val monday = today.minusDays(((today.dayOfWeek.value + 6) % 7).toLong())
    val days = (0..6).map { monday.plusDays(it.toLong()) }
    val fmt = DateTimeFormatter.ISO_LOCAL_DATE
    val people = shifts.mapNotNull { it.staffName ?: it.staffId }.distinct().ifEmpty {
        listOf(AppModule.displayName ?: AppModule.account ?: "老板")
    }
    val byKey = shifts.groupBy { (it.staffName ?: it.staffId ?: "") to (it.date ?: "") }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("", modifier = Modifier.weight(1.2f), fontSize = 10.sp)
            listOf("一", "二", "三", "四", "五", "六", "日").forEach {
                Text(it, modifier = Modifier.weight(1f), fontSize = 10.sp, color = Sub, textAlign = TextAlign.Center)
            }
        }
        people.take(8).forEach { name ->
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(2.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(name.take(4), modifier = Modifier.weight(1.2f), fontSize = 10.sp, fontWeight = FontWeight.Bold, maxLines = 1)
                days.forEach { d ->
                    val cell = byKey[name to fmt.format(d)]?.firstOrNull()
                    val isRest = cell?.shift?.contains("休") == true || cell?.shift?.contains("假") == true
                    val banned = name in blocked && !isRest
                    val label = if (banned) "禁" else shiftShort(cell?.shift)
                    val bg = if (banned) Color(0xFFFCE4E1) else shiftColor(cell?.shift)
                    Box(
                        Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(4.dp))
                            .background(bg)
                            .padding(vertical = 6.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            label,
                            fontSize = 10.sp,
                            fontWeight = FontWeight.Bold,
                            color = if (banned) FiveRed else Color(0xFF333333)
                        )
                    }
                }
            }
        }
        Text("A 早 / B 中 / C 晚 / 休 · 禁=健康证禁岗", fontSize = 10.sp, color = Sub)
    }
}

private fun shiftShort(s: String?): String {
    val t = s.orEmpty()
    return when {
        t.isBlank() -> "—"
        t.contains("休") || t.contains("假") -> "休"
        t.contains("早") || t.equals("A", true) -> "A"
        t.contains("中") || t.equals("B", true) -> "B"
        t.contains("晚") || t.equals("C", true) -> "C"
        else -> t.take(1)
    }
}

private fun shiftColor(s: String?): Color {
    val t = s.orEmpty()
    return when {
        t.contains("休") || t.contains("假") -> PageBg
        t.contains("早") || t.equals("A", true) -> Color(0xFFFCE4E1)
        t.contains("中") || t.equals("B", true) -> Color(0xFFE3EDF7)
        t.contains("晚") || t.equals("C", true) -> Color(0xFFE2F0E2)
        t.isBlank() -> PageBg
        else -> Color(0xFFFCEDD0)
    }
}

/** SI 排班洞察卡：班表 + 打卡异常 + 健康证禁岗 + 峰谷加排 */
@Composable
private fun StaffInsightCard(ins: StaffInsightDto?) {
    if (ins == null) return
    ModuleCard("SI · 排班与合规") {
        ins.today?.let { t ->
            KvRow("今日班表", "${t.date} · ${t.shifts} 人 · ${t.staff} 员工在岗")
            if (t.byShift.isNotEmpty()) {
                KvRow("班次", t.byShift.entries.joinToString(" · ") { "${it.key} ${it.value}" })
            }
        }
        ins.clock?.let { c ->
            KvRow("打卡", "应到 ${c.expected} · 实到 ${c.clocked} · 迟到 ${c.late} · 补录 ${c.makeup}")
            if (c.absent.isNotEmpty()) {
                Text("缺勤：${c.absent.joinToString("、")}", color = FiveRed, fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
            }
        }
        ins.certs?.let { c ->
            if (c.blockedScheduled.isNotEmpty()) {
                Text(
                    "禁岗：${c.blockedScheduled.joinToString("、")}（健康证<7天，禁止排班）",
                    color = FiveRed, fontWeight = FontWeight.Bold, fontSize = 12.sp
                )
            }
            if (c.expiring.isNotEmpty()) {
                KvRow("证照临期", c.expiring.joinToString(" · ") { "${it.holder} ${it.days}天" })
            }
            if (c.blockedScheduled.isEmpty() && c.expiring.isEmpty()) KvRow("健康证", "无临期/禁岗")
        }
        ins.training?.let { tr ->
            KvRow("培训", "共 ${tr.total} · 未过 ${tr.pending}")
        }
        ins.peak?.let { p ->
            Text(
                "峰谷：${p.text}" + if (p.suggestAdd) " · 建议加排 1 人" else "",
                color = if (p.suggestAdd) FiveRed else Ink,
                fontWeight = FontWeight.SemiBold, fontSize = 12.sp
            )
        }
        ins.advice.forEach {
            Text("· $it", color = if (it.contains("禁岗") || it.contains("缺勤")) FiveRed else Sub, fontSize = 12.sp)
        }
    }
}
