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
import com.pandawufu.app.ui.designsystem.AiPurple
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.Line
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.model.QuoteDto
import com.pandawufu.shared.repository.RestockSuggestion
import com.pandawufu.shared.viewmodel.InventoryViewModel
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private data class DraftLine(
    val ingredientId: String,
    val name: String,
    val unit: String,
    val qtyText: String,
    val priceText: String,
    /** 无报价时的兜底单价：原料均价 → 最近采购价 */
    val basePrice: Double = 0.0
)

/** 全局补货草稿：先改量/价/供应商，再进确认台。 */
object RestockDraftBus {
    data class Pending(
        val items: List<RestockSuggestion>,
        val rev: String?,
        val suppliers: List<String> = emptyList(),
        val quotes: List<QuoteDto> = emptyList(),
        val onToast: (Boolean, String) -> Unit = { _, _ -> }
    )

    var pending by mutableStateOf<Pending?>(null)
        private set

    fun ask(
        items: List<RestockSuggestion>,
        rev: String?,
        suppliers: List<String> = emptyList(),
        quotes: List<QuoteDto> = emptyList(),
        onToast: (Boolean, String) -> Unit
    ) {
        if (items.isEmpty()) {
            onToast(false, "没有可补原料")
            return
        }
        pending = Pending(items, rev, suppliers, quotes, onToast)
    }

    fun clear() {
        pending = null
    }
}

@Composable
fun RestockEditHost() {
    val draft = RestockDraftBus.pending ?: return
    RestockEditDialog(
        items = draft.items,
        suppliers = draft.suppliers,
        quotes = draft.quotes,
        onDismiss = { RestockDraftBus.clear() },
        onSubmit = { supplier, note, lines ->
            RestockDraftBus.clear()
            submitRestockConfirm(lines, supplier, note, draft.rev, draft.onToast)
        }
    )
}

@Composable
fun RestockTab(
    state: InventoryViewModel.InventoryState,
    onOpenedPo: () -> Unit = {}
) {
    val context = LocalContext.current
    val grouped = remember(state.restock) {
        state.restock
            .groupBy { classifyIngByName(it.name).scene }
            .toList()
            .sortedBy { it.first.ordinal }
    }
    val suppliers = remember(state.vendors, state.suppliers) {
        (state.vendors.map { it.name } + state.suppliers)
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .distinct()
    }

    fun openDraft(list: List<RestockSuggestion>) {
        askRestockConfirm(list, state.rev, suppliers, state.quotes) { ok, msg ->
            Toast.makeText(context, msg, Toast.LENGTH_SHORT).show()
            if (ok) onOpenedPo()
        }
    }

    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("缺货建议", fontWeight = FontWeight.ExtraBold, fontSize = 16.sp, color = Ink)
                    Text(
                        "只回答「该买什么」。开采购单后进「下单」确认；货到再进「入库」改账面。",
                        fontSize = 12.sp,
                        color = Sub
                    )
                    if (grouped.isNotEmpty()) {
                        Text(
                            "建议 " + grouped.joinToString("、") { "${it.first.label}${it.second.size}" },
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold,
                            color = FiveRed
                        )
                    }
                }
            }
        }
        if (state.restock.isEmpty() && !state.loading) {
            item {
                Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                    Text("暂无告急/偏低原料 · 库存平稳", style = MaterialTheme.typography.bodySmall, color = Sub)
                }
            }
        }
        grouped.forEach { (scene, list) ->
            item(key = "hdr-${scene.name}") {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        "${scene.label} · ${list.size} 项",
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.ExtraBold
                    )
                    if (AppModule.canWrite()) {
                        Text(
                            "本类开单",
                            color = AiPurple,
                            fontWeight = FontWeight.Bold,
                            fontSize = 13.sp,
                            modifier = Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .clickable { openDraft(list) }
                                .padding(6.dp)
                        )
                    }
                }
                Text(scene.hint, fontSize = 11.sp, color = Sub)
            }
            items(list, key = { it.ingredientId }) { s ->
                val cls = classifyIngByName(s.name)
                Card(
                    shape = RoundedCornerShape(14.dp),
                    colors = CardDefaults.cardColors(containerColor = CardBg),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        Modifier.padding(14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                buildString {
                                    append(s.name)
                                    append(" · 建议 ${fmtQty(s.suggestQty)}${s.unit}")
                                },
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.Bold
                            )
                            Text(
                                buildString {
                                    val q = s.qty
                                    val sf = s.safe
                                    if (q != null && sf != null) {
                                        append("现 ${fmtQty(q)}/${fmtQty(sf)}${s.unit}")
                                        append(" · ")
                                    }
                                    append(cls.kind.label)
                                    if (s.reason.isNotBlank()) {
                                        append(" · ")
                                        append(s.reason)
                                    }
                                },
                                style = MaterialTheme.typography.bodySmall,
                                color = Sub
                            )
                            s.specReq?.takeIf { it.isNotBlank() }?.let { spec ->
                                Text(
                                    "规格 $spec",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = Sub
                                )
                            }
                        }
                        val enabled = AppModule.canWrite()
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(10.dp))
                                .background(if (enabled) AiPurple else Sub.copy(alpha = 0.3f))
                                .clickable(enabled = enabled) { openDraft(listOf(s)) }
                                .padding(horizontal = 14.dp, vertical = 8.dp)
                        ) {
                            Text(
                                if (enabled) "开采购单" else "无权限",
                                style = MaterialTheme.typography.bodySmall,
                                color = CardBg
                            )
                        }
                    }
                }
            }
        }
        if (state.restock.isNotEmpty() && AppModule.canWrite()) {
            item {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(AiPurple)
                        .clickable { openDraft(state.restock) }
                        .padding(14.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        "全部开成一张采购单（${state.restock.size} 项）",
                        color = CardBg,
                        style = MaterialTheme.typography.bodyMedium
                    )
                }
            }
        }
    }
}

