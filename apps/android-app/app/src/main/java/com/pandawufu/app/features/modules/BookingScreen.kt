package com.pandawufu.app.features.modules

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import com.pandawufu.app.AppModule
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.model.BookingInsightDto
import com.pandawufu.shared.viewmodel.ModulesViewModel
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** 对应原型 p-m-booking：今日预订 / 排队叫号 / 候餐服务 / 翻台预估 */
@Composable
fun BookingScreen() {
    val viewModel = remember { ModulesViewModel(AppModule.modulesRepository) }
    val state by viewModel.state.collectAsState()
    var tab by remember { mutableIntStateOf(ModuleEntry.consumePill(0)) }
    val pills = listOf("今日预订", "排队叫号", "候餐服务", "翻台预估")
    val today = remember {
        SimpleDateFormat("yyyy-MM-dd", Locale.CHINA).format(Date())
    }

    LaunchedEffect(Unit) {
        AppModule.ensureSession()
        viewModel.dispatch(ModulesViewModel.Intent.LoadBooking())
    }

    val booking = state.booking
    val dining = booking?.bookings.orEmpty().count {
        val s = it.status.orEmpty()
        s.contains("就餐") || s.contains("已到") || s.contains("用餐")
    }
    val pending = booking?.bookings.orEmpty().count {
        val s = it.status.orEmpty()
        s.contains("待") || s.contains("确认") || s.isBlank()
    }
    val queueN = booking?.queue.orEmpty().size
    val waitingQueue = booking?.queue.orEmpty().filter {
        val s = it.status.orEmpty()
        !s.contains("就餐") && !s.contains("完成") && !s.contains("取消") && !s.contains("入座")
    }
    val turnMin = (10 + dining * 2 + queueN).coerceIn(6, 28)
    val waitEta = (8 + waitingQueue.size * 3).coerceIn(5, 45)
    val ins = booking?.insight

    fun reload() = viewModel.dispatch(ModulesViewModel.Intent.LoadBooking())

    ModuleScaffold(
        title = "预订排队",
        subtitle = when (tab) {
            0 -> "今日预订 ${ins?.summary?.bookings ?: booking?.bookings?.size ?: 0} 桌 · ${ins?.summary?.guests ?: 0} 人"
            1 -> "排队等位 ${ins?.queue?.waiting ?: waitingQueue.size} 组 · 叫号"
            2 -> "候餐 · 等位 ${ins?.queue?.waiting ?: waitingQueue.size} 组 / ${ins?.queue?.waitingGuests ?: 0} 人"
            else -> ins?.tables?.occupancyPct?.let { "翻台预估 · 占用 $it%" } ?: "翻台预估"
        },
        loading = state.loading && booking == null,
        error = state.error,
        hint = state.emptyHint,
        onRetry = { reload() },
        pills = pills,
        selectedPill = tab,
        onPill = { tab = it }
    ) {
        BookingInsightCard(ins)
        when (tab) {
            0 -> {
                DraftWriteButton(
                    label = "新建预订",
                    type = "booking.upsert",
                    fields = mapOf(
                        "客人" to "散客",
                        "电话" to "",
                        "日期" to today,
                        "时段" to "18:00",
                        "人数" to "2",
                        "桌台" to "",
                        "状态" to "待确认",
                        "备注" to ""
                    ),
                    summaryOf = { d ->
                        "预订 ${d["客人"]} · ${d["日期"]} ${d["时段"]} · ${d["人数"]}人"
                    },
                    buildPayload = { d ->
                        buildJsonObject {
                            put("guest_name", d["客人"] ?: "散客")
                            put("phone", d["电话"] ?: "")
                            put("date", d["日期"] ?: today)
                            put("time", d["时段"] ?: "")
                            put("party_size", d["人数"]?.toIntOrNull() ?: 2)
                            val tid = d["桌台"].orEmpty().trim()
                            if (tid.isNotBlank()) put("table_id", tid)
                            put("status", d["状态"] ?: "待确认")
                            put("note", d["备注"] ?: "")
                        }
                    },
                    baseRev = booking?.rev?.toString(),
                    onSuccess = { reload() }
                )
                ModuleCard("预订（${booking?.bookings?.size ?: 0}）") {
                    val list = booking?.bookings.orEmpty()
                    if (list.isEmpty()) Text("今日暂无预订", color = Sub, fontSize = 12.sp)
                    list.take(20).forEach { b ->
                        KvRow(
                            "${b.time ?: "-"} ${b.guestName ?: "-"} · ${b.partySize ?: "-"}人",
                            listOfNotNull(b.date, b.tableId, b.status).joinToString(" · ")
                        )
                        val bid = b.id
                        val st = b.status.orEmpty()
                        if (bid != null && AppModule.canWrite()) {
                            val arrived = st.contains("已到") || st.contains("就餐")
                            val cancelled = st.contains("取消")
                            if (!arrived && !cancelled) {
                                WriteActionButton(
                                    label = "确认到店",
                                    type = "booking.upsert",
                                    summary = "预订#${bid} ${b.guestName ?: ""} → 已到店",
                                    payload = buildJsonObject {
                                        put("id", bid)
                                        put("status", "已到店")
                                        put("note", "App 确认到店")
                                    },
                                    baseRev = booking?.rev?.toString(),
                                    onSuccess = { reload() }
                                )
                            }
                            if (st.contains("已到") && !st.contains("就餐")) {
                                WriteActionButton(
                                    label = "开台就餐",
                                    type = "booking.upsert",
                                    summary = "预订#${bid} → 就餐中",
                                    payload = buildJsonObject {
                                        put("id", bid)
                                        put("status", "就餐中")
                                    },
                                    baseRev = booking?.rev?.toString(),
                                    onSuccess = { reload() }
                                )
                                val table = b.tableId
                                if (!table.isNullOrBlank()) {
                                    WriteActionButton(
                                        label = "桌 $table 置就餐",
                                        type = "pos.table_state",
                                        summary = "桌 $table → 就餐（预订联动）",
                                        payload = buildJsonObject {
                                            put("table_id", table)
                                            put("state", "busy")
                                            put("no", table)
                                        },
                                        baseRev = booking?.rev?.toString(),
                                        onSuccess = { reload() }
                                    )
                                }
                            }
                        }
                    }
                }
            }
            1 -> {
                DraftWriteButton(
                    label = "现场取号",
                    type = "queue.join",
                    fields = mapOf(
                        "人数" to "2",
                        "状态" to "排队中"
                    ),
                    summaryOf = { d -> "取号 · ${d["人数"]}人 · ${d["状态"]}" },
                    buildPayload = { d ->
                        buildJsonObject {
                            put("party_size", d["人数"]?.toIntOrNull() ?: 2)
                            put("status", d["状态"] ?: "排队中")
                            put("date", today)
                        }
                    },
                    baseRev = booking?.rev?.toString(),
                    onSuccess = { reload() }
                )
                ModuleCard("排队（${queueN}）") {
                    val list = booking?.queue.orEmpty()
                    if (list.isEmpty()) Text("当前无人排队 · 可点「现场取号」", color = Sub, fontSize = 12.sp)
                    list.take(20).forEach { q ->
                        KvRow("号 ${q.queueNo ?: q.id ?: "-"} · ${q.partySize ?: "-"}人", q.status ?: "-")
                        val qid = q.id ?: q.queueNo
                        val st = q.status.orEmpty()
                        if (qid != null && AppModule.canWrite() &&
                            !st.contains("就餐") && !st.contains("完成") && !st.contains("取消")
                        ) {
                            WriteActionButton(
                                label = "叫号 ${q.queueNo ?: qid}",
                                type = "queue.call",
                                summary = "排队号 ${q.queueNo ?: qid} → 叫号",
                                payload = buildJsonObject {
                                    put("id", qid.toString())
                                    put("queue_no", (q.queueNo ?: qid).toString())
                                    put("status", "叫号")
                                },
                                baseRev = booking?.rev?.toString(),
                                onSuccess = { reload() }
                            )
                            WriteActionButton(
                                label = "入座就餐",
                                type = "queue.call",
                                summary = "排队号 ${q.queueNo ?: qid} → 就餐",
                                payload = buildJsonObject {
                                    put("id", qid.toString())
                                    put("queue_no", (q.queueNo ?: qid).toString())
                                    put("status", "就餐")
                                },
                                baseRev = booking?.rev?.toString(),
                                onSuccess = { reload() }
                            )
                        }
                    }
                }
            }
            2 -> {
                ModuleCard("候餐看板") {
                    KvRow("等位组数", "${waitingQueue.size}")
                    KvRow("预估等待", "~$waitEta 分钟")
                    KvRow("建议话术", if (waitEta <= 12) "很快就有桌，请稍候" else "高峰稍等，已安排茶水")
                    Text(
                        if (waitingQueue.size >= 4) "流失风险偏高 · 加快清台与叫号"
                        else "盘面可控 · 保持安抚节奏",
                        color = FiveGreen,
                        fontSize = 12.sp
                    )
                }
                ModuleCard("一键候餐") {
                    Text("点一下直入确认台 · 登记今日服务台账", color = Sub, fontSize = 12.sp)
                    if (AppModule.canWrite()) {
                        WriteActionButton(
                            label = "发茶水 ×${waitingQueue.size.coerceAtLeast(1)}",
                            type = "queue.serve",
                            summary = "候餐服务 · 茶水 ×${waitingQueue.size.coerceAtLeast(1)} · 估时~${waitEta}分",
                            payload = buildJsonObject {
                                put("action", "茶水")
                                put("qty", waitingQueue.size.coerceAtLeast(1))
                                put("note", "候餐发茶")
                                put("date", today)
                                put("wait_eta_min", waitEta)
                                put("queue_count", waitingQueue.size)
                            },
                            baseRev = booking?.rev?.toString(),
                            onSuccess = { reload() }
                        )
                        WriteActionButton(
                            label = "发拌花生 ×2",
                            type = "queue.serve",
                            summary = "候餐服务 · 小食 拌花生 ×2",
                            payload = buildJsonObject {
                                put("action", "小食")
                                put("item", "拌花生")
                                put("qty", 2)
                                put("note", "候餐安抚")
                                put("date", today)
                                put("wait_eta_min", waitEta)
                                put("queue_count", waitingQueue.size)
                            },
                            baseRev = booking?.rev?.toString(),
                            onSuccess = { reload() }
                        )
                        WriteActionButton(
                            label = "发湿纸巾",
                            type = "queue.serve",
                            summary = "候餐服务 · 湿纸巾 ×${waitingQueue.size.coerceAtLeast(1)}",
                            payload = buildJsonObject {
                                put("action", "湿纸巾")
                                put("qty", waitingQueue.size.coerceAtLeast(1))
                                put("note", "候餐关怀")
                                put("date", today)
                                put("wait_eta_min", waitEta)
                                put("queue_count", waitingQueue.size)
                            },
                            baseRev = booking?.rev?.toString(),
                            onSuccess = { reload() }
                        )
                    } else {
                        Text("只读账号不可登记", color = Sub, fontSize = 12.sp)
                    }
                }
                DraftWriteButton(
                    label = "自定义候餐登记",
                    type = "queue.serve",
                    fields = mapOf(
                        "动作" to "茶水",
                        "数量" to "${waitingQueue.size.coerceAtLeast(1)}",
                        "品名" to "",
                        "备注" to "候餐服务"
                    ),
                    summaryOf = { d ->
                        val item = d["品名"].orEmpty().trim()
                        if (item.isBlank()) "候餐服务 · ${d["动作"]} × ${d["数量"]}"
                        else "候餐服务 · ${d["动作"]} $item × ${d["数量"]}"
                    },
                    buildPayload = { d ->
                        buildJsonObject {
                            put("action", d["动作"] ?: "茶水")
                            val item = d["品名"].orEmpty().trim()
                            if (item.isNotBlank()) put("item", item)
                            put("qty", d["数量"]?.toIntOrNull() ?: 1)
                            put("note", d["备注"] ?: "")
                            put("date", today)
                            put("wait_eta_min", waitEta)
                            put("queue_count", waitingQueue.size)
                        }
                    },
                    baseRev = booking?.rev?.toString(),
                    onSuccess = { reload() }
                )
                ModuleCard("今日服务台账（${booking?.serves?.size ?: 0}）") {
                    val serves = booking?.serves.orEmpty().asReversed()
                    if (serves.isEmpty()) {
                        Text("尚无候餐登记 · 用上方一键或自定义写入", color = Sub, fontSize = 12.sp)
                    } else {
                        serves.take(20).forEach { s ->
                            val title = listOfNotNull(
                                s.action,
                                s.item,
                                s.qty?.let { "×${it.toInt()}" }
                            ).joinToString(" ")
                            val sub = listOfNotNull(
                                s.ts?.takeLast(8) ?: s.date,
                                s.queueNo?.let { "号$it" },
                                s.note
                            ).joinToString(" · ")
                            KvRow(title.ifBlank { "候餐服务" }, sub.ifBlank { "-" })
                        }
                    }
                }
                ModuleCard("等位明细") {
                    if (waitingQueue.isEmpty()) {
                        Text("当前无候餐对象 · 无人排队", color = Sub, fontSize = 12.sp)
                    } else {
                        waitingQueue.take(15).forEachIndexed { i, q ->
                            val eta = (waitEta - i * 2).coerceAtLeast(3)
                            KvRow(
                                "号 ${q.queueNo ?: q.id ?: "-"} · ${q.partySize ?: "-"}人",
                                "约 $eta 分 · ${q.status ?: "排队中"}"
                            )
                            val qid = q.id ?: q.queueNo
                            if (qid != null && AppModule.canWrite()) {
                                WriteActionButton(
                                    label = "给号${q.queueNo ?: qid}发茶",
                                    type = "queue.serve",
                                    summary = "候餐 · 号${q.queueNo ?: qid} 茶水",
                                    payload = buildJsonObject {
                                        put("action", "茶水")
                                        put("qty", 1)
                                        put("queue_no", (q.queueNo ?: qid).toString())
                                        put("note", "定向发茶")
                                        put("date", today)
                                        put("wait_eta_min", eta)
                                        put("queue_count", waitingQueue.size)
                                    },
                                    baseRev = booking?.rev?.toString(),
                                    onSuccess = { reload() }
                                )
                            }
                        }
                    }
                }
            }
            else -> {
                val t = ins?.tables
                val turn = ins?.turn
                ModuleCard("翻台预估 · 真实桌位") {
                    if (t == null || t.total == 0) {
                        Text("暂无桌位数据 · 推送 pos_tables 后显示", color = Sub, fontSize = 12.sp)
                    } else {
                        KvRow("桌位占用", "${t.occupied}/${t.total} 桌 · ${t.occupancyPct ?: "-"}%")
                        turn?.byCapacity?.entries?.sortedBy { it.key }?.forEach { (cap, c) ->
                            KvRow("$cap（${c.count} 张）", "翻台约 ${c.turnMin} 分")
                        }
                        Text(turn?.note ?: "", color = Sub, fontSize = 11.sp)
                    }
                }
                ModuleCard("后厨备料联动") {
                    val k = ins?.kitchen
                    if (k == null || k.expectedPortions == null) {
                        Text("人均份数未配 · 在「经营分析·保本」补齐店参后显示", color = Sub, fontSize = 12.sp)
                    } else {
                        KvRow("今日预订客流", "${k.expectedGuests} 人")
                        KvRow("建议备料", "${k.expectedPortions} 份")
                        Text("= 预订人数 × 人均 ${k.dishPerGuest} 份；可据此开工单", color = Sub, fontSize = 11.sp)
                    }
                }
                ModuleCard("加排建议（联动客流）") {
                    val st = ins?.staffing
                    if (st == null) Text("暂无建议", color = Sub, fontSize = 12.sp)
                    else {
                        Text(
                            st.text,
                            color = if (st.suggestAdd) FiveRed else FiveGreen,
                            fontWeight = FontWeight.Bold
                        )
                        KvRow("当前占用", st.occupancyPct?.let { "$it%" } ?: "-")
                        KvRow("就餐中 / 待确认 / 排队", "$dining / $pending / $queueN")
                    }
                }
                ModuleCard("桌态建议") {
                    Text(
                        "结账后桌台进入「待清」，翻台率自动联动。高峰前优先清台，缩短排队。",
                        color = Sub,
                        fontSize = 12.sp
                    )
                }
            }
        }
    }
}

