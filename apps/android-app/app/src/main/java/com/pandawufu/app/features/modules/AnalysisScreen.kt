package com.pandawufu.app.features.modules

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import android.widget.Toast
import com.pandawufu.app.AppModule
import com.pandawufu.app.confirm.ConfirmBus
import com.pandawufu.app.confirm.ConfirmRequest
import com.pandawufu.app.ui.designsystem.AiPink
import com.pandawufu.app.ui.designsystem.DualSparkline
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FivePurple
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.FiveYellow
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.PageBg
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.model.AnalysisForecastRestockDto
import com.pandawufu.shared.model.AnalysisHeatDto
import com.pandawufu.shared.model.AnalysisMatrixDto
import com.pandawufu.shared.viewmodel.ModulesViewModel
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.Locale
import kotlin.math.max

/** 对应原型 p-m-analysis：趋势 / 时段 / 矩阵 / 保本 / 效率 / AI 销量预测 */
@Composable
fun AnalysisScreen() {
    val viewModel = remember { ModulesViewModel(AppModule.modulesRepository) }
    val state by viewModel.state.collectAsState()
    var tab by remember { mutableIntStateOf(0) }
    val pills = listOf("营收", "时段", "菜品", "保本", "效率", "预测")

    LaunchedEffect(Unit) {
        AppModule.ensureSession()
        viewModel.dispatch(ModulesViewModel.Intent.LoadAnalysis)
    }

    val a = state.analysis
    val context = LocalContext.current
    ModuleScaffold(
        title = "经营分析",
        subtitle = if (a?.mock == true) "暂无销售流水 · 推送后生成" else when (tab) {
            0 -> "日营收趋势"
            1 -> "时段 × 星期热力"
            2 -> "菜品波士顿矩阵"
            3 -> "保本价盘与结构"
            4 -> "人效 / 坪效"
            else -> "AI 销量与补货启发"
        },
        loading = state.loading && a == null,
        error = state.error,
        hint = state.emptyHint,
        onRetry = { viewModel.dispatch(ModulesViewModel.Intent.LoadAnalysis) },
        pills = pills,
        selectedPill = tab,
        onPill = { tab = it }
    ) {
        if (a?.mock == true) {
            Text("店内暂无销售流水，暂不生成分析", color = FiveYellow, fontSize = 12.sp)
        }
        a?.note?.let { Text(it, color = Sub, fontSize = 12.sp) }

        when (tab) {
            0 -> {
                val list = a?.trend.orEmpty()
                val series = list.mapNotNull { it.revenue?.toFloat() }.takeLast(14)
                ModuleCard("营收趋势（${list.size} 日）") {
                    if (list.isEmpty()) Text("暂无趋势", color = Sub, fontSize = 12.sp)
                    else {
                        if (series.size >= 2) DualSparkline(series)
                        list.takeLast(14).forEach { t ->
                            KvRow(
                                t.date ?: t.week ?: "-",
                                "¥${t.revenue ?: 0}" + (t.orders?.let { " · ${it} 单" } ?: "")
                            )
                        }
                    }
                }
                ModuleCard("AI 下周建议") {
                    Text(
                        "① 高峰菜品前置主推；② 洼地日可设套餐；③ 雨天/降温热汤点单偏强。详情见「AI 预测」。",
                        fontSize = 12.sp,
                        color = Sub
                    )
                    Text(
                        "打开 AI 销量预测 ›",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                        color = AiPink,
                        modifier = Modifier
                            .padding(top = 8.dp)
                            .clickable { tab = 5 }
                    )
                    if (AppModule.canWrite()) {
                        Text(
                            "导出本周经营周报 ›",
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Bold,
                            color = Ink,
                            modifier = Modifier
                                .padding(top = 10.dp)
                                .clickable {
                                    val days = list.size.coerceAtLeast(7)
                                    val revSum = list.takeLast(7).sumOf { it.revenue ?: 0.0 }
                                    ConfirmBus.ask(
                                        ConfirmRequest(
                                            title = "导出经营周报",
                                            summary = "近 $days 日 · 近7日营收 ¥${"%.0f".format(revSum)} → 店内文档草案",
                                            type = "analysis.export_week",
                                            payload = buildJsonObject {
                                                put("title", "经营周报")
                                                put("note", "近7日营收 ¥${"%.0f".format(revSum)} · ${list.size} 日趋势")
                                                put("revenue_7d", revSum)
                                                put("days", days)
                                            },
                                            baseRev = a?.rev?.toString(),
                                            onResult = { r ->
                                                Toast.makeText(
                                                    context,
                                                    if (r.isSuccess) "已入队：经营周报" else r.exceptionOrNull()?.message ?: "失败",
                                                    Toast.LENGTH_SHORT
                                                ).show()
                                            }
                                        )
                                    )
                                }
                        )
                    }
                }
            }
            1 -> ModuleCard("时段热力（24h × 7天）") {
                val list = a?.heatmap.orEmpty()
                if (list.isEmpty()) Text("暂无热力", color = Sub, fontSize = 12.sp)
                else {
                    HeatmapGrid(list)
                    Text("谷 → 峰 · 午 11:30 / 晚 18:30", color = Sub, fontSize = 11.sp)
                    list.groupBy { it.hour }.entries.sortedBy { it.key }.take(8).forEach { (h, rows) ->
                        val orders = rows.sumOf { it.orders ?: 0 }
                        KvRow("${h ?: "-"}:00", "$orders 单")
                    }
                }
            }
            2 -> {
                val list = a?.matrix.orEmpty()
                ModuleCard("波士顿菜单矩阵（${list.size}）") {
                    if (list.isEmpty()) Text("暂无矩阵", color = Sub, fontSize = 12.sp)
                    else {
                        MatrixLegend(list)
                        list.sortedByDescending { it.volume ?: 0.0 }.take(15).forEach { m ->
                            MatrixDishRow(
                                m = m,
                                baseRev = a?.rev?.toString(),
                                onDone = { viewModel.dispatch(ModulesViewModel.Intent.LoadAnalysis) }
                            )
                        }
                    }
                }
            }
            3 -> {
                val bb = a?.baobenSummary
                val types = a?.baobenTypes?.takeIf { it.isNotEmpty() } ?: bb?.types.orEmpty()
                val star = types.find { it.k == "爆品" }
                val traffic = types.find { it.k == "引流" }
                ModuleCard("保本线 · 价盘测算（非今日实收）") {
                    if (bb?.kpi == null) Text("暂无保本测算", color = Sub, fontSize = 12.sp)
                    else {
                        val k = bb.kpi!!
                        KvRow("理论日保本", k.beDay?.let { "¥${"%.0f".format(it)}" } ?: "-")
                        KvRow("价盘日菜品营收", k.dayDishRev?.let { "¥${"%.0f".format(it)}" } ?: "-")
                        KvRow("安全边际", k.safety?.let { "${"%.0f".format(it)}%" } ?: "-")
                        KvRow("月利润(理论)", k.monthProfit?.let { "¥${"%.0f".format(it)}" } ?: "-")
                        KvRow("保本客流", k.beGuests?.let { "${"%.0f".format(it)} 人/天" } ?: "-")
                    }
                }
                ModuleCard("类型结构 · 营收 vs 毛利") {
                    if (types.isEmpty()) Text("暂无类型", color = Sub, fontSize = 12.sp)
                    types.forEach { t ->
                        KvRow(
                            "${t.k ?: t.name} ${t.n ?: 0}道",
                            "营收${"%.0f".format(t.revShare ?: 0.0)}% · 毛利${"%.0f".format(t.gpShare ?: 0.0)}%"
                        )
                    }
                }
                ModuleCard("可执行建议") {
                    Text(
                        when {
                            star != null && (star.revShare ?: 0.0) >= 35 ->
                                "爆品贡献营收 ${"%.0f".format(star.revShare ?: 0.0)}%，建议收银默认置顶爆品，保证供应。"
                            traffic != null && (traffic.revShare ?: 0.0) >= 20 ->
                                "引流占比偏高（${"%.0f".format(traffic.revShare ?: 0.0)}%），建议推爆品抬客单。"
                            else -> "可把收银默认分类切到「爆品」，午高峰优先推招牌。"
                        },
                        fontSize = 12.sp,
                        color = Sub
                    )
                    Text(
                        "确认：收银点菜默认「爆品」",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                        color = Ink,
                        modifier = Modifier
                            .padding(top = 8.dp)
                            .clickable {
                                ConfirmBus.ask(
                                    ConfirmRequest(
                                        title = "推爆品置顶收银",
                                        summary = "将收银「点菜」默认分类设为「爆品」（本机生效，不改价盘）。",
                                        type = "config.update",
                                        payload = buildJsonObject {
                                            put("key", "pos.default_cat")
                                            put("value", "爆品")
                                            put("scope", "device")
                                        },
                                        baseRev = a?.rev?.toString(),
                                        onResult = { r ->
                                            r.fold(
                                                onSuccess = {
                                                    AppModule.modulePrefs.setPosDefaultCat("爆品")
                                                    Toast.makeText(context, "已置顶爆品 · 打开收银点菜可见", Toast.LENGTH_SHORT).show()
                                                },
                                                onFailure = {
                                                    AppModule.modulePrefs.setPosDefaultCat("爆品")
                                                    Toast.makeText(context, "本机已置顶爆品（云端配置可后补）", Toast.LENGTH_SHORT).show()
                                                }
                                            )
                                        }
                                    )
                                )
                            }
                    )
                }
                bb?.advice?.take(2)?.forEach { adv ->
                    Text(adv, color = Sub, fontSize = 12.sp)
                }
            }
            4 -> {
                val e = a?.efficiency
                ModuleCard("效率指标 · 全周期") {
                    if (e == null) Text("暂无效率", color = Sub, fontSize = 12.sp)
                    else {
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceEvenly
                        ) {
                            EffRing(
                                "翻台率",
                                e.turnover?.let { "${"%.1f".format(it)}" } ?: "—",
                                FiveGreen
                            )
                            EffRing(
                                "坪效/㎡",
                                e.revenuePerSqm?.let { "¥${"%.0f".format(it)}" } ?: "—",
                                FiveYellow
                            )
                            EffRing(
                                "人效/人",
                                e.revenuePerStaff?.let { "¥${"%.0f".format(it)}" } ?: "—",
                                FivePurple
                            )
                        }
                        KvRow("客单价", e.avgTicket?.let { "¥${"%.2f".format(it)}" } ?: "-")
                        KvRow("日均营收", e.dailyAvgRevenue?.let { "¥${"%.0f".format(it)}" } ?: "-")
                        KvRow("订单量", "${e.totalOrders ?: "-"}")
                        KvRow(
                            "口径",
                            "面积 ${e.area?.let { "%.0f".format(it) } ?: "-"}㎡ · 员工 ${e.staff?.let { "%.0f".format(it) } ?: "-"} 人 · 桌位 ${e.tables ?: 0} 张"
                        )
                        if (e.turnover == null) {
                            Text("翻台率需桌位/座位参数（我的餐厅·经营 可配）", color = FiveYellow, fontSize = 11.sp)
                        }
                    }
                }
                ModuleCard("同环比 · 真实口径") {
                    val c = a?.compare
                    if (c == null) Text("样本不足", color = Sub, fontSize = 12.sp)
                    else {
                        KvRow("周环比（近7日 vs 前7日）", pctText(c.wowRevPct))
                        KvRow("月环比（近30 vs 前30）", pctText(c.momRevPct))
                        KvRow("同比（近30 vs 去年同期）", c.yoyRevPct?.let { pctText(it) } ?: "样本不足（需 ≥1 年流水）")
                        KvRow(
                            "近7日 / 前7日营收",
                            "¥${"%.0f".format(c.last7Rev ?: 0.0)} / ¥${"%.0f".format(c.prev7Rev ?: 0.0)}"
                        )
                        Text("基于 ${c.days ?: 0} 个营业日真实流水计算", color = Sub, fontSize = 11.sp)
                    }
                }
                ModuleCard("天气 / 节假日关联") {
                    val hol = a?.forecast?.holidays.orEmpty()
                    if (hol.isEmpty()) {
                        Text("未接入天气数据源；接入后可由 SI 关联时段与品类。", color = Sub, fontSize = 12.sp)
                    } else {
                        hol.take(4).forEach { h -> KvRow(h.label ?: "-", h.effect ?: "-") }
                    }
                }
            }
            else -> ForecastTab(
                a = a,
                onToast = { ok, msg ->
                    Toast.makeText(context, msg, Toast.LENGTH_SHORT).show()
                    if (ok) viewModel.dispatch(ModulesViewModel.Intent.LoadAnalysis)
                }
            )
        }
    }
}

