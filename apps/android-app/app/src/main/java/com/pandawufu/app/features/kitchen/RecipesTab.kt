package com.pandawufu.app.features.kitchen

import android.widget.Toast
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
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
import com.pandawufu.app.AppModule
import com.pandawufu.app.confirm.ConfirmBus
import com.pandawufu.app.confirm.ConfirmRequest
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.Line
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.model.BaobenSummaryDto
import com.pandawufu.shared.model.RecipeDto
import com.pandawufu.shared.viewmodel.KitchenViewModel
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.LocalDate
import java.util.Locale
import kotlin.math.roundToInt

// 菜谱 = 出品标准（厨师须遵照执行）：SOP 工序 + 标准 BOM；算料后可转工单/采购
@Composable
fun RecipesTab(
    state: KitchenViewModel.KitchenState,
    viewModel: KitchenViewModel,
    onOpenPurchase: () -> Unit = {},
    onGoWorkorders: () -> Unit = {}
) {
    var showEditor by remember { mutableStateOf(false) }
    var editTarget by remember { mutableStateOf<RecipeDto?>(null) }

    if (showEditor) {
        RecipeEditDialog(
            initial = editTarget,
            stock = state.stock,
            baseRev = state.rev,
            onDismiss = { showEditor = false; editTarget = null },
            onSubmitted = {
                viewModel.dispatch(KitchenViewModel.KitchenIntent.Refresh)
            }
        )
    }

    if (state.loading && state.recipes.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        return
    }
    if (state.recipes.isEmpty()) {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("暂无菜谱，可新增或确认厨房配方已推送", color = Sub)
                if (AppModule.canWrite()) {
                    ActionChip("新增菜谱", primary = true) {
                        viewModel.dispatch(KitchenViewModel.KitchenIntent.LoadStock)
                        editTarget = null
                        showEditor = true
                    }
                }
            }
        }
        return
    }

    val listState = rememberLazyListState()
    val selectedId = state.selectedRecipe?.skuId
    var menuFilter by remember { mutableStateOf("all") }
    val filtered = remember(state.recipes, menuFilter) {
        if (menuFilter == "all") state.recipes
        else state.recipes.filter { matchesMenuFilter(it, menuFilter) }
    }
    val catCounts = remember(state.recipes) {
        val keys = listOf(
            "all", "jiao5", "jiao_white", "jian", "zheng",
            "引流", "爆品", "利润", "形象", "常规"
        )
        keys.associateWith { key ->
            if (key == "all") state.recipes.size
            else state.recipes.count { matchesMenuFilter(it, key) }
        }
    }
    val grouped = filtered.groupBy { recipeGroupLabel(it) }

    LaunchedEffect(selectedId) {
        if (selectedId == null) return@LaunchedEffect
        var idx = 0
        for ((_, recipes) in grouped) {
            idx += 1
            for (r in recipes) {
                if (r.skuId == selectedId) {
                    listState.animateScrollToItem(idx.coerceAtLeast(0))
                    return@LaunchedEffect
                }
                idx += 1
                if (r.skuId == selectedId) idx += 1
            }
        }
    }

    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item(key = "menu-hdr") {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("出品标准 · 菜谱", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.ExtraBold)
                    Text("${filtered.size}/${state.recipes.size} 道", color = Sub, style = MaterialTheme.typography.bodySmall)
                }
                Text(
                    "厨师须按菜谱分量与工序执行；改标准走确认台。算料后可转工单或货品下单。",
                    color = Ink,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    "日常推进请回「工单」页；品控对照本页质检点抽检。",
                    color = Sub,
                    fontSize = 11.sp
                )
                if (AppModule.canWrite()) {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(Ink)
                            .clickable {
                                viewModel.dispatch(KitchenViewModel.KitchenIntent.LoadStock)
                                editTarget = null
                                showEditor = true
                            }
                            .padding(vertical = 12.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text("+ 新增菜谱 / 配料", color = CardBg, fontWeight = FontWeight.ExtraBold, fontSize = 14.sp)
                    }
                } else {
                    Text("只读账号不可新增菜谱；原料档案在「货品 · 产品库」", color = Sub, fontSize = 12.sp)
                }
                state.baobenSummary?.let { bb ->
                    BaobenKpiStrip(bb)
                }
                Text("价盘测算 · 非今日实收 · 金丰配方 ∪ 引流爆品利润形象常规", color = Sub, fontSize = 11.sp)
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    listOf(
                        "all" to "全部",
                        "jiao5" to "五色饺",
                        "jiao_white" to "本色白饺",
                        "jian" to "冰花煎饺",
                        "zheng" to "蒸饺",
                        "引流" to "引流",
                        "爆品" to "爆品",
                        "利润" to "利润",
                        "形象" to "形象",
                        "常规" to "常规"
                    ).forEach { (key, label) ->
                        val n = catCounts[key] ?: 0
                        if (key != "all" && n == 0) return@forEach
                        val on = menuFilter == key
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(16.dp))
                                .background(if (on) Ink else CardBg)
                                .then(if (!on) Modifier.border(1.dp, Line, RoundedCornerShape(16.dp)) else Modifier)
                                .clickable { menuFilter = key }
                                .padding(horizontal = 12.dp, vertical = 7.dp)
                        ) {
                            Text(
                                "$label $n",
                                color = if (on) CardBg else Ink,
                                style = MaterialTheme.typography.labelMedium,
                                fontWeight = FontWeight.Bold
                            )
                        }
                    }
                }
            }
        }
        grouped.forEach { (color, recipes) ->
            item(key = "hdr-$color") {
                Text("$color（${recipes.size}）", style = MaterialTheme.typography.titleMedium)
            }
            recipes.forEach { recipe ->
                item(key = recipe.skuId) {
                    RecipeRow(
                        recipe = recipe,
                        selected = recipe.skuId == selectedId,
                        onClick = {
                            if (selectedId == recipe.skuId) {
                                viewModel.dispatch(KitchenViewModel.KitchenIntent.CloseRecipe)
                            } else {
                                viewModel.dispatch(KitchenViewModel.KitchenIntent.SelectRecipe(recipe.skuId))
                            }
                        }
                    )
                }
                if (recipe.skuId == selectedId && state.selectedRecipe != null) {
                    item(key = "detail-${recipe.skuId}") {
                        RecipeDetailCard(
                            state = state,
                            sel = state.selectedRecipe!!,
                            viewModel = viewModel,
                            onClose = { viewModel.dispatch(KitchenViewModel.KitchenIntent.CloseRecipe) },
                            onScale = { viewModel.dispatch(KitchenViewModel.KitchenIntent.SetScaleQty(it)) },
                            onOpenPurchase = onOpenPurchase,
                            onGoWorkorders = onGoWorkorders,
                            onEdit = {
                                viewModel.dispatch(KitchenViewModel.KitchenIntent.LoadStock)
                                editTarget = state.selectedRecipe
                                showEditor = true
                            }
                        )
                    }
                }
            }
        }
    }
}

