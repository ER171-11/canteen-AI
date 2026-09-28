package com.pandawufu.app.features.fronthall

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.AppModule
import com.pandawufu.app.confirm.ConfirmBus
import com.pandawufu.app.confirm.ConfirmRequest
import com.pandawufu.app.features.modules.ModuleEntry
import com.pandawufu.app.ui.BossIa
import com.pandawufu.app.ui.Routes
import com.pandawufu.app.ui.designsystem.AiPink
import com.pandawufu.app.ui.designsystem.BrandBar
import com.pandawufu.app.ui.designsystem.CardHeader
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.FiveYellow
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.Line
import com.pandawufu.app.ui.designsystem.LoadStatusBanner
import com.pandawufu.app.ui.designsystem.ModuleCell
import com.pandawufu.app.ui.designsystem.PageBg
import com.pandawufu.app.ui.designsystem.AppBgBrush
import com.pandawufu.app.ui.designsystem.PandaCard
import com.pandawufu.app.ui.designsystem.SoftRefreshBar
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.app.ui.designsystem.Txt
import com.pandawufu.shared.util.LoadFailure
import com.pandawufu.shared.viewmodel.InventoryViewModel
import com.pandawufu.shared.viewmodel.KitchenViewModel
import com.pandawufu.shared.viewmodel.ModulesViewModel
import kotlin.math.roundToInt
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * L0·前厅枢纽（方案 C）：与后厨对称。
 * 可视化管道 + 实时盘面 + 智能信号 + 全功能入口（含缺口能力的办理入口）。
 */