@Composable
private fun ForecastTab(
    a: com.pandawufu.shared.model.AnalysisModuleDto?,
    onToast: (Boolean, String) -> Unit
) {
    val fc = a?.forecast
    ModuleCard("未来 7 天销量预测 · AI") {
        if (fc == null) {
            Text("暂无预测数据", color = Sub, fontSize = 12.sp)
            return@ModuleCard
        }
        KvRow("置信度", "${fc.confidence ?: 90}% · 区间随置信度变化")
        val series = fc.days.mapNotNull { it.pred?.toFloat() }
        if (series.size >= 2) DualSparkline(series)
        fc.peak?.let { p ->
            Text(
                "峰值日 ${p.date} · 上界¥${p.opt?.toInt() ?: "-"} / 预测¥${p.pred?.toInt() ?: "-"} / 下界¥${p.cons?.toInt() ?: "-"}",
                fontSize = 11.sp,
                color = FivePurple,
                fontWeight = FontWeight.Bold
            )
        }
        fc.days.take(7).forEach { d ->
            KvRow(
                d.date ?: "-",
                "预测 ¥${d.pred?.toInt() ?: "-"} · 乐观 ${d.opt?.toInt() ?: "-"} · 保守 ${d.cons?.toInt() ?: "-"}"
            )
        }
        Text(fc.note ?: "预测≠下单，转采购需确认。", color = Sub, fontSize = 11.sp)
    }
    ModuleCard("天气-销量关联系数") {
        val rows = fc?.weatherCoef.orEmpty()
        if (rows.isEmpty()) Text("暂无系数", color = Sub, fontSize = 12.sp)
        rows.forEach { w ->
            KvRow(
                w.weather ?: "-",
                "红${w.red} 黑${w.black} 黄${w.yellow} 绿${w.green} 白${w.white}"
            )
        }
    }
    ModuleCard("节假日效应") {
        val list = fc?.holidays.orEmpty()
        if (list.isEmpty()) Text("暂无标注", color = Sub, fontSize = 12.sp)
        list.forEach { h -> KvRow(h.label ?: "-", h.effect ?: "-") }
    }
    ModuleCard("AI 备货建议清单") {
        val items = fc?.restock.orEmpty()
        if (items.isEmpty()) Text("暂无备货建议", color = Sub, fontSize = 12.sp)
        items.forEach { item ->
            ForecastRestockRow(item = item, baseRev = a?.rev?.toString(), onToast = onToast)
        }
        Text("⚠ 备货建议由 AI 生成，预测≠下单。转采购后进采购管理。", color = Sub, fontSize = 11.sp)
    }
}