/** 店级保本线 + 类型营收/毛利结构（同源保本测算 HTML） */
@Composable
private fun BaobenKpiStrip(bb: BaobenSummaryDto) {
    val kpi = bb.kpi ?: return
    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = CardBg),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("理论日保本 · 价盘测算", color = Sub, style = MaterialTheme.typography.labelSmall)
                Text(
                    kpi.beDay?.let { "¥${"%.0f".format(it)}" } ?: "-",
                    color = FiveRed,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.ExtraBold
                )
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                KpiCell("日菜品营收", kpi.dayDishRev?.let { "¥${"%.0f".format(it)}" } ?: "-")
                KpiCell("安全边际", kpi.safety?.let { "${"%.0f".format(it)}%" } ?: "-")
                KpiCell("月利润", kpi.monthProfit?.let { "¥${"%.0f".format(it)}" } ?: "-")
            }
            if (bb.types.isNotEmpty()) {
                Text("类型结构 · 营收% / 毛利%", color = Sub, fontSize = 11.sp)
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    bb.types.forEach { t ->
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(10.dp))
                                .border(1.dp, Line, RoundedCornerShape(10.dp))
                                .padding(horizontal = 10.dp, vertical = 6.dp)
                        ) {
                            Column {
                                Text("${t.k ?: t.name ?: "-"} ${t.n ?: 0}", fontWeight = FontWeight.Bold, fontSize = 12.sp)
                                Text(
                                    "营${"%.0f".format(t.revShare ?: 0.0)}% · 毛${"%.0f".format(t.gpShare ?: 0.0)}%",
                                    color = Sub,
                                    fontSize = 10.sp
                                )
                            }
                        }
                    }
                }
            }
            bb.advice.firstOrNull()?.let {
                Text(it, color = Ink, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
private fun KpiCell(label: String, value: String) {
    Column {
        Text(label, color = Sub, fontSize = 10.sp)
        Text(value, fontWeight = FontWeight.Bold, fontSize = 13.sp)
    }
}

/** 金丰 cat 与保本类型各自可筛；挂了保本价的五色饺在「五色饺」和「爆品」里都能出现 */
private fun matchesMenuFilter(r: RecipeDto, key: String): Boolean {
    if (key in listOf("引流", "爆品", "利润", "形象", "常规")) {
        return (r.dishType ?: r.menuCat) == key
    }
    val cat = r.menuCat ?: guessMenuCat(r)
    return cat == key
}

private fun recipeGroupLabel(r: RecipeDto): String {
    val dt = r.dishType
    if (dt in listOf("引流", "爆品", "利润", "形象", "常规") && r.source == "baoben") {
        return "$dt · 保本"
    }
    return r.color ?: dt ?: "其他"
}

private fun guessMenuCat(r: RecipeDto): String = when (r.color) {
    "红", "黄", "绿", "紫", "黑" -> "jiao5"
    "白" -> "jiao_white"
    "煎" -> "jian"
    "蒸" -> "zheng"
    "引流", "爆品", "利润", "形象", "常规" -> r.color!!
    else -> r.dishType ?: "other"
}

@Composable
private fun RecipeRow(
    recipe: RecipeDto,
    selected: Boolean,
    onClick: () -> Unit
) {
    val cost = costPerPortionOf(recipe)
    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = CardBg),
        modifier = Modifier
            .fillMaxWidth()
            .animateContentSize(animationSpec = tween(220, easing = FastOutSlowInEasing))
            .clickable(onClick = onClick)
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(
                Modifier.size(34.dp).clip(CircleShape).background(colorOfFive(recipe.color)),
                contentAlignment = Alignment.Center
            ) {
                Text(recipe.color ?: "-", color = Color.White, style = MaterialTheme.typography.labelSmall)
            }
            Column(Modifier.weight(1f)) {
                Text(shortRecipeName(recipe.name), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
                Text(
                    recipe.subtitle?.takeIf { it.isNotBlank() }
                        ?: listOfNotNull(
                            recipe.faceMain?.let { color ->
                                when {
                                    color.contains("清水") && !color.contains("粉") && !color.contains("汁") && !color.contains("泥") ->
                                        "雪花粉+清水和面"
                                    else -> "雪花粉+$color"
                                }
                            },
                            recipe.blessing?.let { "寓意$it" }
                        ).joinToString(" · ").ifBlank { recipe.filling ?: "" },
                    style = MaterialTheme.typography.bodySmall,
                    color = Sub
                )
                if (selected) {
                    Text("点按收起 · 算料/缺料/转采购", color = Ink, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                val price = recipe.price
                val costVal = recipe.cost ?: cost
                if (price != null) {
                    Text("售¥${"%.0f".format(price)}", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
                    if (costVal != null) {
                        Text("成本¥${"%.1f".format(costVal)}", color = Sub, style = MaterialTheme.typography.labelSmall)
                    }
                    recipe.grossMargin?.let {
                        Text("毛利${"%.0f".format(it)}%", color = FiveGreenC, style = MaterialTheme.typography.labelSmall)
                    }
                } else if (costVal != null) {
                    Text("¥${"%.2f".format(costVal)}", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
                    Text("成本/份", color = Sub, style = MaterialTheme.typography.labelSmall)
                }
                (recipe.dishType ?: recipe.dietTags.firstOrNull())?.let { StatusTag(it, FiveGreenC) }
            }
        }
    }
}

@Composable
private fun RecipeDetailCard(
    state: KitchenViewModel.KitchenState,
    sel: RecipeDto,
    viewModel: KitchenViewModel,
    onClose: () -> Unit,
    onScale: (Int) -> Unit,
    onOpenPurchase: () -> Unit = {},
    onGoWorkorders: () -> Unit = {},
    onEdit: () -> Unit = {}
) {
    val context = LocalContext.current
    val scaled = scaleRecipeBom(sel, state.scaleQty)
    val shortages = matchShortages(scaled, state.stock)
    val shortageCount = shortages.count { it.shortage }
    val timeline = buildSopTimeline(state.selectedSteps)

    Card(
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = CardBg),
        modifier = Modifier
            .fillMaxWidth()
            .animateContentSize(animationSpec = tween(240, easing = FastOutSlowInEasing))
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("出品标准 · 须遵照执行", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.ExtraBold)
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (AppModule.canWrite()) {
                        Text("改标准", color = FiveGreen, fontWeight = FontWeight.Bold, modifier = Modifier.clickable(onClick = onEdit))
                    }
                    Text("收起", color = Ink, fontWeight = FontWeight.Bold, modifier = Modifier.clickable(onClick = onClose))
                }
            }
            Text(sel.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
            if (sel.cost != null || sel.price != null) {
                Text(
                    listOfNotNull(
                        sel.dishType,
                        sel.cost?.let { "成本¥${"%.1f".format(it)}" },
                        sel.price?.let { "售价¥${"%.0f".format(it)}" },
                        sel.grossMargin?.let { "毛利${"%.0f".format(it)}%" },
                        sel.dailyQty?.let { "日销约${"%.0f".format(it)}" }
                    ).joinToString(" · "),
                    color = Ink,
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.Bold
                )
            }
            Text(
                "标准 BOM 分量 + SOP 工序是灶上依据；算料只做倍增，不改标准本身。",
                color = Sub,
                style = MaterialTheme.typography.labelSmall
            )
            if (state.detailLoading) {
                CircularProgressIndicator(color = Ink, strokeWidth = 3.dp)
            } else {
                // 单一算料表：不再重复罗列「面主料/主料…」原文 + 倍增清单
                val yieldHint = estimateStockYield(sel, state.stock)
                Text(
                    yieldHint.note,
                    color = if ((yieldHint.maxMultiples ?: 0) <= 0) FiveRedC else FiveGreen,
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.Bold
                )

                Text(
                    "标准算料表 · ${shortRecipeName(sel.name)}（金丰 1×=面粉500g·${scaled.batchBase}个）",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    "滑条只做本餐倍增，不改菜谱标准。一行=标准用量+库存对照。",
                    color = Sub,
                    style = MaterialTheme.typography.labelSmall
                )
                val batchBase = scaled.batchBase.coerceAtLeast(1)
                val mult = standardMultiplesOf(scaled.qty, batchBase)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Slider(
                        value = mult.toFloat(),
                        onValueChange = { raw ->
                            val n = raw.roundToInt().coerceIn(1, 10)
                            onScale(n * batchBase)
                        },
                        valueRange = 1f..10f,
                        steps = 8,
                        modifier = Modifier.weight(1f),
                        colors = SliderDefaults.colors(thumbColor = Ink, activeTrackColor = Ink)
                    )
                    Column(horizontalAlignment = Alignment.End) {
                        Text("${mult}×标准", fontWeight = FontWeight.ExtraBold)
                        Text(
                            "面粉${mult * 500}g · ${scaled.qty}个",
                            color = Sub,
                            style = MaterialTheme.typography.labelSmall
                        )
                    }
                }
                Card(
                    shape = RoundedCornerShape(12.dp),
                    colors = CardDefaults.cardColors(containerColor = Color(0xFFF7F8FA)),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("原料", color = Sub, style = MaterialTheme.typography.labelSmall)
                            Text("需用量 / 库存", color = Sub, style = MaterialTheme.typography.labelSmall)
                        }
                        val hitByName = shortages.associateBy { it.line.name }
                        scaled.lines.take(16).forEach { line ->
                            val hit = hitByName[line.name]
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text(
                                    line.name,
                                    style = MaterialTheme.typography.bodySmall,
                                    fontWeight = if (line.highlight) FontWeight.Bold else FontWeight.Normal,
                                    color = if (line.highlight) FiveGreen else Ink,
                                    modifier = Modifier.weight(1f)
                                )
                                Column(horizontalAlignment = Alignment.End) {
                                    Text(line.qtyText, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Bold)
                                    Text(
                                        when {
                                            hit == null -> "—"
                                            hit.onHand != null -> "库${"%.1f".format(hit.onHand)}${hit.unit}" +
                                                if (hit.shortage) " ·缺" else ""
                                            else -> hit.note.take(12)
                                        },
                                        style = MaterialTheme.typography.labelSmall,
                                        color = if (hit?.shortage == true) FiveRedC else Sub
                                    )
                                }
                            }
                        }
                        scaled.totalCost?.let { total ->
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("预估总成本", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodySmall)
                                Text(
                                    "¥ ${String.format(Locale.CHINA, "%,.0f", total)}",
                                    color = FiveGreen,
                                    fontWeight = FontWeight.Bold,
                                    style = MaterialTheme.typography.bodySmall
                                )
                            }
                        }
                    }
                }

                RecipeParamsBlocks(sel.params)
                Text(colorLockNote(sel.color), color = FiveRedC, style = MaterialTheme.typography.bodySmall)

                if (shortageCount > 0) {
                    Text(
                        "缺料 ${shortageCount} 项 · 可调倍增或转采购",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Bold,
                        color = FiveRedC
                    )
                } else if (state.stock.isNotEmpty()) {
                    Text("对照库存：当前倍增无明显缺料", color = FiveGreen, style = MaterialTheme.typography.bodySmall)
                }

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ActionChip("转采购清单", primary = true) {
                        askRecipeRestock(sel, scaled, shortages, state.rev,
                            onToast = { _, msg -> Toast.makeText(context, msg, Toast.LENGTH_SHORT).show() },
                            onGoPurchase = onOpenPurchase
                        )
                    }
                    ActionChip("缺料替换") {
                        val miss = shortages.firstOrNull { it.shortage } ?: shortages.firstOrNull()
                        if (miss == null) {
                            Toast.makeText(context, "当前无缺料项", Toast.LENGTH_SHORT).show()
                        } else if (!AppModule.canWrite()) {
                            Toast.makeText(context, "只读账号不可替换", Toast.LENGTH_SHORT).show()
                        } else {
                            val fromName = miss.line.name
                            ConfirmBus.ask(
                                ConfirmRequest(
                                    title = "缺料替换",
                                    summary = "$fromName 缺料 → 记替换草案（确认台）",
                                    type = "recipe.substitute",
                                    payload = buildJsonObject {
                                        put("dish", sel.name)
                                        put("from_ing", fromName)
                                        put("to_ing", "暂代-$fromName")
                                        put("qty", miss.line.neededApprox ?: 1.0)
                                    },
                                    baseRev = state.rev
                                ) { r ->
                                    Toast.makeText(
                                        context,
                                        if (r.isSuccess) "已入队：缺料替换" else r.exceptionOrNull()?.message ?: "失败",
                                        Toast.LENGTH_SHORT
                                    ).show()
                                }
                            )
                        }
                    }
                    ActionChip("转厨房工单") {
                        val busy = state.posTables.filter { it.state == "busy" || it.state == "就餐" }
                        askRecipeWorkorder(
                            recipe = sel,
                            qty = scaled.qty,
                            rev = state.rev,
                            busyTables = busy,
                            onToast = { ok, msg ->
                                Toast.makeText(context, msg, Toast.LENGTH_SHORT).show()
                                if (ok) {
                                    viewModel.dispatch(
                                        KitchenViewModel.KitchenIntent.AfterWorkorderQueued(sel.skuId, scaled.qty)
                                    )
                                    onGoWorkorders()
                                }
                            }
                        )
                    }
                    ActionChip("按可做量") {
                        val n = (yieldHint.maxMultiples ?: 1).coerceIn(1, 10)
                        onScale(n * batchBase)
                        Toast.makeText(context, yieldHint.note, Toast.LENGTH_LONG).show()
                    }
                }

                // SOP = 厨师须执行的工序标准（工单页同源）
                if (timeline.isNotEmpty()) {
                    Text("工序标准 · 须按序执行", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.ExtraBold)
                    Text("开餐倒排仅作备料参考；灶上以步骤与质检点为准，不可跳步改方", color = Ink, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
                    timeline.forEach { tl ->
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(tl.timeLabel, style = MaterialTheme.typography.labelSmall, color = Sub, modifier = Modifier.padding(top = 2.dp))
                            Column(Modifier.weight(1f)) {
                                Text(
                                    "${tl.step.stepNo}. ${tl.step.stage}",
                                    style = MaterialTheme.typography.bodySmall,
                                    fontWeight = FontWeight.Bold
                                )
                                tl.step.keyPoints.takeIf { it.isNotEmpty() }?.let { pts ->
                                    Text("要点：${pts.joinToString("；")}", style = MaterialTheme.typography.labelSmall, color = Ink)
                                }
                                tl.step.qcPoint?.let { Text("质检（须过）：$it", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold) }
                                tl.step.risk?.let { Text("⚠ $it", style = MaterialTheme.typography.labelSmall, color = FiveRedC) }
                            }
                        }
                    }
                } else {
                    Text("暂无工序标准（推送配方 SOP 后，厨师须按步骤执行）", color = Sub, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun ActionChip(label: String, primary: Boolean = false, onClick: () -> Unit) {
    val bg = if (primary) Ink else CardBg
    val fg = if (primary) CardBg else Ink
    Box(
        Modifier
            .clip(RoundedCornerShape(20.dp))
            .background(bg)
            .then(if (!primary) Modifier.border(1.dp, Line, RoundedCornerShape(20.dp)) else Modifier)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp)
    ) {
        Text(label, color = fg, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
    }
}

private val DOC_PARAM_KEYS = setOf(
    "剂子_g", "成品_g", "醒发_min", "点凉水次数", "料水加入", "褶纹", "色源", "标准", "起草基准"
)
private val DERIVED_PARAM_KEYS = setOf(
    "馅_g", "馅_中位_g", "一批面团_g", "一批出成_理论", "一批出成_中位", "一批出成_个", "色源说明"
)
private val HIDDEN_PARAM_KEYS = setOf("面主料") // 已在「面主料」区块展示

@Composable
private fun RecipeParamsBlocks(params: kotlinx.serialization.json.JsonObject?) {
    if (params == null || params.isEmpty()) return
    val entries = params.entries
        .filter { it.key !in HIDDEN_PARAM_KEYS }
        .map { it.key to it.value.toString().trim('"') }
    val doc = entries.filter { it.first in DOC_PARAM_KEYS }
    val derived = entries.filter { it.first in DERIVED_PARAM_KEYS }
    val other = entries.filter { it.first !in DOC_PARAM_KEYS && it.first !in DERIVED_PARAM_KEYS }

    if (doc.isNotEmpty()) {
        Text("工艺参数（金丰标准）", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
        doc.forEach { (k, v) -> KvParam(k, v) }
    }
    if (derived.isNotEmpty() || other.isNotEmpty()) {
        Text("推算（由金丰标准推得）", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
        (derived + other).forEach { (k, v) -> KvParam(k, v) }
    }
}

@Composable
private fun KvParam(k: String, v: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(k, style = MaterialTheme.typography.bodySmall)
        Text(v, style = MaterialTheme.typography.bodySmall)
    }
}

private fun shortRecipeName(raw: String): String {
    val color = Regex("（([红黑黄绿紫白])）").find(raw)?.groupValues?.getOrNull(1)
    val filling = Regex("（([^）]*馅)）").findAll(raw).lastOrNull()?.groupValues?.getOrNull(1)
        ?.removeSuffix("馅")
    return when {
        color != null && filling != null -> "$color·$filling"
        color != null -> "${color}色饺子"
        raw.length > 18 -> raw.take(16) + "…"
        else -> raw
    }
}

private fun askRecipeRestock(
    recipe: RecipeDto,
    scaled: RecipeScaleResult,
    shortages: List<ShortageHit>,
    rev: String?,
    onToast: (Boolean, String) -> Unit,
    onGoPurchase: () -> Unit = {}
) {
    if (!AppModule.canWrite()) {
        onToast(false, "当前账号无写权限，请用老板/店长确认")
        return
    }
    // 只采：缺料 + 未匹配库存（清水等跳过）；数量必须是数字，否则消费端写不进采购单
    val buyLines = shortages.filter { hit ->
        val n = hit.line.name
        if (n.contains("清水") || (n.contains("水") && !n.contains("汁") && !n.contains("果"))) return@filter false
        hit.shortage || hit.stockName == null
    }.ifEmpty {
        shortages.filter {
            val n = it.line.name
            !(n.contains("清水") || (n.contains("水") && !n.contains("汁") && !n.contains("果")))
        }
    }
    if (buyLines.isEmpty()) {
        onToast(false, "当前倍增无明显需采购项")
        return
    }
    val payload = buildJsonObject {
        put("supplier", "未指定供应商")
        put("note", "菜谱 ${shortRecipeName(recipe.name)} · ${scaled.qty}个 → 采购草稿")
        put("sku_id", recipe.skuId)
        put("qty", scaled.qty)
        put("items", buildJsonArray {
            buyLines.take(20).forEach { hit ->
                val qtyNum = hit.line.neededApprox ?: parseQtyNumber(hit.line.qtyText) ?: 0.0
                add(
                    buildJsonObject {
                        put("ing_id", hit.stockName ?: hit.line.name)
                        put("name", hit.stockName ?: hit.line.name)
                        put("qty", qtyNum)
                        put("unit", hit.line.unit.ifBlank { hit.unit })
                        put("price", 0.0)
                    }
                )
            }
        })
    }
    ConfirmBus.ask(
        ConfirmRequest(
            title = "转采购清单",
            summary = "${shortRecipeName(recipe.name)} · ${buyLines.size} 项写入采购草稿，确认后进「进销存·采购」",
            type = "restock.create",
            payload = payload,
            baseRev = rev,
            onResult = { result ->
                result.fold(
                    onSuccess = {
                        onToast(true, "已提交采购草稿")
                        onGoPurchase()
                    },
                    onFailure = { onToast(false, it.message ?: "失败") }
                )
            }
        )
    )
}

private fun parseQtyNumber(text: String): Double? =
    Regex("""(\d+(?:\.\d+)?)""").find(text)?.groupValues?.getOrNull(1)?.toDoubleOrNull()

private fun askRecipeWorkorder(
    recipe: RecipeDto,
    qty: Int,
    rev: String?,
    busyTables: List<com.pandawufu.shared.model.PosTableDto> = emptyList(),
    onToast: (Boolean, String) -> Unit
) {
    if (!AppModule.canWrite()) {
        onToast(false, "当前账号无写权限，请用老板/店长确认")
        return
    }
    val day = LocalDate.now().toString()
    val table = busyTables.firstOrNull()
    val payload = buildJsonObject {
        put("sku_id", recipe.skuId)
        put("qty", qty)
        put("date", day)
        put("planned_start", "${day}T10:00")
        put("status", "待开始")
        put("name", recipe.name)
        if (table != null) {
            put("table_id", table.id)
            put("table_no", table.no ?: table.id)
        }
    }
    val tableHint = table?.let { " · 挂桌 ${it.no ?: it.id}" }.orEmpty()
    ConfirmBus.ask(
        ConfirmRequest(
            title = "转厨房工单",
            summary = "为 ${shortRecipeName(recipe.name)} 创建今日工单 · 计划 $qty 个（下剂）$tableHint",
            type = "workorder.create",
            payload = payload,
            baseRev = rev,
            onResult = { result ->
                result.fold(
                    onSuccess = { onToast(true, "工单已入确认台$tableHint") },
                    onFailure = { onToast(false, it.message ?: "失败") }
                )
            }
        )
    )
}
