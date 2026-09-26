package com.pandawufu.app.features.inventory

import android.widget.Toast
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.AppModule
import com.pandawufu.app.confirm.ConfirmBus
import com.pandawufu.app.confirm.ConfirmRequest
import com.pandawufu.app.features.kitchen.StatusTag
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.FiveYellow
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.Line
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.model.IngredientDto
import com.pandawufu.shared.repository.StockItem
import com.pandawufu.shared.repository.StockStatus
import com.pandawufu.shared.viewmodel.InventoryViewModel
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private val CAT_PRESETS = listOf(
    "全部", "干调类", "肉类", "蔬果", "色源", "面点", "冷链", "耗材包材", "菜谱挂钩", "其他"
)

/**
 * 进销存 · 产品库：原料档案增删改查（写走 ing.upsert → 确认台）。
 * 与「库存」页分工：库存看现量/告急；本页管名称/单位/包规/安全线/供应商。
 */
@Composable
fun CatalogTab(
    state: InventoryViewModel.InventoryState,
    onRefresh: () -> Unit = {}
) {
    val context = LocalContext.current
    if (state.loading && state.stock.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        return
    }

    var query by remember { mutableStateOf("") }
    var catFilter by remember { mutableStateOf("全部") }
    var editTarget by remember { mutableStateOf<IngredientDto?>(null) }
    var showEditor by remember { mutableStateOf(false) }
    val vendorNames = remember(state.vendors, state.suppliers) {
        (state.vendors.map { it.name } + state.suppliers).distinct().filter { it.isNotBlank() }
    }

    val displayAll = remember(state.stock) { dedupeStockForDisplay(state.stock) }
    val cats = remember(displayAll) {
        val fromData = displayAll.mapNotNull { it.ingredient.cat?.takeIf { c -> c.isNotBlank() } }.distinct().sorted()
        listOf("全部") + (CAT_PRESETS.drop(1) + fromData).distinct()
    }
    val filtered = remember(displayAll, query, catFilter) {
        val q = query.trim()
        displayAll
            .filter {
                (catFilter == "全部" || it.ingredient.cat == catFilter ||
                    (catFilter == "其他" && it.ingredient.cat.isNullOrBlank())) &&
                    (q.isEmpty() ||
                        it.ingredient.name.contains(q, ignoreCase = true) ||
                        (it.ingredient.sup?.contains(q) == true) ||
                        (it.ingredient.spec?.contains(q) == true))
            }
            .sortedBy { it.ingredient.name }
    }

    if (showEditor) {
        IngEditDialog(
            initial = editTarget,
            vendorNames = vendorNames,
            baseRev = state.rev,
            onDismiss = { showEditor = false; editTarget = null },
            onSubmitted = {
                showEditor = false
                editTarget = null
                onRefresh()
            }
        )
    }

    LazyColumn(
        Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Card(
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text("产品库 · 原料档案", fontWeight = FontWeight.ExtraBold, fontSize = 16.sp, color = Ink)
                            Text(
                                "主数据 · 共 ${displayAll.size} 种 · 改档经确认台",
                                fontSize = 12.sp,
                                color = Sub
                            )
                        }
                        if (AppModule.canWrite()) {
                            Box(
                                Modifier
                                    .clip(RoundedCornerShape(12.dp))
                                    .background(Ink)
                                    .clickable {
                                        editTarget = null
                                        showEditor = true
                                    }
                                    .padding(horizontal = 14.dp, vertical = 10.dp)
                            ) {
                                Text("+ 新增原料", color = CardBg, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                            }
                        }
                    }
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        label = { Text("搜索名称 / 供应商 / 规格") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    Row(
                        Modifier.horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        cats.take(16).forEach { c ->
                            val on = catFilter == c
                            Box(
                                Modifier
                                    .clip(RoundedCornerShape(14.dp))
                                    .background(if (on) Ink else CardBg)
                                    .then(
                                        if (!on) Modifier.border(1.dp, Line, RoundedCornerShape(14.dp))
                                        else Modifier
                                    )
                                    .clickable { catFilter = c }
                                    .padding(horizontal = 10.dp, vertical = 6.dp)
                            ) {
                                Text(c, color = if (on) CardBg else Ink, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                    if (!AppModule.canWrite()) {
                        Text("当前只读账号，可浏览档案，不可新增/编辑。", color = FiveYellow, fontSize = 12.sp)
                    }
                }
            }
        }

        if (filtered.isEmpty()) {
            item {
                Card(
                    shape = RoundedCornerShape(14.dp),
                    colors = CardDefaults.cardColors(containerColor = CardBg),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            if (displayAll.isEmpty()) "产品库为空 · 请新增原料或等待快照推送"
                            else "无匹配原料",
                            color = Sub
                        )
                        if (AppModule.canWrite() && displayAll.isEmpty()) {
                            Text(
                                "点上方「+ 新增原料」建档后，厨房菜谱配料即可从产品库选择。",
                                color = Ink,
                                fontSize = 12.sp
                            )
                        }
                    }
                }
            }
        }

        items(filtered, key = { it.ingredient.id }) { item ->
            CatalogRow(
                item = item,
                canWrite = AppModule.canWrite(),
                onEdit = {
                    editTarget = item.ingredient
                    showEditor = true
                }
            )
        }
    }
}