@Composable
private fun ForecastRestockRow(
    item: AnalysisForecastRestockDto,
    baseRev: String?,
    onToast: (Boolean, String) -> Unit
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(
                "${item.name ?: "-"} · 备货区间",
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
                color = Ink,
                modifier = Modifier.weight(1f)
            )
            Text("¥${item.amount?.toInt() ?: "-"}", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = FiveRed)
        }
        Text(
            "保守 ${fmtQty(item.cons)} / 预测 ${fmtQty(item.pred)} / 乐观 ${fmtQty(item.opt)} ${item.unit ?: ""}" +
                (item.qty?.let { " · 现库 $it${item.unit ?: ""}" } ?: ""),
            fontSize = 11.sp,
            color = Sub
        )
        item.badge?.let { Text(it, fontSize = 11.sp, color = AiPink, fontWeight = FontWeight.Bold) }
        if (AppModule.canWrite()) {
            Text(
                "转采购",
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
                color = Color.White,
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .background(AiPink)
                    .clickable {
                        val qty = item.pred ?: item.cons ?: 1.0
                        ConfirmBus.ask(
                            ConfirmRequest(
                                title = "确认转采购",
                                summary = "AI 备货 ${item.name} × $qty${item.unit ?: ""} → 采购草稿（预测≠下单）",
                                type = "analysis.restock",
                                payload = buildJsonObject {
                                    put("note", "AI 销量预测转采购")
                                    put(
                                        "items",
                                        JsonArray(
                                            listOf(
                                                buildJsonObject {
                                                    put("name", item.name ?: "原料")
                                                    item.ingredientId?.let { put("ing_id", it); put("ingredientId", it) }
                                                    put("qty", qty)
                                                    put("unit", item.unit ?: "kg")
                                                    put("price", 0.0)
                                                }
                                            )
                                        )
                                    )
                                },
                                baseRev = baseRev,
                                onResult = { r ->
                                    r.fold(
                                        onSuccess = { onToast(true, "已提交采购草稿") },
                                        onFailure = { onToast(false, it.message ?: "失败") }
                                    )
                                }
                            )
                        )
                    }
                    .padding(horizontal = 12.dp, vertical = 6.dp)
            )
        }
    }
}

