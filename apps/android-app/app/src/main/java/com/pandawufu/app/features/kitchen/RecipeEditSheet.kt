package com.pandawufu.app.features.kitchen

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
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
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.Line
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.model.RecipeDto
import com.pandawufu.shared.repository.StockItem
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

data class BomEditLine(
    var name: String = "",
    var qty: String = "",
    var unit: String = "g",
    var ingId: String? = null
)

private val COLOR_OPTS = listOf("红", "黑", "黄", "绿", "紫", "白", "热", "凉", "汤", "甜")

/** 从「猪肉500g」拆成 name/qty/unit */
fun parseBomLineText(line: String): BomEditLine {
    val m = Regex("""^(.+?)(\d+(?:\.\d+)?)([a-zA-Z\u4e00-\u9fff]+)?\s*$""").find(line.trim())
    return if (m != null) {
        BomEditLine(
            name = m.groupValues[1].trim(),
            qty = m.groupValues[2],
            unit = m.groupValues[3].ifBlank { "g" }
        )
    } else BomEditLine(name = line.trim(), qty = "", unit = "g")
}

@Composable
fun RecipeEditDialog(
    initial: RecipeDto?,
    stock: List<StockItem>,
    baseRev: String?,
    onDismiss: () -> Unit,
    onSubmitted: () -> Unit
) {
    val context = LocalContext.current
    var name by remember { mutableStateOf(initial?.name ?: "") }
    var color by remember { mutableStateOf(initial?.color ?: "红") }
    var filling by remember { mutableStateOf(initial?.filling ?: "") }
    var faceMain by remember { mutableStateOf(initial?.faceMain ?: "") }
    var price by remember { mutableStateOf(initial?.price?.toString() ?: "") }
    var cost by remember { mutableStateOf(initial?.cost?.toString() ?: "") }
    var ensureIngs by remember { mutableStateOf(true) }
    var syncDish by remember { mutableStateOf(true) }
    var pickFor by remember { mutableStateOf<String?>(null) } // main/aux/seasoning
    var pickQuery by remember { mutableStateOf("") }

    val main = remember {
        mutableStateListOf<BomEditLine>().also { list ->
            (initial?.main ?: emptyList()).forEach { list.add(parseBomLineText(it)) }
            if (list.isEmpty()) list.add(BomEditLine())
        }
    }
    val aux = remember {
        mutableStateListOf<BomEditLine>().also { list ->
            (initial?.aux ?: emptyList()).forEach { list.add(parseBomLineText(it)) }
        }
    }
    val seasoning = remember {
        mutableStateListOf<BomEditLine>().also { list ->
            (initial?.seasoning ?: emptyList()).forEach { list.add(parseBomLineText(it)) }
        }
    }

    fun linesOf(key: String) = when (key) {
        "main" -> main
        "aux" -> aux
        else -> seasoning
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                if (initial == null) "新增菜谱" else "编辑配料 · ${initial.name}",
                fontWeight = FontWeight.Bold
            )
        },
        text = {
            Column(
                Modifier
                    .fillMaxWidth()
                    .heightIn(max = 520.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Text(
                    "配料优先从进销存产品库选；勾选「缺料自动建档」可顺带写入原料库。",
                    color = Sub,
                    fontSize = 12.sp
                )
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("菜谱名") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Text("色别", fontSize = 12.sp, color = Sub)
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    COLOR_OPTS.forEach { c ->
                        val on = color == c
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(14.dp))
                                .background(if (on) Ink else CardBg)
                                .then(if (!on) Modifier.border(1.dp, Line, RoundedCornerShape(14.dp)) else Modifier)
                                .clickable { color = c }
                                .padding(horizontal = 10.dp, vertical = 6.dp)
                        ) {
                            Text(c, color = if (on) CardBg else Ink, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }
                OutlinedTextField(
                    value = filling,
                    onValueChange = { filling = it },
                    label = { Text("馅心/副标题") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = faceMain,
                    onValueChange = { faceMain = it },
                    label = { Text("面皮色源（如火龙果汁）") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = price,
                        onValueChange = { price = it },
                        label = { Text("售价") },
                        singleLine = true,
                        modifier = Modifier.weight(1f)
                    )
                    OutlinedTextField(
                        value = cost,
                        onValueChange = { cost = it },
                        label = { Text("成本") },
                        singleLine = true,
                        modifier = Modifier.weight(1f)
                    )
                }

                BomSection("主馅", "main", main, onPick = { pickFor = "main"; pickQuery = "" })
                BomSection("辅料", "aux", aux, onPick = { pickFor = "aux"; pickQuery = "" })
                BomSection("调味", "seasoning", seasoning, onPick = { pickFor = "seasoning"; pickQuery = "" })

                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = ensureIngs, onCheckedChange = { ensureIngs = it })
                    Text("缺料自动建档到产品库", fontSize = 13.sp)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = syncDish, onCheckedChange = { syncDish = it })
                    Text("同步堂食菜品（可卖）", fontSize = 13.sp)
                }

                if (stock.isEmpty()) {
                    Text("库存未加载：可手填原料名，建议先到进销存补产品库。", color = FiveRed, fontSize = 12.sp)
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                if (!AppModule.canWrite()) {
                    Toast.makeText(context, "只读账号不可改菜谱", Toast.LENGTH_SHORT).show()
                    return@TextButton
                }
                val n = name.trim()
                if (n.isEmpty()) {
                    Toast.makeText(context, "请填写菜谱名", Toast.LENGTH_SHORT).show()
                    return@TextButton
                }
                fun pack(list: List<BomEditLine>): JsonArray = buildJsonArray {
                    list.filter { it.name.isNotBlank() }.forEach { line ->
                        add(
                            buildJsonObject {
                                put("name", line.name.trim())
                                line.qty.trim().toDoubleOrNull()?.let { put("qty", it) }
                                put("unit", line.unit.ifBlank { "g" })
                                line.ingId?.let { put("ing_id", it) }
                            }
                        )
                    }
                }
                ConfirmBus.ask(
                    ConfirmRequest(
                        title = if (initial == null) "新增菜谱" else "更新菜谱配料",
                        summary = buildString {
                            append(n)
                            append(" · 主馅${main.count { it.name.isNotBlank() }}")
                            append(" 辅料${aux.count { it.name.isNotBlank() }}")
                            append(" 调味${seasoning.count { it.name.isNotBlank() }}")
                            if (ensureIngs) append(" · 缺料建档")
                            if (syncDish) append(" · 同步菜品")
                        },
                        type = "recipe.upsert",
                        payload = buildJsonObject {
                            initial?.skuId?.let { put("sku_id", it) }
                            put("name", n)
                            put("color", color)
                            if (filling.isNotBlank()) put("filling", filling.trim())
                            if (faceMain.isNotBlank()) put("face_main", faceMain.trim())
                            put("main", pack(main))
                            put("aux", pack(aux))
                            put("seasoning", pack(seasoning))
                            price.toDoubleOrNull()?.let { put("price", it) }
                            cost.toDoubleOrNull()?.let { put("cost", it) }
                            put("ensure_ings", ensureIngs)
                            put("sync_dish", syncDish)
                        },
                        baseRev = baseRev,
                        onResult = { r ->
                            Toast.makeText(
                                context,
                                if (r.isSuccess) "已入队：菜谱 $n" else r.exceptionOrNull()?.message ?: "失败",
                                Toast.LENGTH_SHORT
                            ).show()
                            if (r.isSuccess) {
                                onSubmitted()
                                onDismiss()
                            }
                        }
                    )
                )
            }) { Text("确认台提交", fontWeight = FontWeight.Bold, color = FiveGreen) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        }
    )

    // 从产品库选原料
    if (pickFor != null) {
        val q = pickQuery.trim()
        val candidates = remember(stock, q) {
            stock
                .map { it.ingredient }
                .distinctBy { it.id }
                .filter {
                    q.isEmpty() ||
                        it.name.contains(q, ignoreCase = true) ||
                        (it.cat?.contains(q) == true)
                }
                .take(40)
        }
        AlertDialog(
            onDismissRequest = { pickFor = null },
            title = { Text("选产品库原料") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = pickQuery,
                        onValueChange = { pickQuery = it },
                        label = { Text("搜索原料") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    Column(
                        Modifier
                            .heightIn(max = 280.dp)
                            .verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        if (candidates.isEmpty()) {
                            Text("无匹配 · 可关闭后手填；勾选缺料建档会写入产品库", color = Sub, fontSize = 12.sp)
                        }
                        candidates.forEach { ing ->
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(8.dp))
                                    .clickable {
                                        val target = linesOf(pickFor!!)
                                        val empty = target.indexOfFirst { it.name.isBlank() }
                                        val line = BomEditLine(
                                            name = ing.name,
                                            qty = "",
                                            unit = ing.unit.ifBlank { "g" },
                                            ingId = ing.id
                                        )
                                        if (empty >= 0) target[empty] = line else target.add(line)
                                        pickFor = null
                                    }
                                    .padding(vertical = 8.dp, horizontal = 4.dp),
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Text(ing.name, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                                Text(ing.unit ?: "", color = Sub, fontSize = 12.sp)
                            }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { pickFor = null }) { Text("关闭") }
            }
        )
    }
}

