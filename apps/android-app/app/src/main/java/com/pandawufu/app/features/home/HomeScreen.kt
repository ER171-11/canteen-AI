package com.pandawufu.app.features.home

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.Canvas
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Logout
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.pandawufu.app.AppModule
import com.pandawufu.app.confirm.ConfirmBus
import com.pandawufu.app.confirm.ConfirmRequest
import com.pandawufu.app.confirm.OpsSignal
import com.pandawufu.app.features.inventory.askRestockConfirm
import com.pandawufu.app.features.modules.ModuleEntry
import com.pandawufu.app.ui.BossIa
import com.pandawufu.app.ui.Routes
import com.pandawufu.app.ui.designsystem.AiPink
import com.pandawufu.app.ui.designsystem.BrandBar
import com.pandawufu.app.ui.designsystem.CardHeader
import com.pandawufu.app.ui.designsystem.FiveBlack
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FivePurple
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.FiveSaleRow
import com.pandawufu.app.ui.designsystem.FiveYellow
import com.pandawufu.app.ui.designsystem.GreetBlock
import com.pandawufu.app.ui.designsystem.HeatMiniBar
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.KpiGrid
import com.pandawufu.app.ui.designsystem.LoadStatusBanner
import com.pandawufu.app.ui.designsystem.PageBg
import com.pandawufu.app.ui.designsystem.PandaCard
import com.pandawufu.app.ui.designsystem.ProtoKv
import com.pandawufu.app.ui.designsystem.SoftRefreshBar
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.app.ui.designsystem.SumBanner
import com.pandawufu.app.ui.designsystem.SwipeTodoRow
import com.pandawufu.app.ui.designsystem.Txt
import com.pandawufu.shared.viewmodel.HomeViewModel
import com.pandawufu.shared.viewmodel.InventoryViewModel
import com.pandawufu.shared.viewmodel.KitchenViewModel
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.util.Locale
import kotlin.math.max
import kotlin.math.roundToInt

private val bossKpiAllow = setOf("营收", "订单", "客单", "毛利", "翻台", "实收", "会员", "桌位", "坪效", "人效", "已售")

private fun isBossKpi(label: String): Boolean =
    bossKpiAllow.any { label.contains(it) } &&
        !label.contains("rev", ignoreCase = true) &&
        !label.contains("快照") &&
        !label.contains("记录总数") &&
        !label.contains("SKU")