@Composable
private fun HeatmapGrid(list: List<AnalysisHeatDto>) {
    val hours = (10..21).toList()
    val maxO = max(1, list.maxOfOrNull { it.orders ?: 0 } ?: 1)
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            Box(Modifier.weight(0.35f))
            hours.forEach { h ->
                Text(
                    if (h % 3 == 0) "$h" else "",
                    fontSize = 8.sp,
                    color = Sub,
                    modifier = Modifier.weight(1f),
                    maxLines = 1
                )
            }
        }
        (1..7).forEach { wd ->
            val label = listOf("", "一", "二", "三", "四", "五", "六", "日")[wd]
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(label, fontSize = 10.sp, color = Sub, modifier = Modifier.weight(0.35f))
                hours.forEach { h ->
                    val o = list.filter { (it.weekday ?: -1) == (wd % 7) && it.hour == h }
                        .sumOf { it.orders ?: 0 }
                    val t = o.toFloat() / maxO
                    val c = when {
                        t <= 0.05f -> PageBg
                        t <= 0.35f -> Color(0xFFFBD3CC)
                        t <= 0.7f -> AiPink
                        else -> Color(0xFFC2185B)
                    }
                    Box(
                        Modifier
                            .weight(1f)
                            .height(12.dp)
                            .clip(RoundedCornerShape(2.dp))
                            .background(c)
                    )
                }
            }
        }
    }
}