@Composable
fun FrontHallScreen(onOpen: (String) -> Unit) {
    val context = LocalContext.current
    val modulesVm = remember { ModulesViewModel(AppModule.modulesRepository) }
    val invVm = remember { InventoryViewModel(AppModule.inventoryRepository) }
    val kitVm = remember {
        KitchenViewModel(AppModule.kitchenRepository, AppModule.inventoryRepository)
    }
    val modulesState by modulesVm.state.collectAsState()
    val invState by invVm.state.collectAsState()
    val kitState by kitVm.state.collectAsState()

    LaunchedEffect(Unit) {
        AppModule.ensureSession()
        modulesVm.dispatch(ModulesViewModel.Intent.LoadBooking())
        modulesVm.dispatch(ModulesViewModel.Intent.LoadTakeout)
        modulesVm.dispatch(ModulesViewModel.Intent.LoadReview)
        modulesVm.dispatch(ModulesViewModel.Intent.LoadVip)
        invVm.dispatch(InventoryViewModel.InventoryIntent.Refresh)
        kitVm.dispatch(KitchenViewModel.KitchenIntent.Refresh)
    }

    // 近实时：前厅开着时每 20s 刷工单看板/桌态，后厨出品/待传变化即时可见
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(20_000)
            if (AppModule.isOnline()) {
                kitVm.dispatch(KitchenViewModel.KitchenIntent.Refresh)
                invVm.dispatch(InventoryViewModel.InventoryIntent.Refresh)
            }
        }
    }

    val tables = invState.posTables
    val busyTables = remember(tables) {
        tables.filter { it.state == "busy" || it.state == "就餐" }
            .sortedBy { it.no ?: it.id }
    }
    val busy = busyTables.size
    val free = tables.count { it.state == "free" }
    val clean = tables.count { it.state == "clean" }
    val rsv = tables.count { it.state == "rsv" }
    val tableN = tables.size.coerceAtLeast(1)
    val occPct = ((busy + rsv).toFloat() / tableN * 100f).roundToInt().coerceIn(0, 100)

    val booking = modulesState.booking
    val queueN = booking?.queue?.size ?: 0
    val bookN = booking?.bookings?.size ?: 0
    val takeout = modulesState.takeout
    val takeoutOpen = takeout?.orders?.count { o ->
        val st = o.status.orEmpty()
        st.isNotBlank() && !Regex("完成|已送达|已取消|closed|done|cancel", RegexOption.IGNORE_CASE)
            .containsMatchIn(st)
    } ?: (kitState.takeoutOpen.size)
    val reviewPending = modulesState.review?.reviews?.count {
        (it.rating ?: 5.0) <= 3.0 || it.handled != 1
    } ?: 0
    val vipN = modulesState.vip?.members?.size ?: 0
    val boardPending = kitState.board.sumOf { (it.planned - it.done).coerceAtLeast(it.doing) }
    val pendingColors = remember(kitState.board) {
        kitState.board.filter { (it.planned - it.done).coerceAtLeast(it.doing) > 0 }
            .map { it.color }
            .toSet()
    }

    fun passFlow(kind: String, tableId: String, no: String?) {
        if (!AppModule.canWrite()) {
            Toast.makeText(context, "当前岗位只读", Toast.LENGTH_SHORT).show()
            return
        }
        val (title, summary, type, action) = when (kind) {
            "ready" -> listOf(
                "齐菜 · 桌 ${no ?: tableId}",
                "挂桌工单标「待传」· 出品齐了可上桌",
                "pos.ready",
                "齐菜"
            )
            "pass" -> listOf(
                "传菜 · 桌 ${no ?: tableId}",
                "挂桌工单收口「已完成」· 确认已传上桌",
                "pos.pass",
                "传菜"
            )
            else -> listOf(
                "催菜 · 桌 ${no ?: tableId}",
                "请后厨优先出品 · 提优挂桌工单",
                "pos.rush",
                "催菜"
            )
        }
        ConfirmBus.ask(
            ConfirmRequest(
                title = title,
                summary = summary,
                type = type,
                payload = buildJsonObject {
                    put("table_id", tableId)
                    put("no", no ?: tableId)
                    put("action", action)
                    put("note", "前厅传菜·$action")
                },
                baseRev = invState.rev,
                onResult = { r ->
                    Toast.makeText(
                        context,
                        r.fold({ "已确认$action" }, { it.message ?: "失败" }),
                        Toast.LENGTH_SHORT
                    ).show()
                    if (r.isSuccess) {
                        invVm.dispatch(InventoryViewModel.InventoryIntent.Refresh)
                        kitVm.dispatch(KitchenViewModel.KitchenIntent.Refresh)
                    }
                }
            )
        )
    }

    fun rushTable(tableId: String, no: String?) = passFlow("rush", tableId, no)

    val signals = buildSmartSignals(
        occPct = occPct,
        busy = busy,
        free = free,
        queueN = queueN,
        takeoutOpen = takeoutOpen,
        reviewPending = reviewPending,
        boardPending = boardPending
    )

    fun open(route: String, pill: Int? = null) {
        ModuleEntry.open(pill)
        runCatching { AppModule.modulePrefs.touch(route) }
        onOpen(route)
    }

    val frontMods = BossIa.modules.filter { it.group == "前厅" && AppModule.canOpenRoute(it.route) }

    com.pandawufu.app.ui.designsystem.AppScaffold(
        scroll = true,
        title = BossIa.Tab.FRONT,
        subtitle = BossIa.FrontHall.JOB
    ) {
        SoftRefreshBar(
            active = (modulesState.loading || invState.loading || kitState.loading) &&
                (modulesState.booking != null || invState.posTables.isNotEmpty() || kitState.board.isNotEmpty())
        )

        val hallFail = listOfNotNull(
            modulesState.error?.let { LoadFailure.fromMessage(it) },
            invState.error?.let { LoadFailure.fromMessage(it) },
            kitState.error?.let { LoadFailure.fromMessage(it) }
        ).firstOrNull { it.error != null }
        val hallHint = modulesState.emptyHint
            ?: invState.emptyHint
            ?: kitState.emptyHint
            ?: hallFail?.hint
        if (hallFail?.error != null || hallHint != null) {
            LoadStatusBanner(
                error = hallFail?.error,
                hint = hallHint,
                onRetry = {
                    modulesVm.dispatch(ModulesViewModel.Intent.LoadBooking())
                    modulesVm.dispatch(ModulesViewModel.Intent.LoadTakeout)
                    invVm.dispatch(InventoryViewModel.InventoryIntent.Refresh)
                    kitVm.dispatch(KitchenViewModel.KitchenIntent.Refresh)
                }
            )
        }

        // —— 可视化管道（流程优先，口径真实）——
        val readyCount = kitState.boardTables.sumOf { it.ready }
        val payable = tables.count { (it.amount ?: 0.0) > 0 }
        PandaCard {
            CardHeader("前厅管道", more = "迎客 → 开台 → 传菜 → 收钱 → 客评")
            Row(
                Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                PipeStep("迎客", queueN + bookN, "组", queueN > 3, FiveYellow) {
                    open(Routes.M_BOOKING, if (queueN > 0) 1 else 0)
                }
                PipeArrow()
                PipeStep("开台", busy, "桌", busy > tableN * 0.7, FiveRed) {
                    open(Routes.M_POS, 0)
                }
                PipeArrow()
                PipeStep("传菜", readyCount, "份", readyCount > 0, AiPink) {
                    onOpen(Routes.KITCHEN)
                }
                PipeArrow()
                PipeStep("收钱", payable, "桌", payable > 0, FiveGreen) {
                    // 定位到第一张待结账桌并直达结账页
                    val firstPayable = tables.firstOrNull { (it.amount ?: 0.0) > 0 }?.id
                    com.pandawufu.app.features.modules.ModuleEntry.openTable(firstPayable)
                    open(Routes.M_POS, 2)
                }
                PipeArrow()
                PipeStep("客评", reviewPending, "条", reviewPending > 0, FiveRed) {
                    open(Routes.M_REVIEW, 1)
                }
            }
        }

        // —— 实时盘面 ——
        PandaCard {
            CardHeader("实时盘面", more = "占用 $occPct%")
            Text(
                "占用 =（就餐 + 预订）/ 总桌 ${tables.size} 桌 · 点击数字可去对应盘点",
                fontSize = 11.sp,
                color = Sub
            )
            Spacer(Modifier.height(6.dp))
            LinearProgressIndicator(
                progress = { occPct / 100f },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(8.dp)
                    .clip(RoundedCornerShape(8.dp)),
                color = when {
                    occPct >= 90 -> FiveRed
                    occPct >= 70 -> FiveYellow
                    else -> FiveGreen
                },
                trackColor = Color(0xFFEEF0F4)
            )
            Spacer(Modifier.height(10.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PulseCell("就餐", "$busy", "桌", FiveRed, Modifier.weight(1f)) { open(Routes.M_POS) }
                PulseCell("空闲", "$free", "桌", FiveGreen, Modifier.weight(1f)) { open(Routes.M_POS) }
                PulseCell("排队", "$queueN", "组", FiveYellow, Modifier.weight(1f)) {
                    open(Routes.M_BOOKING, 1)
                }
                PulseCell("外卖", "$takeoutOpen", "单", AiPink, Modifier.weight(1f)) {
                    open(Routes.M_TAKEOUT)
                }
            }
            Spacer(Modifier.height(8.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PulseCell("预订", "$bookN", "桌", Color(0xFF9B6BBF), Modifier.weight(1f)) {
                    open(Routes.M_BOOKING, 0)
                }
                PulseCell("待清", "$clean", "桌", Color(0xFF3A6EA5), Modifier.weight(1f)) {
                    open(Routes.M_POS)
                }
                PulseCell("差评", "$reviewPending", "条", FiveRed, Modifier.weight(1f)) {
                    open(Routes.M_REVIEW, 1)
                }
                PulseCell("会员", "$vipN", "人", Color(0xFFE8584A), Modifier.weight(1f)) {
                    open(Routes.M_VIP)
                }
            }
        }

        // —— 待结账（定位到桌，一键去结账）——
        val payableTables = tables.filter { (it.amount ?: 0.0) > 0 }
        if (payableTables.isNotEmpty()) {
            PandaCard {
                CardHeader("待结账", more = "${payableTables.size} 桌 · 点桌去结账")
                payableTables.take(6).forEach { t ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .border(1.dp, Line, RoundedCornerShape(10.dp))
                            .clickable {
                                com.pandawufu.app.features.modules.ModuleEntry.openTable(t.id)
                                open(Routes.M_POS, 2)
                            }
                            .padding(horizontal = 10.dp, vertical = 8.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            "桌 ${t.no ?: t.name ?: t.id}",
                            fontSize = 12.5.sp, fontWeight = FontWeight.Bold, color = Ink
                        )
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                "¥${"%.0f".format(t.amount ?: 0.0)}",
                                fontSize = 13.sp, fontWeight = FontWeight.ExtraBold, color = FiveGreen
                            )
                            Spacer(Modifier.width(8.dp))
                            Text("结账 ›", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = AiPink)
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                }
            }
        }

        // —— 智能信号 ——
        PandaCard {
            CardHeader("智能信号", more = "规则+店内实况")
            Text(
                "根据占用、排队、外卖与客评自动提示；改数仍走确认台。",
                fontSize = 11.sp,
                color = Sub
            )
            Spacer(Modifier.height(8.dp))
            if (signals.isEmpty()) {
                Text("盘面平稳 · 暂无紧急信号", fontSize = 13.sp, color = FiveGreen, fontWeight = FontWeight.Bold)
            } else {
                signals.forEach { s ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(Color(0xFFF7F8FB))
                            .clickable { open(s.route, s.pill) }
                            .padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Box(
                            Modifier
                                .size(8.dp)
                                .clip(CircleShape)
                                .background(s.color)
                        )
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(s.title, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = Ink)
                            Text(s.detail, fontSize = 11.sp, color = Sub)
                        }
                        Text(s.cta, fontSize = 12.sp, fontWeight = FontWeight.Bold, color = AiPink)
                    }
                    Spacer(Modifier.height(6.dp))
                }
            }
        }

        // —— 传菜进度（嵌前厅，不全靠跳后厨）——
        PandaCard {
            CardHeader("传菜进度", more = "后厨出品 ›") { onOpen(Routes.KITCHEN) }
            Text(
                "催 → 齐 → 传：对桌挂号；催提优、齐标待传、传收口工单。",
                fontSize = 11.sp,
                color = Sub
            )
            Spacer(Modifier.height(8.dp))
            if (kitState.board.isEmpty() && kitState.takeoutOpen.isEmpty() && busyTables.isEmpty()) {
                Text("暂无出品看板数据 · 推送后厨快照后显示", fontSize = 12.sp, color = Sub)
            } else {
                kitState.board.take(6).forEach { b ->
                    val planned = b.planned.coerceAtLeast(1)
                    val done = b.done.coerceIn(0, planned)
                    val pct = done.toFloat() / planned
                    val left = (planned - done).coerceAtLeast(0)
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .padding(vertical = 4.dp)
                            .clickable { onOpen(Routes.KITCHEN) }
                    ) {
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Text(
                                "${b.color} · 做${b.doing}/完$done/计$planned",
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Bold,
                                color = Ink
                            )
                            Text(
                                if (left > 0) "待传 $left" else "齐",
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Bold,
                                color = if (left > 0) FiveYellow else FiveGreen
                            )
                        }
                        LinearProgressIndicator(
                            progress = { pct },
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(6.dp)
                                .clip(RoundedCornerShape(6.dp)),
                            color = when (b.color) {
                                "红" -> FiveRed
                                "黄" -> FiveYellow
                                "绿" -> FiveGreen
                                "紫" -> Color(0xFF9B6BBF)
                                else -> Ink
                            },
                            trackColor = Color(0xFFEEF0F4)
                        )
                    }
                }
                val passTables = kitState.boardTables
                if (passTables.isNotEmpty() || busyTables.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        if (passTables.isNotEmpty()) "工单挂桌 · 待传（${passTables.size}）"
                        else "就餐桌 · 传菜挂号（${busyTables.size}）",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        color = Ink
                    )
                    Text(
                        if (passTables.isNotEmpty()) "来自后厨工单 table_id · 催/齐/传对桌"
                        else if (pendingColors.isEmpty()) "出品色齐 · 仍可按桌催菜/去服务"
                        else "待传色：${pendingColors.joinToString("、")} · 点桌催/齐/传",
                        fontSize = 11.sp,
                        color = Sub
                    )
                    Spacer(Modifier.height(4.dp))
                    if (passTables.isNotEmpty()) {
                        passTables.take(8).forEach { pt ->
                            val colorHit = pt.colors.firstOrNull()?.color
                            val hint = pt.items.take(3).joinToString("、") {
                                "${it.name ?: it.skuId ?: "?"}×${it.qty}"
                            }.ifBlank {
                                "待${pt.pending} · 做${pt.doing}" +
                                    if (pt.ready > 0) " · 齐${pt.ready}" else ""
                            }
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(10.dp))
                                    .border(1.dp, Line, RoundedCornerShape(10.dp))
                                    .padding(horizontal = 10.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Box(
                                    Modifier
                                        .size(8.dp)
                                        .clip(CircleShape)
                                        .background(
                                            when (colorHit) {
                                                "红" -> FiveRed
                                                "黄" -> FiveYellow
                                                "绿" -> FiveGreen
                                                "紫" -> Color(0xFF9B6BBF)
                                                null -> AiPink
                                                else -> Ink
                                            }
                                        )
                                )
                                Spacer(Modifier.width(8.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        "桌 ${pt.tableLabel()} · 待${pt.pending}" +
                                            if (pt.ready > 0) " · 齐${pt.ready}" else "",
                                        fontSize = 12.sp,
                                        fontWeight = FontWeight.Bold,
                                        color = Ink
                                    )
                                    Text(hint, fontSize = 11.sp, color = Sub, maxLines = 1)
                                }
                                Text(
                                    "催",
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = FiveRed,
                                    modifier = Modifier
                                        .clickable { passFlow("rush", pt.tableId, pt.tableNo) }
                                        .padding(horizontal = 4.dp)
                                )
                                Text(
                                    "齐",
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = FiveYellow,
                                    modifier = Modifier
                                        .clickable { passFlow("ready", pt.tableId, pt.tableNo) }
                                        .padding(horizontal = 4.dp)
                                )
                                Text(
                                    "传",
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = FiveGreen,
                                    modifier = Modifier
                                        .clickable { passFlow("pass", pt.tableId, pt.tableNo) }
                                        .padding(horizontal = 4.dp)
                                )
                            }
                            Spacer(Modifier.height(6.dp))
                        }
                    } else {
                        busyTables.take(8).forEach { t ->
                            val hint = t.billSummary?.takeIf { it.isNotBlank() }
                                ?: t.bill.take(3).joinToString("、") { "${it.label()}×${it.qty ?: 1}" }
                                    .ifBlank { "就餐中 · 未挂明细" }
                            val colorHit = pendingColors.firstOrNull { c ->
                                hint.contains(c) || t.bill.any { line ->
                                    (line.name ?: "").contains(c) || line.label().contains(c)
                                }
                            }
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(10.dp))
                                    .border(1.dp, Line, RoundedCornerShape(10.dp))
                                    .padding(horizontal = 10.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Box(
                                    Modifier
                                        .size(8.dp)
                                        .clip(CircleShape)
                                        .background(
                                            when (colorHit) {
                                                "红" -> FiveRed
                                                "黄" -> FiveYellow
                                                "绿" -> FiveGreen
                                                "紫" -> Color(0xFF9B6BBF)
                                                null -> AiPink
                                                else -> Ink
                                            }
                                        )
                                )
                                Spacer(Modifier.width(8.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        "桌 ${t.no ?: t.id}${if (colorHit != null) " · 待传$colorHit" else ""}",
                                        fontSize = 12.sp,
                                        fontWeight = FontWeight.Bold,
                                        color = Ink
                                    )
                                    Text(hint, fontSize = 11.sp, color = Sub, maxLines = 1)
                                }
                                Text(
                                    "催",
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = FiveRed,
                                    modifier = Modifier
                                        .clickable { passFlow("rush", t.id, t.no) }
                                        .padding(horizontal = 4.dp)
                                )
                                Text(
                                    "齐",
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = FiveYellow,
                                    modifier = Modifier
                                        .clickable { passFlow("ready", t.id, t.no) }
                                        .padding(horizontal = 4.dp)
                                )
                                Text(
                                    "传",
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = FiveGreen,
                                    modifier = Modifier
                                        .clickable { passFlow("pass", t.id, t.no) }
                                        .padding(horizontal = 4.dp)
                                )
                            }
                            Spacer(Modifier.height(6.dp))
                        }
                    }
                }
                if (kitState.takeoutOpen.isNotEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    Text("外卖待做 ${kitState.takeoutOpen.size}", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = Ink)
                    kitState.takeoutOpen.take(4).forEach { o ->
                        Text(
                            listOfNotNull(o.platform, o.status, o.idText().takeLast(6).ifBlank { null })
                                .joinToString(" · "),
                            fontSize = 11.sp,
                            color = Sub,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { open(Routes.M_TAKEOUT, 0) }
                                .padding(vertical = 2.dp)
                        )
                    }
                }
            }
        }

        // —— 销售 / 服务双入口 ——
        PandaCard {
            CardHeader("销售与服务", more = "${frontMods.size}")
            Text("销售：收银·外卖·会员　｜　服务：预订·口碑·桌务", fontSize = 11.sp, color = Sub)
            Spacer(Modifier.height(8.dp))
            frontMods.chunked(3).forEach { row ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { m ->
                        ModuleCell(
                            label = m.label,
                            subtitle = m.gridSub,
                            iconBg = Color(m.iconBgArgb),
                            modifier = Modifier.weight(1f)
                        ) { open(m.route) }
                    }
                    repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
                }
                Spacer(Modifier.height(8.dp))
            }
        }

        // —— 当场服务：客诉 / 会员到店（一等入口，不全靠跳转）——
        PandaCard {
            CardHeader("当场服务", more = "口碑 ›") { open(Routes.M_REVIEW, 1) }
            Text(
                "就餐中客诉与会员到店，直入确认台；落库后口碑/会员页可见。",
                fontSize = 11.sp,
                color = Sub
            )
            Spacer(Modifier.height(8.dp))
            if (busyTables.isNotEmpty() && AppModule.canWrite()) {
                busyTables.take(4).forEach { t ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(vertical = 4.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            "桌 ${t.no ?: t.id}",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold,
                            color = Ink
                        )
                        Text(
                            "客诉",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold,
                            color = FiveRed,
                            modifier = Modifier.clickable {
                                ConfirmBus.ask(
                                    ConfirmRequest(
                                        title = "客诉当场 · 桌 ${t.no ?: t.id}",
                                        summary = "登记堂食客诉并建改进单",
                                        type = "review.followup",
                                        payload = buildJsonObject {
                                            put("table_id", t.id)
                                            put("no", t.no ?: t.id)
                                            put("source", "堂食当场")
                                            put("content", "桌${t.no ?: t.id}客诉 · 前厅登记")
                                            put("action", "店长当场致歉")
                                            put("owner", AppModule.role ?: "老板")
                                            put("status", "待处理")
                                            put("rating", 2.0)
                                            put("note", "当场处理")
                                        },
                                        baseRev = invState.rev,
                                        onResult = { r ->
                                            Toast.makeText(
                                                context,
                                                r.fold({ "已登记客诉" }, { it.message ?: "失败" }),
                                                Toast.LENGTH_SHORT
                                            ).show()
                                            if (r.isSuccess) {
                                                modulesVm.dispatch(ModulesViewModel.Intent.LoadReview)
                                            }
                                        }
                                    )
                                )
                            }
                        )
                    }
                }
            } else {
                Text("无就餐桌 · 可去口碑页登记当场客诉", fontSize = 12.sp, color = Sub)
            }
            Spacer(Modifier.height(6.dp))
            ServiceAction("会员到店识别", "会员 · 到店") { open(Routes.M_VIP, 4) }
            ServiceAction("口碑差评 / 客诉跟进", "口碑 · 差评") { open(Routes.M_REVIEW, 1) }
        }

        // —— 服务能力（含缺口办理入口，功能不遗漏）——
        PandaCard {
            CardHeader("服务办理", more = "含加菜催菜退菜打包")
            Text(
                "下列能力有的已落模块、有的从对应页办理；点进去即办，不丢入口。",
                fontSize = 11.sp,
                color = Sub
            )
            Spacer(Modifier.height(8.dp))
            ServiceAction("巡台改态 / 并拆转台", "堂食收银 · 巡台") { open(Routes.M_POS, 0) }
            ServiceAction("点菜挂单 / 加菜催菜退菜", "堂食收银 · 点菜 / 服务模式") { open(Routes.M_POS, 1) }
            ServiceAction("结账 / 打包外带", "堂食收银 · 结账") { open(Routes.M_POS, 2) }
            ServiceAction("预订确认 / 到店开台", "预订排队 · 今日预订") { open(Routes.M_BOOKING, 0) }
            ServiceAction("排队叫号", "预订排队 · 排队叫号") { open(Routes.M_BOOKING, 1) }
            ServiceAction("候餐发茶/小食/估时", "预订排队 · 候餐服务") { open(Routes.M_BOOKING, 2) }
            ServiceAction("翻台预估 / 加排人力", "预订排队 · 翻台预估") { open(Routes.M_BOOKING, 3) }
            ServiceAction("就餐桌加菜催菜退菜打包客诉", "堂食收银 · 服务模式") { open(Routes.M_POS, 0) }
            ServiceAction("外卖接单 / 转后厨工单", "外卖 · 概览") { open(Routes.M_TAKEOUT, 0) }
            ServiceAction("渠道对账", "外卖 · 对账") { open(Routes.M_TAKEOUT, 1) }
            ServiceAction("会员核券 / 生日关怀", "会员") { open(Routes.M_VIP) }
            ServiceAction("看出品进度（传菜协同）", "后厨 · 出品") { onOpen(Routes.KITCHEN) }
        }

        Text(
            BossIa.Boundary.FRONT_VS_KITCHEN,
            fontSize = 11.sp,
            color = Sub,
            fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(horizontal = 4.dp)
        )
    }
}