@Composable
private fun CatalogRow(
    item: StockItem,
    canWrite: Boolean,
    onEdit: () -> Unit
) {
    val ing = item.ingredient
    val statusColor = when (item.status) {
        StockStatus.ENOUGH -> FiveGreen
        StockStatus.LOW -> FiveYellow
        StockStatus.CRITICAL -> FiveRed
    }
    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = CardBg),
        modifier = Modifier
            .fillMaxWidth()
            .then(if (canWrite) Modifier.clickable(onClick = onEdit) else Modifier)
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(Modifier.weight(1f)) {
                    Text(ing.name, fontWeight = FontWeight.Bold, fontSize = 15.sp, color = Ink)
                    Text(
                        listOfNotNull(
                            ing.cat,
                            ing.unit.takeIf { it.isNotBlank() }?.let { "库存单位 $it" },
                            ing.buy?.takeIf { it.isNotBlank() }?.let { "采购 $it" },
                            ing.pack?.takeIf { it.isNotBlank() }?.let { "包规 $it" }
                        ).joinToString(" · ").ifBlank { "未标分类/单位" },
                        fontSize = 11.sp,
                        color = Sub
                    )
                }
                StatusTag(item.status.label, statusColor)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(
                    "现 ${fmtCatalog(item.qty)}${ing.unit} · 安全 ${fmtCatalog(item.safety)}",
                    fontSize = 12.sp,
                    color = Ink
                )
                Text(
                    listOfNotNull(
                        ing.sup?.takeIf { it.isNotBlank() },
                        ing.spec?.takeIf { it.isNotBlank() }
                    ).joinToString(" · ").ifBlank { if (canWrite) "点按编辑 ›" else "" },
                    fontSize = 12.sp,
                    color = if (canWrite) FiveGreen else Sub,
                    fontWeight = if (canWrite) FontWeight.Bold else FontWeight.Normal
                )
            }
        }
    }
}