@Composable
private fun MatrixLegend(list: List<AnalysisMatrixDto>) {
    val groups = list.groupBy { it.quadrant ?: "dog" }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        listOf(
            "star" to ("★ 明星" to FiveGreen),
            "puzzle" to ("? 问题" to FiveYellow),
            "cow" to ("¥ 金牛" to FivePurple),
            "dog" to ("瘦狗" to Sub)
        ).forEach { (q, pair) ->
            val names = groups[q].orEmpty().take(3).joinToString("/") { it.name ?: "" }
            Text(
                "${pair.first}：${names.ifBlank { "—" }}（${groups[q]?.size ?: 0}）",
                fontSize = 11.sp,
                color = pair.second,
                fontWeight = FontWeight.Bold
            )
        }
    }
}

private fun quadrantLabel(q: String?): String = when (q) {
    "star" -> "明星"
    "puzzle" -> "问题"
    "cow" -> "金牛"
    "dog" -> "瘦狗"
    else -> q ?: ""
}

/** 矩阵行：瘦狗/问题象限给「调价 + 下架」，明星（爆品）给「调价」；无写权限隐藏（同 WriteActionButton 显隐口径） */
@Composable
private fun MatrixDishRow(
    m: AnalysisMatrixDto,
    baseRev: String?,
    onDone: () -> Unit
) {
    val context = LocalContext.current
    var priceOpen by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        KvRow(
            listOfNotNull(m.dishType, m.name).joinToString(" · ").ifBlank { m.name ?: "-" },
            listOfNotNull(
                m.price?.let { "¥${"%.0f".format(it)}" },
                m.volume?.let { "日销${"%.0f".format(it)}" },
                m.margin?.let { "毛利${"%.0f".format(it * 100)}%" },
                quadrantLabel(m.quadrant)
            ).joinToString(" · ")
        )
        val q = m.quadrant ?: ""
        val canAdjust = q == "star" || q == "puzzle" || q == "dog"
        val canOff = q == "puzzle" || q == "dog"
        if (AppModule.canWrite() && (canAdjust || canOff)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(14.dp, Alignment.End)
            ) {
                if (canAdjust) {
                    Text(
                        "调价",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        color = Ink,
                        modifier = Modifier.clickable { priceOpen = true }
                    )
                }
                if (canOff) {
                    Text(
                        "下架",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        color = FiveRed,
                        modifier = Modifier.clickable {
                            ConfirmBus.ask(
                                ConfirmRequest(
                                    title = "下架 ${m.name ?: "菜品"}",
                                    summary = "矩阵「${quadrantLabel(q)}」象限 · ${m.name ?: "-"} 下架（确认后店内消费器执行）",
                                    type = "dish.set_active",
                                    payload = buildJsonObject {
                                        m.id?.let { put("id", it) }
                                        m.dishId?.let { put("dish_id", it) }
                                        m.name?.let { put("name", it) }
                                        put("on", false)
                                        put("active", false)
                                    },
                                    baseRev = baseRev,
                                    onResult = { r ->
                                        Toast.makeText(
                                            context,
                                            if (r.isSuccess) "已入队：下架 ${m.name ?: ""}"
                                            else r.exceptionOrNull()?.message ?: "失败",
                                            Toast.LENGTH_SHORT
                                        ).show()
                                        if (r.isSuccess) onDone()
                                    }
                                )
                            )
                        }
                    )
                }
            }
        }
    }
    if (priceOpen) {
        MatrixPriceDialog(
            m = m,
            baseRev = baseRev,
            onDismiss = { priceOpen = false },
            onDone = {
                priceOpen = false
                onDone()
            }
        )
    }
}