@Composable
fun HomeScreen(
    onOpenModule: (String) -> Unit = {},
    onLogout: () -> Unit = { AppModule.logout() }
) {
    val viewModel = remember {
        HomeViewModel(AppModule.healthRepository, AppModule.reportRepository)
    }
    val modulesVm = remember { com.pandawufu.shared.viewmodel.ModulesViewModel(AppModule.modulesRepository) }
    val invVm = remember { InventoryViewModel(AppModule.inventoryRepository) }
    val kitVm = remember { KitchenViewModel(AppModule.kitchenRepository, AppModule.inventoryRepository) }
    val state by viewModel.state.collectAsState()
    val modulesState by modulesVm.state.collectAsState()
    val invState by invVm.state.collectAsState()
    val kitState by kitVm.state.collectAsState()
    val context = LocalContext.current

    LaunchedEffect(Unit) {
        AppModule.ensureSession()
        viewModel.dispatch(HomeViewModel.HomeIntent.Refresh)
        modulesVm.dispatch(com.pandawufu.shared.viewmodel.ModulesViewModel.Intent.LoadBooking())
        modulesVm.dispatch(com.pandawufu.shared.viewmodel.ModulesViewModel.Intent.LoadAnalysis)
        modulesVm.dispatch(com.pandawufu.shared.viewmodel.ModulesViewModel.Intent.LoadTakeout)
        modulesVm.dispatch(com.pandawufu.shared.viewmodel.ModulesViewModel.Intent.LoadStaff)
        invVm.dispatch(InventoryViewModel.InventoryIntent.Refresh)
        kitVm.dispatch(KitchenViewModel.KitchenIntent.Refresh)
    }

    // 从确认台/其他模块返回时自动刷新今日数据
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val obs = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                viewModel.dispatch(HomeViewModel.HomeIntent.Refresh)
                modulesVm.dispatch(com.pandawufu.shared.viewmodel.ModulesViewModel.Intent.LoadAnalysis)
                invVm.dispatch(InventoryViewModel.InventoryIntent.Refresh)
                kitVm.dispatch(KitchenViewModel.KitchenIntent.Refresh)
            }
        }
        lifecycleOwner.lifecycle.addObserver(obs)
        onDispose { lifecycleOwner.lifecycle.removeObserver(obs) }
    }
    LaunchedEffect(OpsSignal.refreshHomeTick) {
        if (OpsSignal.refreshHomeTick > 0) {
            viewModel.dispatch(HomeViewModel.HomeIntent.Refresh)
            modulesVm.dispatch(com.pandawufu.shared.viewmodel.ModulesViewModel.Intent.LoadAnalysis)
            invVm.dispatch(InventoryViewModel.InventoryIntent.Refresh)
            kitVm.dispatch(KitchenViewModel.KitchenIntent.Refresh)
        }
    }

    fun openModule(route: String) {
        runCatching { AppModule.modulePrefs.touch(route) }
        onOpenModule(route)
    }

    val report = state.report
    val heatMini = report?.heatMini.orEmpty()
    var confirmLogout by remember { mutableStateOf(false) }
    val greetName = when {
        !AppModule.displayName.isNullOrBlank() -> AppModule.displayName!!
        AppModule.role == "老板" || AppModule.account == "boss" -> BossIa.Brand.BOSS_NAME
        AppModule.role == "店长" -> "店长"
        !AppModule.account.isNullOrBlank() && AppModule.account !in setOf("boss", "manager", "cashier", "kitchen", "finance") ->
            AppModule.account!!
        else -> "掌柜"
    }
    val roleAccent = when {
        AppModule.role == "老板" || AppModule.role?.equals("boss", true) == true -> "·今日"
        AppModule.role == "店长" || AppModule.role?.equals("manager", true) == true -> "·店长值班"
        else -> "·功夫当道"
    }
    val today = remember {
        LocalDate.now().format(DateTimeFormatter.ofPattern("yyyy年M月d日 E", Locale.CHINA))
    }
    val ageMin = minutesSince(report?.generatedAt)
    val freshHint = when {
        ageMin != null && ageMin > 60 -> "数据约 ${ageMin / 60} 小时前更新"
        ageMin != null && ageMin > 15 -> "数据约 ${ageMin} 分钟前更新"
        report?.generatedAt != null -> "刚刚同步"
        else -> "正在拉取今日数据"
    }

    if (confirmLogout) {
        AlertDialog(
            onDismissRequest = { confirmLogout = false },
            title = { Text("退出登录？") },
            text = { Text("退出后需重新登录才能查看本店数据。") },
            confirmButton = {
                TextButton(onClick = { confirmLogout = false; onLogout() }) {
                    Text("退出", color = FiveRed, fontWeight = FontWeight.Bold)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmLogout = false }) { Text("取消", color = Ink) }
            }
        )
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(PageBg)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 14.dp, vertical = 12.dp)
            .padding(bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        BrandBar(
            title = BossIa.Brand.NAME,
            subtitle = BossIa.Brand.tabSubtitle(
                BossIa.Tab.TODAY,
                BossIa.Tab.TODAY_JOB,
                listOfNotNull(
                    AppModule.storeName
                        ?.removePrefix("熊猫五福餐厅")
                        ?.trim()
                        ?.ifBlank { AppModule.storeName }
                        ?: AppModule.storeName,
                    AppModule.role
                ).joinToString(" · ").ifBlank { BossIa.Home.GREET_FALLBACK }
            ),
            trailing = {
                Row(
                    Modifier
                        .size(36.dp)
                        .clip(CircleShape)
                        .background(Color.White)
                        .clickable { confirmLogout = true },
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(Icons.Outlined.Logout, contentDescription = "退出", tint = Sub, modifier = Modifier.size(18.dp))
                }
            }
        )

        GreetBlock(
            name = greetHello() + "，$greetName",
            accent = roleAccent,
            sub = "$today · $freshHint"
        )

        SoftRefreshBar(active = state.loading && report != null)
        if (state.error != null && report != null) {
            LoadStatusBanner(
                error = "今日数据暂未更新，以下为上次成功同步的数据",
                hint = state.error,
                onRetry = { viewModel.dispatch(HomeViewModel.HomeIntent.Refresh) }
            )
        }

        when {
            state.loading && report == null -> {
                PandaCard {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                        CircularProgressIndicator(Modifier.size(28.dp), color = AiPink, strokeWidth = 3.dp)
                    }
                }
            }
            state.error != null && report == null -> {
                PandaCard {
                    Text("暂时连不上门店数据", color = FiveRed, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    Text("请确认手机已连电脑调试，或稍后重试", color = Sub, fontSize = 12.sp)
                    Text(
                        "点击重试",
                        color = AiPink,
                        fontWeight = FontWeight.Bold,
                        fontSize = 13.sp,
                        modifier = Modifier.clickable {
                            viewModel.dispatch(HomeViewModel.HomeIntent.Refresh)
                        }
                    )
                }
            }
            else -> {
                val revenue = report?.kpi?.firstOrNull { it.label.contains("营收") }?.value
                    ?: report?.kpi?.firstOrNull()?.value
                    ?: "—"
                val orders = report?.kpi?.firstOrNull { it.label.contains("订单") || it.label.contains("单") }?.value
                // 今日无销售：营收为 0（真数据）时给出友好提示，避免老板误以为系统故障
                val noSalesToday = report?.mock != true && (parseMoneyYuan(revenue) ?: 0.0) <= 0.0
                val bannerLab = when {
                    noSalesToday -> "今日营收 · ${report?.date.orEmpty()} · 暂无销售".trim()
                    !report?.date.isNullOrBlank() -> "今日营收 · ${report!!.date}"
                    else -> "今日营收"
                }
                val delta = report?.kpi?.firstOrNull { it.label.contains("营收") }?.delta
                    ?: "重要操作需确认后才会改数"
                SumBanner(
                    label = bannerLab + if (report?.mock == true) " · 演示" else "",
                    value = if (revenue.startsWith("¥") || revenue.startsWith("￥")) revenue else "¥ $revenue",
                    valueSuffix = orders?.let { "· $it 单" },
                    delta = when {
                        report?.mock == true -> "演示数据 · 推送快照会切换成真数"
                        !report?.summary.isNullOrBlank() -> report?.summary.orEmpty()
                        noSalesToday -> "今日还没有销售记录 · 营业后自动更新，点此刷新"
                        else -> delta
                    }
                )

                // P0 置顶：老板开屏第一眼要看到「今天要我办的事」——待办 + 预警 + 告急补货
                run {
                    val pendingTodos = report?.todos.orEmpty().filter { it.done != true }
                    val alertN = report?.alerts.orEmpty().size
                    val urgentN = invState.restock.count {
                        it.urgency.equals("critical", true) || it.urgency?.contains("急") == true
                    }
                    if (pendingTodos.isNotEmpty() || alertN > 0 || urgentN > 0) {
                        PandaCard {
                            Row(
                                Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    "今天先办这几件",
                                    fontSize = 14.sp,
                                    fontWeight = FontWeight.ExtraBold,
                                    color = Ink
                                )
                                if (AppModule.canWrite()) {
                                    Text(
                                        "去确认台 ›",
                                        fontSize = 12.sp,
                                        fontWeight = FontWeight.Bold,
                                        color = AiPink,
                                        modifier = Modifier.clickable { openModule(Routes.M_ACTIONS) }
                                    )
                                }
                            }
                            Spacer(Modifier.height(6.dp))
                            pendingTodos.take(3).forEach { t ->
                                Text(
                                    "· " + t.displayText(),
                                    fontSize = 12.sp,
                                    color = Ink,
                                    modifier = Modifier.padding(vertical = 2.dp)
                                )
                            }
                            if (urgentN > 0) {
                                Text(
                                    "· 告急补货 $urgentN 项",
                                    fontSize = 12.sp,
                                    color = FiveRed,
                                    modifier = Modifier
                                        .padding(top = 2.dp)
                                        .clickable { openModule("inventory/restock") }
                                )
                            }
                            if (alertN > 0) {
                                Text(
                                    "另有 $alertN 条预警 · 点此查看",
                                    fontSize = 11.sp,
                                    color = Sub,
                                    modifier = Modifier
                                        .padding(top = 4.dp)
                                        .clickable { openModule(Routes.M_ACTIONS) }
                                )
                            }
                        }
                    }
                }
                val actualKpiSpecs = listOf(
                    Triple("订单", listOf("订单", "单量"), "单"),
                    Triple("实收", listOf("实收", "净营收"), ""),
                    Triple("毛利率", listOf("毛利率", "毛利"), "%"),
                    Triple("客单价", listOf("客单价", "客单"), "")
                )
                val actualKpis = actualKpiSpecs.mapNotNull { (title, labels, unit) ->
                    val metric = report?.kpi?.firstOrNull { k -> labels.any { k.label.contains(it) } }
                    metric?.let { Triple(title, withMetricUnit(it.value, unit), it.delta) }
                }
                val actualTrend = modulesState.analysis?.trend.orEmpty()
                    .filter { it.revenue != null }
                    .takeLast(7)
                if (actualKpis.isNotEmpty() || actualTrend.isNotEmpty()) {
                    PandaCard {
                        CardHeader("经营实绩", more = "完整经营分析 ›") {
                            openModule(Routes.M_ANALYSIS)
                        }
                        Text(
                            if (report?.mock == true) "演示数据 · 仅作界面参考" else "来自门店日报与经营记录 · 不含预测",
                            fontSize = 10.sp,
                            color = Sub
                        )
                        if (actualKpis.isNotEmpty()) {
                            Spacer(Modifier.height(8.dp))
                            KpiGrid(actualKpis, columns = 2)
                        }
                        if (actualTrend.isNotEmpty()) {
                            Spacer(Modifier.height(12.dp))
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("近${actualTrend.size}日营收", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = Ink)
                                val revs = actualTrend.mapNotNull { it.revenue }
                                if (revs.isNotEmpty()) {
                                    Text(
                                        "峰值 ¥${"%,.0f".format(Locale.CHINA, revs.max())} · 日均 ¥${"%,.0f".format(Locale.CHINA, revs.sum() / revs.size)}",
                                        fontSize = 11.sp,
                                        color = Sub
                                    )
                                }
                            }
                            Spacer(Modifier.height(4.dp))
                            Canvas(Modifier.fillMaxWidth().height(72.dp).padding(horizontal = 3.dp, vertical = 5.dp)) {
                                val values = actualTrend.mapNotNull { it.revenue }.map { it.toFloat() }
                                if (values.size > 1) {
                                    val low = values.minOrNull() ?: 0f
                                    val high = values.maxOrNull() ?: 1f
                                    val span = (high - low).coerceAtLeast(1f)
                                    val path = Path()
                                    values.forEachIndexed { index, value ->
                                        val x = size.width * index / (values.size - 1)
                                        val y = size.height - ((value - low) / span) * (size.height * .78f) - size.height * .1f
                                        if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
                                    }
                                    drawPath(path, color = AiPink, style = Stroke(width = 4f))
                                }
                            }
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                actualTrend.forEach { item ->
                                    Text(item.date?.takeLast(5) ?: item.week ?: "", fontSize = 9.sp, color = Sub)
                                }
                            }
                        }
                    }
                }
                // 新店/无快照：给老板明确下一步，避免空进销死磕
                if (report?.mock == true || state.rev.isNullOrBlank()) {
                    PandaCard {
                        Text("店内快照未接通", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = FiveRed)
                        Text(
                            "进销、桌台、菜品都靠店内推送。先跑 store-inventory 的 snapshot_pusher，再点刷新。",
                            fontSize = 12.sp,
                            color = Sub
                        )
                        Text(
                            "也可先去「我的餐厅」配资料/桌台，或「门店岗位」开账号 ›",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold,
                            color = Ink,
                            modifier = Modifier
                                .padding(top = 6.dp)
                                .clickable { openModule(Routes.M_RESTAURANT) }
                        )
                    }
                }
                // P0：早上一眼距保本（价盘测算，非今日实收结算）
                val be = modulesState.analysis?.baobenSummary?.kpi
                val beDay = be?.beDay
                if (beDay != null && beDay > 0) {
                    val actual = parseMoneyYuan(revenue)
                    val gap = if (actual != null) actual - beDay else null
                    val theor = be.dayDishRev ?: be.dayRev
                    PandaCard {
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text("距理论日保本", fontSize = 11.sp, color = Sub)
                                Text(
                                    "¥${"%,.0f".format(Locale.CHINA, beDay)}",
                                    fontSize = 20.sp,
                                    fontWeight = FontWeight.ExtraBold,
                                    color = if (gap != null && gap < 0) FiveRed else Ink
                                )
                            }
                            Column(horizontalAlignment = Alignment.End) {
                                when {
                                    gap != null && gap >= 0 -> {
                                        Text("已过保本", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = FiveGreen)
                                        Text("+¥${"%,.0f".format(Locale.CHINA, gap)}", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = FiveGreen)
                                    }
                                    gap != null -> {
                                        Text("还差", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = FiveRed)
                                        Text("¥${"%,.0f".format(Locale.CHINA, -gap)}", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = FiveRed)
                                    }
                                    theor != null -> {
                                        Text("价盘日菜品营收", fontSize = 11.sp, color = Sub)
                                        Text("¥${"%,.0f".format(Locale.CHINA, theor)}", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = Ink)
                                    }
                                }
                            }
                        }
                        Text(
                            "价盘测算 · 非今日实收结算 · 点此看结构 ›",
                            fontSize = 11.sp,
                            color = Sub,
                            modifier = Modifier
                                .padding(top = 6.dp)
                                .clickable { openModule(Routes.M_ANALYSIS) }
                        )
                    }
                }
            }
        }

        // 确认台办完后的人话提示（可点跳转）
        val opsBanner = OpsSignal.peekBanner()
        if (!opsBanner.isNullOrBlank()) {
            PandaCard {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        opsBanner,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                        color = FiveGreen,
                        modifier = Modifier.weight(1f)
                    )
                    Text(
                        "知道了",
                        fontSize = 12.sp,
                        color = Sub,
                        modifier = Modifier.clickable { OpsSignal.clearBanner() }
                    )
                }
                OpsSignal.bannerRoute?.let { r ->
                    Text(
                        "去查看 ›",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        color = Ink,
                        modifier = Modifier
                            .padding(top = 4.dp)
                            .clickable {
                                OpsSignal.clearBanner()
                                openModule(r)
                            }
                    )
                }
            }
        }

        // 待你确认：系统算好，老板点一次（不是无人全自动）
        val restockItems = invState.restock
        // 一键只提告急；没有告急则取前 8 条偏低，避免一次确认上百项
        val packRestock = restockItems
            .filter { it.urgency.equals("critical", true) || it.urgency?.contains("急") == true }
            .ifEmpty { restockItems.take(8) }
        val demand = kitState.demand
        val sugWo = demand?.suggestWorkorders?.firstOrNull()
        val showAutoPack = AppModule.canWrite() && (
            (packRestock.isNotEmpty() && "restock" !in OpsSignal.hideTodoKinds) ||
                ((demand?.gap ?: 0) > 0 && sugWo != null && "prep" !in OpsSignal.hideTodoKinds)
            )
        if (showAutoPack) {
            PandaCard {
                CardHeader("待你确认", more = "确认台 ›") { openModule(Routes.M_ACTIONS) }
                Text(
                    BossIa.Home.CONFIRM_HINT,
                    fontSize = 11.sp,
                    color = Sub
                )
                if (packRestock.isNotEmpty() && "restock" !in OpsSignal.hideTodoKinds) {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .padding(top = 8.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(FiveRed)
                            .clickable {
                                askRestockConfirm(
                                    packRestock,
                                    invState.rev,
                                    suppliers = (invState.vendors.map { it.name } + invState.suppliers).distinct(),
                                    quotes = invState.quotes
                                ) { ok, msg ->
                                    Toast.makeText(context, msg, Toast.LENGTH_SHORT).show()
                                    if (ok) {
                                        invVm.dispatch(InventoryViewModel.InventoryIntent.Refresh)
                                        openModule(Routes.INVENTORY_PURCHASE)
                                    }
                                }
                            }
                            .padding(vertical = 12.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            "一键确认告急补货 ${packRestock.size} 项",
                            color = Color.White,
                            fontWeight = FontWeight.ExtraBold,
                            fontSize = 14.sp
                        )
                    }
                }
                if ((demand?.gap ?: 0) > 0 && sugWo != null && "prep" !in OpsSignal.hideTodoKinds) {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .padding(top = 8.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(Ink)
                            .clickable {
                                ConfirmBus.ask(
                                    ConfirmRequest(
                                        title = "一键补本餐工单缺口",
                                        summary = "${sugWo.name ?: sugWo.skuId} · ${sugWo.qty} 个\n缺口 ${demand?.gap} · ${sugWo.reason ?: "本餐需求"}",
                                        type = "workorder.create",
                                        payload = buildJsonObject {
                                            put("sku_id", sugWo.skuId)
                                            put("qty", sugWo.qty)
                                            put("status", "待开始")
                                            put("note", "首页确认·本餐缺口")
                                        },
                                        baseRev = kitState.rev,
                                        onResult = { r ->
                                            r.fold(
                                                onSuccess = {
                                                    Toast.makeText(context, "工单已提交", Toast.LENGTH_SHORT).show()
                                                    kitVm.dispatch(
                                                        KitchenViewModel.KitchenIntent.AfterWorkorderQueued(
                                                            sugWo.skuId,
                                                            sugWo.qty
                                                        )
                                                    )
                                                    openModule(Routes.KITCHEN)
                                                },
                                                onFailure = {
                                                    Toast.makeText(context, it.message ?: "失败", Toast.LENGTH_SHORT).show()
                                                }
                                            )
                                        }
                                    )
                                )
                            }
                            .padding(vertical = 12.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            "一键补本餐工单 ${sugWo.qty} 个",
                            color = Color.White,
                            fontWeight = FontWeight.ExtraBold,
                            fontSize = 14.sp
                        )
                    }
                }
            }
        }

        // 今日作战：断货补货 / 建议备料 / 渠道 —— 按 kind/route 真深链
        val hiddenKinds = OpsSignal.hideTodoKinds
        val todos = report?.todos.orEmpty().filter { t ->
            if (t.done == true) return@filter false
            val kind = t.kind
            if (kind != null && kind in hiddenKinds) return@filter false
            val text = t.displayText()
            if ("restock" in hiddenKinds && (text.contains("补货") || text.contains("断货"))) return@filter false
            if ("prep" in hiddenKinds && (text.contains("工单") || text.contains("备料"))) return@filter false
            true
        }
        if (todos.isNotEmpty()) {
            PandaCard {
                CardHeader("今日待办", more = "${todos.size} 项 ›") {
                    openModule(Routes.M_ACTIONS)
                }
                Text(
                    BossIa.Home.TODO_HINT,
                    fontSize = 11.sp,
                    color = Sub,
                    modifier = Modifier.padding(bottom = 4.dp)
                )
                todos.take(5).forEach { t ->
                    val jump = when {
                        !t.route.isNullOrBlank() -> t.route!!
                        t.kind == "restock" -> Routes.INVENTORY_RESTOCK
                        t.kind == "prep" -> Routes.KITCHEN
                        t.kind == "channel_takeout" -> Routes.M_TAKEOUT
                        t.kind == "channel_booking" -> Routes.M_BOOKING
                        t.kind == "vip_birthday" -> Routes.M_VIP
                        t.kind == "equipment_over" -> Routes.M_EQUIPMENT
                        t.displayText().contains("补货") || t.displayText().contains("断货") ->
                            Routes.INVENTORY_RESTOCK
                        t.displayText().contains("工单") || t.displayText().contains("备料") ->
                            Routes.KITCHEN
                        t.displayText().contains("生日") || t.displayText().contains("发券") ->
                            Routes.M_VIP
                        t.displayText().contains("超温") || t.displayText().contains("冷柜") ->
                            Routes.M_EQUIPMENT
                        t.displayText().contains("外卖") -> Routes.M_TAKEOUT
                        t.displayText().contains("预订") -> Routes.M_BOOKING
                        else -> Routes.M_ACTIONS
                    }
                    val actionLabel = when {
                        jump == Routes.M_VIP -> "去发券"
                        jump == Routes.INVENTORY_RESTOCK -> "确认"
                        jump == Routes.M_EQUIPMENT -> "核查"
                        else -> "去处理"
                    }
                    SwipeTodoRow(
                        title = t.displayText().ifBlank { "待办" },
                        detail = listOfNotNull(t.desc, t.amount).joinToString(" · ")
                            .ifBlank {
                                when (t.kind) {
                                    "restock" -> "去补货确认"
                                    "prep" -> "去厨房备料"
                                    "channel_takeout" -> "去处理外卖"
                                    "channel_booking" -> "去确认预订"
                                    "vip_birthday" -> "储值/普通会员发券"
                                    "equipment_over" -> "冷柜超温请立即核查"
                                    else -> "去处理"
                                }
                            },
                        action = actionLabel,
                        onAction = {
                            when (jump) {
                                Routes.M_VIP -> ModuleEntry.open(3)
                                Routes.M_EQUIPMENT -> ModuleEntry.open(0)
                                else -> Unit
                            }
                            openModule(jump)
                        },
                        onConfirm = {
                            when {
                                jump == Routes.INVENTORY_RESTOCK || t.kind == "restock" -> {
                                    val pack = invState.restock
                                        .filter {
                                            it.urgency.equals("critical", true) ||
                                                it.urgency?.contains("急") == true
                                        }
                                        .ifEmpty { invState.restock.take(8) }
                                    if (pack.isNotEmpty() && AppModule.canWrite()) {
                                        askRestockConfirm(
                                            pack,
                                            invState.rev,
                                            suppliers = (invState.vendors.map { it.name } + invState.suppliers).distinct(),
                                            quotes = invState.quotes
                                        ) { ok, msg ->
                                            Toast.makeText(context, msg, Toast.LENGTH_SHORT).show()
                                            if (ok) openModule(Routes.INVENTORY_PURCHASE)
                                        }
                                    } else {
                                        openModule(jump)
                                    }
                                }
                                jump == Routes.M_VIP -> ModuleEntry.open(3)
                                jump == Routes.M_EQUIPMENT -> ModuleEntry.open(0)
                                else -> openModule(jump)
                            }
                        },
                        onDismiss = {
                            // 仅划走不消待办；真正执行后由 OpsSignal.afterConfirm 消项
                        }
                    )
                }
            }
        }

        // 午晚一眼：倒计时 / 负荷 / 桌位 / 外卖（深链到店务模块）
        run {
            val now = LocalTime.now()
            val lunch = LocalTime.of(11, 30)
            val dinner = LocalTime.of(17, 30)
            val target = when {
                now.isBefore(lunch) -> lunch
                now.isBefore(dinner) -> dinner
                else -> lunch
            }
            var mins = java.time.Duration.between(now, target).toMinutes()
            if (mins < 0) mins += 24 * 60
            val hrs = String.format(Locale.CHINA, "%02d:%02d", mins / 60, mins % 60)
            val peak = heatMini.maxOfOrNull { it.orders ?: 0 } ?: 0
            val curHeat = heatMini.filter { (it.hour ?: -1) == now.hour }.sumOf { it.orders ?: 0 }
            val loadPct = if (peak > 0) ((curHeat.toDouble() / peak) * 100).roundToInt().coerceIn(0, 100) else null
            val bookingSnap = modulesState.booking
            val tables = invState.posTables
            val tablesBusy = tables.count { it.state == "busy" || it.state == "就餐" }
            val tablesTotal = tables.size
            val meituan = modulesState.takeout?.platforms
                ?.firstOrNull { it.name?.contains("美团") == true }
                ?.amount
            PandaCard {
                CardHeader("门店状态", more = "前厅 ›") { openModule(Routes.FRONT) }
                Text("开餐倒计时与桌位占用，午晚高峰用。", fontSize = 11.sp, color = Sub)
                Spacer(Modifier.height(6.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatusCell("开餐倒计时", hrs, Modifier.weight(1f))
                    StatusCell("厨房负荷", loadPct?.let { "$it%" } ?: "暂无数据", Modifier.weight(1f))
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatusCell(
                        "桌位占用",
                        if (tablesTotal > 0) "$tablesBusy/$tablesTotal 桌" else "暂无桌台数据",
                        Modifier
                            .weight(1f)
                            .clickable { openModule(Routes.M_POS) }
                    )
                    StatusCell(
                        "美团待结算",
                        meituan?.let { "¥${it.toInt()}" } ?: "—",
                        Modifier
                            .weight(1f)
                            .clickable { openModule(Routes.M_TAKEOUT) }
                    )
                }
            }
        }

        // 预订 / 排队（真数据，有才显示）
        val bookingHome = modulesState.booking
        if (bookingHome != null && (bookingHome.bookings.isNotEmpty() || bookingHome.queue.isNotEmpty())) {
            PandaCard {
                CardHeader("预订 / 排队", more = "详情 ›") {
                    openModule(Routes.M_BOOKING)
                }
                Text("堂食客流与叫号，详情在预订模块。", fontSize = 11.sp, color = Sub)
                Spacer(Modifier.height(4.dp))
                ProtoKv("今日预订", "${bookingHome.bookings.size} 桌 / ${bookingHome.bookings.sumOf { it.partySize ?: 0 }} 人")
                val waitingQueue = bookingHome.queue.filter {
                    val s = it.status.orEmpty()
                    !s.contains("就餐") && !s.contains("完成") && !s.contains("取消") && !s.contains("入座")
                }
                ProtoKv(
                    "当前排队",
                    if (waitingQueue.isEmpty()) "无人排队"
                    else "${waitingQueue.size} 组待叫",
                    valueColor = if (waitingQueue.isNotEmpty()) FiveRed else Txt
                )
            }
        }

        // 打烊日清：售出 / 入库 / 报损 → 点进单据列表
        val dayClose = report?.dayClose
        if (dayClose != null) {
            PandaCard {
                val openWo = dayClose.workordersOpen ?: 0
                CardHeader(
                    "今日进销损",
                    more = if (openWo > 0) "未完工单 $openWo ›" else "单据 ›"
                ) {
                    openModule(if (openWo > 0) Routes.KITCHEN else Routes.INVENTORY_RECV)
                }
                Text(
                    BossIa.Home.LEDGER_HINT,
                    fontSize = 11.sp,
                    color = Sub,
                    modifier = Modifier.padding(bottom = 6.dp)
                )
                listOf(
                    Triple(dayClose.sold, "售出", Routes.M_POS),
                    Triple(dayClose.inbound, "入库", Routes.INVENTORY_RECV),
                    Triple(dayClose.loss, "报损", Routes.M_LOSS)
                ).forEach { (line, fallback, defaultRoute) ->
                    val label = line?.label?.ifBlank { null } ?: fallback
                    val count = line?.count ?: 0
                    val amount = line?.amount ?: 0.0
                    val route = line?.route?.ifBlank { null } ?: defaultRoute
                    val jump = when {
                        route.startsWith("inventory") -> when {
                            route.contains("recv") -> Routes.INVENTORY_RECV
                            route.contains("restock") -> Routes.INVENTORY_RESTOCK
                            route.contains("purchase") -> Routes.INVENTORY_PURCHASE
                            else -> Routes.INVENTORY
                        }
                        route == "m/pos" || route.endsWith("/pos") -> Routes.M_POS
                        route == "m/loss" || route.contains("loss") -> Routes.M_LOSS
                        route.contains("kitchen") -> Routes.KITCHEN
                        else -> defaultRoute
                    }
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .clickable { openModule(jump) }
                            .padding(vertical = 8.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(label, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = Txt)
                            Text(
                                when (fallback) {
                                    "售出" -> "销售/结账单"
                                    "入库" -> "进货入库单"
                                    else -> "报损单"
                                },
                                fontSize = 11.sp,
                                color = Sub
                            )
                        }
                        Text(
                            "${count}笔 · ¥${String.format(Locale.CHINA, "%.0f", amount)}",
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                            color = when (fallback) {
                                "报损" -> if (count > 0) FiveRed else Txt
                                "入库" -> FiveGreen
                                else -> Ink
                            }
                        )
                        Text(" ›", fontSize = 14.sp, color = Sub)
                    }
                }
                if (AppModule.canWrite()) {
                    val warn = if (openWo > 0) "（仍有 $openWo 张未完工单）" else ""
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .padding(top = 8.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(Ink)
                            .clickable {
                                ConfirmBus.ask(
                                    ConfirmRequest(
                                        title = "确认打烊日清",
                                        summary = "售出 ${dayClose.sold?.count ?: 0}笔¥${dayClose.sold?.amount ?: 0} · " +
                                            "入库 ${dayClose.inbound?.count ?: 0} · 报损 ${dayClose.loss?.count ?: 0}" +
                                            warn,
                                        type = "day.close",
                                        payload = buildJsonObject {
                                            put("sold_count", dayClose.sold?.count ?: 0)
                                            put("sold_amount", dayClose.sold?.amount ?: 0.0)
                                            put("inbound_count", dayClose.inbound?.count ?: 0)
                                            put("inbound_amount", dayClose.inbound?.amount ?: 0.0)
                                            put("loss_count", dayClose.loss?.count ?: 0)
                                            put("loss_amount", dayClose.loss?.amount ?: 0.0)
                                            put("workorders_open", openWo)
                                            put("note", "老板确认打烊")
                                        },
                                        baseRev = report?.revText()?.ifBlank { null } ?: invState.rev,
                                        onResult = { r ->
                                            Toast.makeText(
                                                context,
                                                r.fold({ "打烊已确认 · 财务日清已登记" }, { it.message ?: "失败" }),
                                                Toast.LENGTH_SHORT
                                            ).show()
                                        }
                                    )
                                )
                            }
                            .padding(vertical = 12.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            "确认打烊日清$warn",
                            color = Color.White,
                            fontWeight = FontWeight.ExtraBold,
                            fontSize = 14.sp
                        )
                    }
                }
            }
        }


        // L1·启发：钱/批/办/看店之后再给 AI 简报（细报在经营分析，细问在 AI Tab）
        run {
            val kpis = report?.kpi.orEmpty().filter { isBossKpi(it.label) }.ifEmpty {
                report?.kpi.orEmpty().filter {
                    !it.label.contains("rev", true) &&
                        !it.label.contains("快照") &&
                        !it.label.contains("记录")
                }
            }.filterNot { it.label.contains("营收") } // 顶栏已有营收
            val forecast = modulesState.analysis?.forecast
            val matrixTop = modulesState.analysis?.matrix
                ?.sortedByDescending { it.volume ?: 0.0 }
                ?.take(3)
                .orEmpty()
            val heat = heatMini
            val hasGlance = kpis.isNotEmpty() || matrixTop.isNotEmpty() || heat.isNotEmpty() ||
                forecast?.days?.any { it.pred != null } == true
            if (hasGlance) {
                PandaCard {
                    CardHeader("经营提示 · AI", more = "经营分析 ›") {
                        openModule(Routes.M_ANALYSIS)
                    }
                    Text(
                        BossIa.Home.AI_CARD_HINT,
                        fontSize = 11.sp,
                        color = Sub
                    )
                    if (heat.isNotEmpty()) {
                        Spacer(Modifier.height(10.dp))
                        Text("时段热力", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = Ink)
                        Spacer(Modifier.height(4.dp))
                        val pairs = (0 until 12).map { slot ->
                            val h0 = slot * 2
                            val o = heat.filter { (it.hour ?: -1) in h0 until (h0 + 2) }.sumOf { it.orders ?: 0 }
                            h0 to o
                        }
                        HeatMiniBar(pairs)
                        Text("关注午晚高峰 · AI 读单量", fontSize = 10.sp, color = Sub)
                    }
                    val nextForecast = forecast?.days?.firstOrNull { it.pred != null }
                    if (nextForecast != null) {
                        Spacer(Modifier.height(10.dp))
                        Text("经营预测 · ${nextForecast.date ?: "近期"}", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = Ink)
                        Text(
                            "仅展示服务端预测 · 备货仍需到「货品」确认",
                            fontSize = 10.sp,
                            color = Sub
                        )
                        Spacer(Modifier.height(4.dp))
                        KpiGrid(
                            items = listOf(
                                Triple(
                                    "预计营收",
                                    "¥${String.format(Locale.CHINA, "%,.0f", nextForecast.pred)}",
                                    forecast.confidence?.let { "置信度 $it%" }
                                ),
                                Triple("保守估计", nextForecast.cons?.let { "¥${String.format(Locale.CHINA, "%,.0f", it)}" } ?: "暂无", null),
                                Triple("乐观估计", nextForecast.opt?.let { "¥${String.format(Locale.CHINA, "%,.0f", it)}" } ?: "暂无", null)
                            ),
                            columns = 2
                        )
                        forecast.note?.let {
                            Text(it, fontSize = 11.sp, color = Sub, modifier = Modifier.padding(top = 4.dp))
                        }
                        forecast.restock.take(2).forEach { r ->
                            Text(
                                "备货启发 ${r.name} ${r.pred}${r.unit ?: ""} · ${r.badge ?: "AI"}",
                                fontSize = 11.sp,
                                color = AiPink,
                                modifier = Modifier.padding(top = 2.dp)
                            )
                        }
                    }
                    if (matrixTop.isNotEmpty()) {
                        val maxVol = (matrixTop.firstOrNull()?.volume ?: 1.0).coerceAtLeast(1.0)
                        val five = listOf(
                            Triple("红", FiveRed, listOf(Color(0xFFFFB6B0), FiveRed)),
                            Triple("黑", FiveBlack, listOf(Color(0xFF999AAA), FiveBlack)),
                            Triple("黄", FiveYellow, listOf(Color(0xFFFFE08A), FiveYellow)),
                            Triple("绿", FiveGreen, listOf(Color(0xFFA8DCA8), FiveGreen)),
                            Triple("紫", FivePurple, listOf(Color(0xFFD4B8E8), FivePurple))
                        )
                        Spacer(Modifier.height(10.dp))
                        Text("热销 TOP3", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = Ink)
                        Spacer(Modifier.height(4.dp))
                        matrixTop.forEachIndexed { idx, m ->
                            val (tag, color, bars) = five[idx % five.size]
                            val vol = m.volume ?: 0.0
                            FiveSaleRow(
                                tag = tag,
                                tagBg = color,
                                name = m.name ?: "菜品",
                                count = "${vol.toInt()}份",
                                pct = (vol / maxVol).toFloat().coerceIn(0.08f, 1f),
                                barColors = bars
                            )
                        }
                    }
                }
            }
        }



        PandaCard {
            CardHeader("店务与设置", more = "我的 ›") {
                openModule(Routes.MORE)
            }
            Text(
                BossIa.Tab.MINE_BOUNDARY + " · " + BossIa.Home.SETTINGS_HINT,
                fontSize = 12.sp,
                color = Sub
            )
        }

        Text(
            "下拉或点此刷新",
            fontSize = 11.sp,
            color = Sub,
            fontWeight = FontWeight.Medium,
            modifier = Modifier
                .align(Alignment.CenterHorizontally)
                .clickable {
                    viewModel.dispatch(HomeViewModel.HomeIntent.Refresh)
                    modulesVm.dispatch(com.pandawufu.shared.viewmodel.ModulesViewModel.Intent.LoadBooking())
                    modulesVm.dispatch(com.pandawufu.shared.viewmodel.ModulesViewModel.Intent.LoadAnalysis)
                    modulesVm.dispatch(com.pandawufu.shared.viewmodel.ModulesViewModel.Intent.LoadTakeout)
                }
                .padding(8.dp)
        )
    }
}