@Composable
private fun BomSection(
    title: String,
    key: String,
    lines: MutableList<BomEditLine>,
    onPick: () -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(title, fontWeight = FontWeight.Bold, fontSize = 13.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("从产品库选", color = FiveGreen, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.clickable(onClick = onPick))
                Text("+行", color = Ink, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.clickable { lines.add(BomEditLine()) })
            }
        }
        lines.forEachIndexed { idx, line ->
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                OutlinedTextField(
                    value = line.name,
                    onValueChange = { lines[idx] = line.copy(name = it) },
                    label = { Text("原料") },
                    singleLine = true,
                    modifier = Modifier.weight(1.4f)
                )
                OutlinedTextField(
                    value = line.qty,
                    onValueChange = { lines[idx] = line.copy(qty = it) },
                    label = { Text("量") },
                    singleLine = true,
                    modifier = Modifier.weight(0.7f)
                )
                OutlinedTextField(
                    value = line.unit,
                    onValueChange = { lines[idx] = line.copy(unit = it) },
                    label = { Text("单位") },
                    singleLine = true,
                    modifier = Modifier.weight(0.6f)
                )
                Text("×", color = FiveRed, fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .clickable {
                            if (lines.size <= 1 && key == "main") lines[idx] = BomEditLine()
                            else lines.removeAt(idx)
                        }
                        .padding(4.dp))
            }
        }
    }
}