/** 调价：输入新价 + 原因 → ConfirmBus → dish.price（字段对齐 queue_consumer.apply_dish_price） */
@Composable
private fun MatrixPriceDialog(
    m: AnalysisMatrixDto,
    baseRev: String?,
    onDismiss: () -> Unit,
    onDone: () -> Unit
) {
    val context = LocalContext.current
    var priceText by remember { mutableStateOf(m.price?.let { "%.2f".format(it) } ?: "") }
    var reasonText by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("调价 · ${m.name ?: "菜品"}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "矩阵「${quadrantLabel(m.quadrant)}」象限 · 现售 ${m.price?.let { "¥${"%.2f".format(it)}" } ?: "-"}",
                    fontSize = 12.sp,
                    color = Sub
                )
                OutlinedTextField(
                    value = priceText,
                    onValueChange = { priceText = it },
                    label = { Text("新售价 ¥") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = reasonText,
                    onValueChange = { reasonText = it },
                    label = { Text("调价原因") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    val newPrice = priceText.trim().toDoubleOrNull()
                    if (newPrice == null || newPrice < 0) {
                        Toast.makeText(context, "请输入有效新售价", Toast.LENGTH_SHORT).show()
                        return@Button
                    }
                    val reason = reasonText.trim()
                    onDismiss()
                    ConfirmBus.ask(
                        ConfirmRequest(
                            title = "调价 ${m.name ?: "菜品"}",
                            summary = "${m.name ?: "-"} 售价 ${m.price?.let { "¥${"%.2f".format(it)}" } ?: "-"} → ¥${"%.2f".format(newPrice)}" +
                                (reason.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""),
                            type = "dish.price",
                            payload = buildJsonObject {
                                m.id?.let { put("id", it) }
                                m.dishId?.let { put("dish_id", it) }
                                m.name?.let { put("name", it) }
                                put("price", newPrice)
                                reason.takeIf { it.isNotBlank() }?.let { put("reason", it) }
                            },
                            baseRev = baseRev,
                            onResult = { r ->
                                Toast.makeText(
                                    context,
                                    if (r.isSuccess) "已入队：调价 ¥${"%.2f".format(newPrice)}"
                                    else r.exceptionOrNull()?.message ?: "失败",
                                    Toast.LENGTH_SHORT
                                ).show()
                                if (r.isSuccess) onDone()
                            }
                        )
                    )
                },
                shape = RoundedCornerShape(12.dp)
            ) { Text("下一步确认") }
        },
        dismissButton = {
            OutlinedButton(onClick = onDismiss) { Text("取消") }
        }
    )
}

private fun fmtQty(v: Double?): String =
    if (v == null) "-" else String.format(Locale.CHINA, if (v >= 10) "%.0f" else "%.1f", v)

private fun pctText(v: Double?): String {
    if (v == null) return "—"
    val s = if (v >= 0) "+" else ""
    return "$s${"%.1f".format(v)}%"
}

@Composable
private fun EffRing(label: String, value: String, color: Color) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier
                .size(56.dp)
                .clip(RoundedCornerShape(28.dp))
                .background(color.copy(alpha = 0.12f)),
            contentAlignment = Alignment.Center
        ) {
            Text(value, fontSize = 12.sp, fontWeight = FontWeight.ExtraBold, color = color)
        }
        Text(label, fontSize = 10.sp, color = Sub, modifier = Modifier.padding(top = 4.dp))
    }
}