/** SI 翻台与联动洞察卡：统一展示预订/排队/桌位/备料/加排 */
@Composable
private fun BookingInsightCard(ins: BookingInsightDto?) {
    if (ins == null) return
    ModuleCard("SI · 翻台与联动") {
        ins.summary?.let { s ->
            KvRow("今日预订", "${s.bookings} 桌 · ${s.guests} 人")
            if (s.bySlot.isNotEmpty()) {
                KvRow("时段分布", s.bySlot.entries.joinToString(" · ") { "${it.key} ${it.value}" })
            }
            if (s.byStatus.isNotEmpty()) {
                KvRow("状态", s.byStatus.entries.joinToString(" · ") { "${it.key} ${it.value}" })
            }
        }
        ins.queue?.let { q ->
            KvRow("排队", "等位 ${q.waiting} 组 / ${q.waitingGuests} 人 · 下一号 ${q.nextNo ?: "-"}")
        }
        ins.tables?.let { t ->
            KvRow("桌位占用", "${t.occupied}/${t.total} 桌 · ${t.occupancyPct ?: "-"}%")
        }
        ins.turn?.byCapacity?.takeIf { it.isNotEmpty() }?.let { cap ->
            KvRow("桌型翻台", cap.entries.sortedBy { it.key }.joinToString(" · ") { "${it.key}~${it.value.turnMin}分" })
        }
        ins.kitchen?.let { k ->
            if (k.expectedPortions != null) {
                KvRow("后厨备料", "预计 ${k.expectedPortions} 份（${k.expectedGuests} 人 × ${k.dishPerGuest}）")
            }
        }
        ins.staffing?.let { st ->
            Text(
                "· ${st.text}",
                color = if (st.suggestAdd) FiveRed else FiveGreen,
                fontWeight = FontWeight.Bold,
                fontSize = 12.sp,
                modifier = Modifier.padding(top = 4.dp)
            )
        }
        Text("SI 只读快照推算 · 写操作仍走确认台", color = Sub, fontSize = 10.sp)
    }
}