@Composable
private fun StatusCell(label: String, value: String, modifier: Modifier = Modifier) {
    Column(
        modifier
            .clip(RoundedCornerShape(14.dp))
            .background(Color(0xFFF7F8FB))
            .padding(12.dp)
    ) {
        Text(label, fontSize = 11.sp, color = Sub)
        Text(value, fontSize = 18.sp, fontWeight = FontWeight.ExtraBold, color = Ink)
    }
}

private fun greetHello(): String {
    val h = LocalTime.now().hour
    return when {
        h < 11 -> "早上好"
        h < 14 -> "中午好"
        h < 18 -> "下午好"
        else -> "晚上好"
    }
}

private fun minutesSince(iso: String?): Long? {
    if (iso.isNullOrBlank()) return null
    return try {
        val t = Instant.parse(iso)
        (Instant.now().toEpochMilli() - t.toEpochMilli()) / 60_000
    } catch (_: DateTimeParseException) {
        try {
            val t = Instant.parse(iso + "Z")
            (Instant.now().toEpochMilli() - t.toEpochMilli()) / 60_000
        } catch (_: Exception) {
            null
        }
    }
}

/** 解析日报 KPI 金额字符串 → 元 */
private fun parseMoneyYuan(raw: String?): Double? {
    if (raw.isNullOrBlank() || raw == "—") return null
    var s = raw.replace("¥", "").replace("￥", "").replace(",", "").replace(" ", "").trim()
    if (s.isEmpty()) return null
    val mult = when {
        s.endsWith("万") -> { s = s.removeSuffix("万"); 10000.0 }
        s.endsWith("k") || s.endsWith("K") -> { s = s.dropLast(1); 1000.0 }
        else -> 1.0
    }
    return s.toDoubleOrNull()?.times(mult)
}

private fun withMetricUnit(value: String, unit: String): String {
    if (value.isBlank() || value == "—" || unit.isBlank()) return value
    return if (value.endsWith(unit)) value else "$value$unit"
}