@Composable
private fun IngEditDialog(
    initial: IngredientDto?,
    vendorNames: List<String> = emptyList(),
    baseRev: String?,
    onDismiss: () -> Unit,
    onSubmitted: () -> Unit
) {
    val context = LocalContext.current
    var name by remember { mutableStateOf(initial?.name ?: "") }
    var cat by remember { mutableStateOf(initial?.cat ?: "干调类") }
    var unit by remember { mutableStateOf(initial?.unit?.ifBlank { "斤" } ?: "斤") }
    var buy by remember { mutableStateOf(initial?.buy ?: unit) }
    var pack by remember { mutableStateOf(initial?.pack ?: "") }
    var safe by remember { mutableStateOf(initial?.safe?.toString() ?: initial?.safety?.toString() ?: "") }
    var est by remember { mutableStateOf(initial?.est?.toString() ?: "") }
    var qty by remember { mutableStateOf(initial?.qty?.toString() ?: initial?.stock?.toString() ?: "0") }
    var sup by remember { mutableStateOf(initial?.sup ?: "") }
    var spec by remember { mutableStateOf(initial?.spec ?: "") }
    var conv by remember { mutableStateOf(initial?.conv?.toString() ?: "1") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                if (initial == null) "新增原料" else "编辑 · ${initial.name}",
                fontWeight = FontWeight.Bold
            )
        },
        text = {
            Column(
                Modifier
                    .fillMaxWidth()
                    .heightIn(max = 480.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text("档案写入进销存产品库；厨房菜谱配料可从这里选。", color = Sub, fontSize = 12.sp)
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("原料名") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Text("分类", fontSize = 12.sp, color = Sub)
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    CAT_PRESETS.drop(1).forEach { c ->
                        val on = cat == c
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(12.dp))
                                .background(if (on) Ink else CardBg)
                                .then(if (!on) Modifier.border(1.dp, Line, RoundedCornerShape(12.dp)) else Modifier)
                                .clickable { cat = c }
                                .padding(horizontal = 10.dp, vertical = 6.dp)
                        ) {
                            Text(c, color = if (on) CardBg else Ink, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = unit, onValueChange = { unit = it },
                        label = { Text("库存单位") }, singleLine = true, modifier = Modifier.weight(1f)
                    )
                    OutlinedTextField(
                        value = buy, onValueChange = { buy = it },
                        label = { Text("采购单位") }, singleLine = true, modifier = Modifier.weight(1f)
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = pack, onValueChange = { pack = it },
                        label = { Text("包规") }, singleLine = true, modifier = Modifier.weight(1f)
                    )
                    OutlinedTextField(
                        value = conv, onValueChange = { conv = it },
                        label = { Text("换算") }, singleLine = true, modifier = Modifier.weight(0.7f)
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = qty, onValueChange = { qty = it },
                        label = { Text("现库存") }, singleLine = true, modifier = Modifier.weight(1f)
                    )
                    OutlinedTextField(
                        value = safe, onValueChange = { safe = it },
                        label = { Text("安全线") }, singleLine = true, modifier = Modifier.weight(1f)
                    )
                    OutlinedTextField(
                        value = est, onValueChange = { est = it },
                        label = { Text("日耗估") }, singleLine = true, modifier = Modifier.weight(1f)
                    )
                }
                OutlinedTextField(
                    value = sup, onValueChange = { sup = it },
                    label = { Text("供应商（可手填或下方点选）") }, singleLine = true, modifier = Modifier.fillMaxWidth()
                )
                if (vendorNames.isNotEmpty()) {
                    Text("从供应商库选", fontSize = 12.sp, color = Sub)
                    Row(
                        Modifier.horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        vendorNames.take(20).forEach { n ->
                            val on = sup == n
                            Box(
                                Modifier
                                    .clip(RoundedCornerShape(12.dp))
                                    .background(if (on) Ink else CardBg)
                                    .then(if (!on) Modifier.border(1.dp, Line, RoundedCornerShape(12.dp)) else Modifier)
                                    .clickable { sup = n }
                                    .padding(horizontal = 10.dp, vertical = 6.dp)
                            ) {
                                Text(n, color = if (on) CardBg else Ink, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                }
                OutlinedTextField(
                    value = spec, onValueChange = { spec = it },
                    label = { Text("规格备注") }, singleLine = true, modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            TextButton(onClick = {
                if (!AppModule.canWrite()) {
                    Toast.makeText(context, "只读账号不可改产品库", Toast.LENGTH_SHORT).show()
                    return@TextButton
                }
                val n = name.trim()
                if (n.isEmpty()) {
                    Toast.makeText(context, "请填写原料名", Toast.LENGTH_SHORT).show()
                    return@TextButton
                }
                val u = unit.trim().ifBlank { "斤" }
                ConfirmBus.ask(
                    ConfirmRequest(
                        title = if (initial == null) "新增原料" else "更新原料档案",
                        summary = "$n · $cat · $u" +
                            (safe.toDoubleOrNull()?.let { " · 安全线 $it" } ?: "") +
                            (sup.trim().takeIf { it.isNotEmpty() }?.let { " · $it" } ?: ""),
                        type = "ing.upsert",
                        payload = buildJsonObject {
                            initial?.id?.let { put("id", it) }
                            put("name", n)
                            put("cat", cat)
                            put("unit", u)
                            put("buy", buy.trim().ifBlank { u })
                            if (pack.isNotBlank()) put("pack", pack.trim())
                            conv.toDoubleOrNull()?.let { put("conv", it) }
                            qty.toDoubleOrNull()?.let { put("qty", it) }
                            safe.toDoubleOrNull()?.let { put("safe", it) }
                            est.toDoubleOrNull()?.let { put("est", it) }
                            if (sup.isNotBlank()) put("sup", sup.trim())
                            if (spec.isNotBlank()) put("spec", spec.trim())
                            put("on", true)
                        },
                        baseRev = baseRev,
                        onResult = { r ->
                            Toast.makeText(
                                context,
                                if (r.isSuccess) "已入队：原料 $n" else r.exceptionOrNull()?.message ?: "失败",
                                Toast.LENGTH_SHORT
                            ).show()
                            if (r.isSuccess) onSubmitted()
                        }
                    )
                )
            }) { Text("确认台提交", fontWeight = FontWeight.Bold, color = FiveGreen) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        }
    )
}

private fun fmtCatalog(v: Double): String =
    when {
        v >= 100 -> "%.0f".format(v)
        v >= 10 -> "%.1f".format(v)
        else -> "%.2f".format(v)
    }