private data class SmartSignal(
    val title: String,
    val detail: String,
    val cta: String,
    val route: String,
    val pill: Int?,
    val color: Color
)

private fun buildSmartSignals(
    occPct: Int,
    busy: Int,
    free: Int,
    queueN: Int,
    takeoutOpen: Int,
    reviewPending: Int,
    boardPending: Int
): List<SmartSignal> {
    val out = mutableListOf<SmartSignal>()
    if (queueN >= 3 && free <= 1) {
        out += SmartSignal(
            "等位偏多 · 空台紧",
            "排队 $queueN 组 · 空闲仅 $free 桌 · 建议催清台/翻台",
            "去叫号",
            Routes.M_BOOKING,
            1,
            FiveRed
        )
    }
    if (occPct >= 85) {
        out += SmartSignal(
            "堂食高峰 · 占用 $occPct%",
            "就餐 $busy 桌 · 盯服务与催菜，避免差评",
            "去巡台",
            Routes.M_POS,
            0,
            FiveYellow
        )
    }
    if (takeoutOpen >= 4) {
        out += SmartSignal(
            "外卖积压 $takeoutOpen 单",
            "建议转后厨工单或看出品板协同",
            "去外卖",
            Routes.M_TAKEOUT,
            0,
            AiPink
        )
    }
    if (boardPending >= 5) {
        out += SmartSignal(
            "出品待做偏多",
            "后厨看板约 $boardPending 项待推进 · 前厅可同步催菜预期",
            "看出品",
            Routes.KITCHEN,
            null,
            Color(0xFF9B6BBF)
        )
    }
    if (reviewPending > 0) {
        out += SmartSignal(
            "有 $reviewPending 条差评待回",
            "客诉宜当天回访，避免平台降权",
            "去回访",
            Routes.M_REVIEW,
            1,
            FiveRed
        )
    }
    if (free >= 3 && queueN == 0 && occPct < 40) {
        out += SmartSignal(
            "空台较多 · 可促熟客",
            "空闲 $free 桌 · 可推会员券/预订填谷",
            "看会员",
            Routes.M_VIP,
            2,
            FiveGreen
        )
    }
    return out.take(5)
}