@Composable
private fun RestockEditDialog(
    items: List<RestockSuggestion>,
    suppliers: List<String>,
    quotes: List<QuoteDto>,
    onDismiss: () -> Unit,
    onSubmit: (supplier: String, note: String, lines: List<DraftLine>) -> Unit
) {
    val supplierOptions = remember(suppliers) {
        (suppliers + "未指定供应商").distinct()
    }
    var supplier by remember(items) {
        mutableStateOf(supplierOptions.firstOrNull { it != "未指定供应商" } ?: "未指定供应商")
    }
    var note by remember { mutableStateOf("") }
    var lines by remember(items, quotes, supplier) {
        mutableStateOf(
            items.map { s ->
                val quoted = quotePrice(quotes, s.name, supplier)
                // 兜底单价：无报价 → 原料均价 → 最近采购价（避免采购单默认 ¥0）
                val base = (s.avg ?: 0.0).takeIf { it > 0 }
                    ?: (s.last ?: 0.0).takeIf { it > 0 } ?: 0.0
                val price = if (quoted > 0) quoted else base
                DraftLine(
                    ingredientId = s.ingredientId,
                    name = s.name,
                    unit = s.unit,
                    qtyText = fmtQty(s.suggestQty),
                    priceText = if (price > 0) trimNum(price) else "0",
                    basePrice = base
                )
            }
        )
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("开采购单 · ${items.size} 项", fontWeight = FontWeight.Bold) },
        text = {
            Column(
                Modifier
                    .fillMaxWidth()
                    .heightIn(max = 480.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text("确认量、单价、供应商后再生成采购草稿。", color = Sub, fontSize = 12.sp)
                Text("供应商", fontSize = 12.sp, color = Sub)
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    supplierOptions.forEach { s ->
                        val on = supplier == s
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(12.dp))
                                .background(if (on) Ink else CardBg)
                                .then(if (!on) Modifier.border(1.dp, Line, RoundedCornerShape(12.dp)) else Modifier)
                                .clickable {
                                    supplier = s
                                    lines = lines.map { line ->
                                        val p = quotePrice(quotes, line.name, s)
                                        // 新供应商无报价时，回落到兜底单价而非清零
                                        val target = if (p > 0) p else line.basePrice
                                        line.copy(priceText = if (target > 0) trimNum(target) else line.priceText)
                                    }
                                }
                                .padding(horizontal = 10.dp, vertical = 6.dp)
                        ) {
                            Text(s, color = if (on) CardBg else Ink, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = { Text("备注（可选）") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                lines.forEachIndexed { idx, line ->
                    Text(line.name, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(
                            value = line.qtyText,
                            onValueChange = { v ->
                                lines = lines.toMutableList().also {
                                    it[idx] = line.copy(qtyText = v)
                                }
                            },
                            label = { Text("数量 ${line.unit}") },
                            singleLine = true,
                            modifier = Modifier.weight(1f)
                        )
                        OutlinedTextField(
                            value = line.priceText,
                            onValueChange = { v ->
                                lines = lines.toMutableList().also {
                                    it[idx] = line.copy(priceText = v)
                                }
                            },
                            label = { Text("单价") },
                            singleLine = true,
                            modifier = Modifier.weight(1f)
                        )
                    }
                }
                val total = lines.sumOf {
                    (it.qtyText.toDoubleOrNull() ?: 0.0) * (it.priceText.toDoubleOrNull() ?: 0.0)
                }
                Text("合计约 ¥${trimNum(total)}", fontWeight = FontWeight.Bold, color = FiveRed)
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    val valid = lines.filter { (it.qtyText.toDoubleOrNull() ?: 0.0) > 0 }
                    if (valid.isEmpty()) return@TextButton
                    onSubmit(supplier, note, valid)
                }
            ) { Text("生成采购草稿") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        }
    )
}

private fun quotePrice(quotes: List<QuoteDto>, name: String, supplier: String): Double {
    if (quotes.isEmpty()) return 0.0
    val bySup = quotes.filter {
        val n = it.name ?: it.ing ?: ""
        n == name || n.contains(name) || name.contains(n)
    }
    val hit = bySup.firstOrNull {
        val s = it.supplier ?: it.src ?: ""
        s.isNotBlank() && (s == supplier || s.contains(supplier) || supplier.contains(s))
    } ?: bySup.firstOrNull()
    return hit?.price ?: 0.0
}

private fun trimNum(v: Double): String =
    if (v >= 100) "%.0f".format(v) else if (v >= 10) "%.1f".format(v) else "%.2f".format(v)

private fun fmtQty(v: Double): String =
    if (v >= 10) "%.0f".format(v) else "%.1f".format(v)

internal fun askRestockConfirm(
    items: List<RestockSuggestion>,
    rev: String?,
    suppliers: List<String> = emptyList(),
    quotes: List<QuoteDto> = emptyList(),
    onToast: (Boolean, String) -> Unit
) {
    RestockDraftBus.ask(items, rev, suppliers, quotes, onToast)
}

private fun submitRestockConfirm(
    lines: List<DraftLine>,
    supplier: String,
    note: String,
    rev: String?,
    onToast: (Boolean, String) -> Unit
) {
    val payload = buildJsonObject {
        put("supplier", supplier.ifBlank { "未指定供应商" })
        put(
            "note",
            buildString {
                append("App 缺货开单")
                if (note.isNotBlank()) {
                    append(" · ")
                    append(note)
                }
            }
        )
        put("items", buildJsonArray {
            lines.forEach { s ->
                add(
                    buildJsonObject {
                        put("ing_id", s.ingredientId)
                        put("name", s.name)
                        put("qty", s.qtyText.toDoubleOrNull() ?: 0.0)
                        put("unit", s.unit)
                        put("price", s.priceText.toDoubleOrNull() ?: 0.0)
                    }
                )
            }
        })
    }
    val names = lines.take(3).joinToString("、") { it.name } + if (lines.size > 3) "…" else ""
    val total = lines.sumOf {
        (it.qtyText.toDoubleOrNull() ?: 0.0) * (it.priceText.toDoubleOrNull() ?: 0.0)
    }
    ConfirmBus.ask(
        ConfirmRequest(
            title = "确认开采购单",
            summary = "供应商 $supplier · ${lines.size} 项（$names）· 约 ¥${trimNum(total)}。\n下一步：到「下单」确认；货到再进「入库」。",
            type = "restock.create",
            payload = payload,
            baseRev = rev,
            onResult = { result ->
                result.fold(
                    onSuccess = { onToast(true, "采购单已开 · 去「下单」页") },
                    onFailure = { onToast(false, it.message ?: "失败") }
                )
            }
        )
    )
}
