package com.pandawufu.app.features.inventory

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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import android.widget.Toast
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.confirm.KimiCtaByType
import com.pandawufu.app.confirm.ConfirmBus
import com.pandawufu.app.confirm.ConfirmRequest
import com.pandawufu.app.AppModule
import com.pandawufu.app.features.kitchen.StatusTag
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.FiveYellow
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.Line
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.repository.StockItem
import com.pandawufu.shared.repository.StockStatus
import com.pandawufu.shared.viewmodel.InventoryViewModel
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

@Composable
fun StockTab(
    state: InventoryViewModel.InventoryState,
    onGoRestock: () -> Unit = {},
    onGoCatalog: () -> Unit = {}
) {
    val context = LocalContext.current
    if (state.loading && state.stock.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        return
    }
    var scene by remember { mutableStateOf(IngScene.ALL) }
    var kind by remember { mutableStateOf(IngKind.ALL) }
    var onlyNeed by remember { mutableStateOf(true) }
    var countTarget by remember { mutableStateOf<StockItem?>(null) }
    val digest = remember(state.stock) { buildBossStockDigest(state.stock) }
    val displayAll = remember(state.stock) { dedupeStockForDisplay(state.stock) }

    countTarget?.let { target ->
        CountDialog(
            item = target,
            rev = state.rev,
            onDismiss = { countTarget = null },
            onToast = { msg -> Toast.makeText(context, msg, Toast.LENGTH_SHORT).show() }
        )
    }

    val filtered = remember(displayAll, scene, kind, onlyNeed) {
        displayAll
            .filter {
                val c = classifyIng(it)
                (scene == IngScene.ALL || c.scene == scene) &&
                    (kind == IngKind.ALL || c.kind == kind)
            }
            .filter {
                if (!onlyNeed) true
                else it.status == StockStatus.CRITICAL || it.status == StockStatus.LOW
            }
            .sortedWith(
                compareBy<StockItem> {
                    when (it.status) {
                        StockStatus.CRITICAL -> 0
                        StockStatus.LOW -> 1
                        StockStatus.ENOUGH -> 2
                    }
                }.thenBy { classifyIng(it).scene.ordinal }
                    .thenBy { classifyIng(it).kind.ordinal }
                    .thenBy { it.ingredient.name }
            )
    }

    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Box(
                    Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(12.dp))
                        .border(1.dp, Line, RoundedCornerShape(12.dp))
                        .clickable(onClick = onGoCatalog)
                        .padding(vertical = 12.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text("产品库 ›", color = Ink, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                }
                Box(
                    Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(12.dp))
                        .background(FiveRed)
                        .clickable(onClick = onGoRestock)
                        .padding(vertical = 12.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text("缺货开单 ›", color = CardBg, fontWeight = FontWeight.ExtraBold, fontSize = 14.sp)
                }
            }
        }
        item { KimiCtaByType("stock", baseRev = state.rev) }
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
                        Column {
                            Text("今日办货看板", fontWeight = FontWeight.ExtraBold, fontSize = 16.sp, color = Ink)
                            Text(
                                when {
                                    digest.critical > 0 -> "告急 ${digest.critical} · 先按场景再按品类办货"
                                    digest.low > 0 -> "偏低 ${digest.low} · 可合并一趟采购"
                                    else -> "暂无告急 · 库存整体平稳"
                                },
                                fontSize = 12.sp,
                                color = Sub
                            )
                        }
                        StockDonut(digest.enough, digest.low, digest.critical)
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        DigCell("告急", "${digest.critical}", FiveRed, Modifier.weight(1f))
                        DigCell("偏低", "${digest.low}", FiveYellow, Modifier.weight(1f))
                        DigCell("充足", "${digest.enough}", FiveGreen, Modifier.weight(1f))
                    }
                    if (digest.critical > 0 || digest.low > 0) {
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(12.dp))
                                .background(FiveRed)
                                .clickable(onClick = onGoRestock)
                                .padding(vertical = 10.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                "去缺货页开采购单（告急 ${digest.critical} · 偏低 ${digest.low}）",
                                color = Color.White,
                                fontWeight = FontWeight.ExtraBold,
                                fontSize = 13.sp
                            )
                        }
                    }
                    if (digest.needByScene.isNotEmpty()) {
                        Text("缺货 · 按场景", fontSize = 11.sp, color = Sub)
                        Row(
                            Modifier.horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            digest.needByScene.forEach { (s, n) ->
                                FilterChip("${s.label} $n", false, FiveRed) {
                                    scene = s
                                    onlyNeed = true
                                }
                            }
                        }
                    }
                    if (digest.needByKind.isNotEmpty()) {
                        Text("缺货 · 按品类", fontSize = 11.sp, color = Sub)
                        Row(
                            Modifier.horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            digest.needByKind.take(6).forEach { (k, n) ->
                                FilterChip("${k.label} $n", false, kindColor(k)) {
                                    kind = k
                                    onlyNeed = true
                                }
                            }
                        }
                    }
                }
            }
        }

        item {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("① 使用场景", fontWeight = FontWeight.Bold, fontSize = 13.sp)
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    IngScene.entries.forEach { s ->
                        val count = if (s == IngScene.ALL) displayAll.size
                        else displayAll.count { classifyIng(it).scene == s }
                        if (s != IngScene.ALL && count == 0) return@forEach
                        FilterChip("${s.label} $count", scene == s, Ink) { scene = s }
                    }
                }
                Text(sceneHint(scene), fontSize = 11.sp, color = Sub)

                Text("② 原料品类", fontWeight = FontWeight.Bold, fontSize = 13.sp)
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    IngKind.entries.forEach { k ->
                        val count = if (k == IngKind.ALL) {
                            displayAll.count {
                                val c = classifyIng(it)
                                scene == IngScene.ALL || c.scene == scene
                            }
                        } else {
                            displayAll.count {
                                val c = classifyIng(it)
                                c.kind == k && (scene == IngScene.ALL || c.scene == scene)
                            }
                        }
                        if (k != IngKind.ALL && count == 0) return@forEach
                        FilterChip("${k.label} $count", kind == k, kindColor(k)) { kind = k }
                    }
                }
                Text(kindHint(kind), fontSize = 11.sp, color = Sub)

                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        "${scene.label} × ${kind.label}",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        color = Ink
                    )
                    Text(
                        if (onlyNeed) "只看缺货 ✓" else "显示全部",
                        color = if (onlyNeed) FiveRed else Sub,
                        fontWeight = FontWeight.Bold,
                        fontSize = 12.sp,
                        modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .clickable { onlyNeed = !onlyNeed }
                            .padding(horizontal = 8.dp, vertical = 4.dp)
                    )
                }
            }
        }

        item {
            Text(
                if (onlyNeed) "缺货清单（${filtered.size}）" else "原料清单（${filtered.size}）· 已去重",
                style = MaterialTheme.typography.titleMedium
            )
        }

        if (filtered.isEmpty()) {
            item {
                Card(
                    shape = RoundedCornerShape(14.dp),
                    colors = CardDefaults.cardColors(containerColor = CardBg),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        if (onlyNeed) "该组合下暂无告急/偏低" else "暂无原料",
                        Modifier.padding(20.dp),
                        color = Sub
                    )
                }
            }
        }

        items(filtered, key = { it.ingredient.id }) { item ->
            val statusColor = when (item.status) {
                StockStatus.ENOUGH -> FiveGreen
                StockStatus.LOW -> FiveYellow
                StockStatus.CRITICAL -> FiveRed
            }
            val ratio = if (item.safety > 0) (item.qty / item.safety).toFloat().coerceIn(0f, 1.2f) else 1f
            val c = classifyIng(item)
            val days = daysLeft(item)
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Box(
                            Modifier
                                .size(36.dp)
                                .clip(RoundedCornerShape(10.dp))
                                .background(kindColor(c.kind).copy(alpha = 0.18f)),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(c.kind.tag, fontWeight = FontWeight.ExtraBold, color = kindColor(c.kind), fontSize = 13.sp)
                        }
                        Column(Modifier.weight(1f)) {
                            Text(item.ingredient.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
                            Text(
                                "${c.scene.label} · ${c.kind.label} · 档案:${item.ingredient.cat ?: "未标"}",
                                style = MaterialTheme.typography.labelSmall,
                                color = Sub
                            )
                        }
                        StatusTag(item.status.label, statusColor)
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(
                            "现 ${fmt(item.qty)}${item.ingredient.unit} / 安全 ${fmt(item.safety)}",
                            fontSize = 12.sp,
                            color = Ink
                        )
                        Text(
                            days ?: "按安全线监控",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold,
                            color = statusColor
                        )
                    }
                    Box(Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp)).background(Line)) {
                        Box(
                            Modifier
                                .fillMaxWidth(ratio.coerceAtMost(1f))
                                .height(8.dp)
                                .clip(RoundedCornerShape(4.dp))
                                .background(statusColor)
                        )
                    }
                    if (AppModule.canWrite()) {
                        Text(
                            "录入实盘 ›",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold,
                            color = FiveRed,
                            modifier = Modifier
                                .padding(top = 2.dp)
                                .clickable { countTarget = item }
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun CountDialog(
    item: StockItem,
    rev: String?,
    onDismiss: () -> Unit,
    onToast: (String) -> Unit
) {
    var realText by remember(item) { mutableStateOf(fmt(item.qty)) }
    var note by remember { mutableStateOf("") }
    val real = realText.toDoubleOrNull()
    val delta = real?.let { it - item.qty }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("盘点 · ${item.ingredient.name}", fontWeight = FontWeight.Bold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "账面 ${fmt(item.qty)}${item.ingredient.unit.orEmpty()} · 录入实盘后改库存",
                    color = Sub,
                    fontSize = 12.sp
                )
                OutlinedTextField(
                    value = realText,
                    onValueChange = { realText = it },
                    label = { Text("实盘数量 ${item.ingredient.unit.orEmpty()}") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                if (delta != null) {
                    Text(
                        "差异 ${if (delta >= 0) "+" else ""}${fmt(delta)}${item.ingredient.unit.orEmpty()}",
                        fontWeight = FontWeight.Bold,
                        color = if (delta == 0.0) FiveGreen else FiveRed
                    )
                }
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = { Text("备注（可选）") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    if (real == null) {
                        onToast("请输入有效实盘数")
                        return@TextButton
                    }
                    onDismiss()
                    ConfirmBus.ask(
                        ConfirmRequest(
                            title = "确认盘点改账",
                            summary = "${item.ingredient.name} 账面 ${fmt(item.qty)} → 实盘 ${fmt(real)}${item.ingredient.unit.orEmpty()}",
                            type = "stock.count",
                            payload = buildJsonObject {
                                put("name", item.ingredient.name)
                                put("ing_id", item.ingredient.id)
                                put("book_qty", item.qty)
                                put("real_qty", real)
                                put("unit", item.ingredient.unit ?: "")
                                put("note", note.ifBlank { "App 实盘" })
                            },
                            baseRev = rev,
                            onResult = { r ->
                                onToast(
                                    if (r.isSuccess) "已入队：盘点 ${item.ingredient.name}"
                                    else r.exceptionOrNull()?.message ?: "失败"
                                )
                            }
                        )
                    )
                }
            ) { Text("提交盘点") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        }
    )
}

@Composable
private fun FilterChip(label: String, on: Boolean, accent: Color, onClick: () -> Unit) {
    Box(
        Modifier
            .clip(RoundedCornerShape(16.dp))
            .background(if (on) accent else CardBg)
            .then(
                if (!on) Modifier.border(1.dp, if (accent == Ink) Line else accent.copy(alpha = 0.35f), RoundedCornerShape(16.dp))
                else Modifier
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp)
    ) {
        Text(
            label,
            color = if (on) CardBg else if (accent == FiveRed || accent == Ink) Ink else accent,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.Bold
        )
    }
}

@Composable
private fun DigCell(label: String, value: String, color: Color, modifier: Modifier) {
    Column(
        modifier
            .clip(RoundedCornerShape(12.dp))
            .background(color.copy(alpha = 0.1f))
            .padding(10.dp)
    ) {
        Text(label, fontSize = 11.sp, color = Sub)
        Text(value, fontSize = 20.sp, fontWeight = FontWeight.ExtraBold, color = color)
    }
}

private fun fmt(v: Double): String =
    if (v >= 10) "%.0f".format(v) else if (v >= 1) "%.1f".format(v) else "%.2f".format(v)

private fun daysLeft(item: StockItem): String? {
    if (item.safety <= 0) return null
    val d = (item.qty / item.safety) * 3.0
    return when {
        d < 0.5 -> "不足半天"
        d < 1 -> "约半天"
        d < 1.5 -> "约 1 天"
        else -> "约 ${d.toInt()} 天"
    }
}

@Composable
private fun StockDonut(enough: Int, low: Int, critical: Int) {
    val total = (enough + low + critical).coerceAtLeast(1)
    androidx.compose.foundation.Canvas(Modifier.size(64.dp)) {
        val stroke = Stroke(width = 14.dp.toPx())
        var start = -90f
        listOf(FiveGreen to enough, FiveYellow to low, FiveRed to critical).forEach { (color, count) ->
            val sweep = 360f * count / total
            if (sweep > 0f) drawArc(color, start, sweep, useCenter = false, style = stroke)
            start += sweep
        }
    }
}