@Composable
private fun PipeStep(
    label: String,
    value: Int,
    unit: String,
    hot: Boolean,
    accent: Color,
    onClick: () -> Unit
) {
    Column(
        Modifier
            .width(78.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(if (hot) accent.copy(alpha = 0.12f) else Color(0xFFF7F8FB))
            .border(
                1.dp,
                if (hot) accent.copy(alpha = 0.5f) else Line,
                RoundedCornerShape(14.dp)
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 9.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(label, fontSize = 11.sp, fontWeight = FontWeight.Bold, color = Sub)
        Row(verticalAlignment = Alignment.Bottom) {
            Text(
                if (value > 0) "$value" else "0",
                fontSize = 19.sp,
                fontWeight = FontWeight.ExtraBold,
                color = if (hot) accent else Txt
            )
            Spacer(Modifier.width(2.dp))
            Text(unit, fontSize = 9.5.sp, color = Sub, modifier = Modifier.padding(bottom = 2.dp))
        }
    }
}

@Composable
private fun PipeArrow() {
    Text("→", fontSize = 14.sp, color = Sub, fontWeight = FontWeight.Bold)
}

@Composable
private fun PulseCell(
    label: String,
    value: String,
    unit: String,
    accent: Color,
    modifier: Modifier = Modifier,
    onClick: () -> Unit
) {
    Column(
        modifier
            .clip(RoundedCornerShape(14.dp))
            .background(Color(0xFFF7F8FB))
            .clickable(onClick = onClick)
            .padding(10.dp)
    ) {
        Text(label, fontSize = 10.sp, color = Sub)
        Row(verticalAlignment = Alignment.Bottom) {
            Text(value, fontSize = 18.sp, fontWeight = FontWeight.ExtraBold, color = accent)
            Spacer(Modifier.width(2.dp))
            Text(unit, fontSize = 10.sp, color = Sub, modifier = Modifier.padding(bottom = 2.dp))
        }
    }
}

@Composable
private fun ServiceAction(title: String, sub: String, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .border(1.dp, Line, RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = Ink)
            Text(sub, fontSize = 11.sp, color = Sub)
        }
        Text("›", fontSize = 18.sp, color = Sub, fontWeight = FontWeight.Bold)
    }
    Spacer(Modifier.height(6.dp))
}
