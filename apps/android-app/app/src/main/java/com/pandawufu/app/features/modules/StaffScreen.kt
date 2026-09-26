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
import com.pandawufu.app.ui.designsystem.Sub
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
                    WeekShiftGrid(staff?.shifts.orEmpty())
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
private fun WeekShiftGrid(shifts: List<StaffShiftDto>) {
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
                    val label = shiftShort(cell?.shift)
                    val bg = shiftColor(cell?.shift)
                    Box(
                        Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(4.dp))
                            .background(bg)
                            .padding(vertical = 6.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(label, fontSize = 10.sp, fontWeight = FontWeight.Bold, color = Color(0xFF333333))
                    }
                }
            }
        }
        Text("A 早 / B 中 / C 晚 / 休", fontSize = 10.sp, color = Sub)
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
