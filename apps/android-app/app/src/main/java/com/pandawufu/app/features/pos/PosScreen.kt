package com.pandawufu.app.features.pos

import com.pandawufu.app.features.modules.ModuleEntry
import com.pandawufu.app.ui.BossIa

import android.widget.Toast
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.AppModule
import com.pandawufu.app.confirm.ConfirmBus
import com.pandawufu.app.confirm.ConfirmRequest
import com.pandawufu.app.features.kitchen.PillTabRow
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.Line
import com.pandawufu.app.ui.designsystem.PageBg
import com.pandawufu.app.ui.designsystem.AppBgBrush
import com.pandawufu.app.ui.designsystem.PandaCard
import com.pandawufu.app.ui.designsystem.SmoothPane
import com.pandawufu.app.ui.designsystem.SoftRefreshBar
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.app.ui.designsystem.TableBusyBg
import com.pandawufu.app.ui.designsystem.TableBusyBorder
import com.pandawufu.app.ui.designsystem.TableBusyTxt
import com.pandawufu.app.ui.designsystem.TableCleanBg
import com.pandawufu.app.ui.designsystem.TableCleanBorder
import com.pandawufu.app.ui.designsystem.TableCleanTxt
import com.pandawufu.app.ui.designsystem.TableFreeBg
import com.pandawufu.app.ui.designsystem.TableFreeBorder
import com.pandawufu.app.ui.designsystem.TableFreeTxt
import com.pandawufu.app.ui.designsystem.TableRsvBg
import com.pandawufu.app.ui.designsystem.TableRsvBorder
import com.pandawufu.app.ui.designsystem.TableRsvTxt
import com.pandawufu.shared.model.ActionDto
import com.pandawufu.shared.model.DishDto
import com.pandawufu.shared.model.PosTableDto
import com.pandawufu.shared.pos.UndoStack
import com.pandawufu.shared.viewmodel.InventoryViewModel
import com.pandawufu.shared.viewmodel.ModulesViewModel
import com.pandawufu.shared.model.PosInsightDto
import com.pandawufu.app.features.modules.KvRow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.Locale
import kotlin.math.roundToInt

private val STATE_CYCLE = listOf("free", "busy", "clean", "rsv")
private enum class PosMode { STATE, SERVICE, MERGE, SPLIT }
private enum class PosPage { FLOOR, MENU, PAY }

private data class CartLine(val dish: DishDto, val qty: Int) {
    val amount: Double get() = (dish.price ?: 0.0) * qty
}

private fun cartItemsJson(cartLines: List<CartLine>) = buildJsonArray {
    cartLines.forEach { line ->
        add(
            buildJsonObject {
                put("id", line.dish.id)
                put("name", line.dish.name)
                val sku = line.dish.skuId?.takeIf { it.isNotBlank() } ?: line.dish.name
                put("sku", sku)
                line.dish.skuId?.takeIf { it.isNotBlank() }?.let { put("sku_id", it) }
                put("qty", line.qty)
                put("price", line.dish.price ?: 0.0)
                put("amount", line.amount)
            }
        )
    }
}

@Composable
fun PosScreen() {
    val viewModel = remember { InventoryViewModel(AppModule.inventoryRepository) }
    val modVm = remember { ModulesViewModel(AppModule.modulesRepository) }
    val state by viewModel.state.collectAsState()
    val modState by modVm.state.collectAsState()
    val context = LocalContext.current
    val undo = remember { UndoStack("pos-floor") }
    var undoTick by remember { mutableIntStateOf(0) }
    var mode by remember { mutableStateOf(PosMode.STATE) }
    var selected by remember { mutableStateOf<List<String>>(emptyList()) }
    val pendingTable = remember { ModuleEntry.consumeTable() }
    var page by remember {
        val idx = if (pendingTable != null) PosPage.PAY.ordinal
        else ModuleEntry.consumePill(0).coerceIn(0, PosPage.entries.lastIndex)
        mutableStateOf(PosPage.entries[idx])
    }
    var cart by remember { mutableStateOf<Map<String, CartLine>>(emptyMap()) }
    // 深链预选桌台（前厅「收钱」→ 直接落到结账页并选中该桌）
    var payTableId by remember { mutableStateOf(pendingTable) }
    var dishCat by remember { mutableStateOf(AppModule.modulePrefs.posDefaultCat()) }
    var serviceTable by remember { mutableStateOf<PosTableDto?>(null) }
    var voidTable by remember { mutableStateOf<PosTableDto?>(null) }
    var voidPick by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        AppModule.ensureSession()
        viewModel.dispatch(InventoryViewModel.InventoryIntent.Refresh)
        modVm.dispatch(ModulesViewModel.Intent.LoadPos)
        dishCat = AppModule.modulePrefs.posDefaultCat()
    }

    val tables = state.posTables
    val dishes = state.dishes
    val cartLines = cart.values.toList()
    val cartTotal = cartLines.sumOf { it.amount }
    val cartCount = cartLines.sumOf { it.qty }
    val busyCount = tables.count { it.state == "busy" }
    val cleanCount = tables.count { it.state == "clean" }

    fun askConfirm(
        title: String,
        summary: String,
        type: String,
        payload: kotlinx.serialization.json.JsonObject,
        undoLabel: String? = null,
        undoBefore: String? = null,
        undoAfter: String? = null,
        after: (() -> Unit)? = null
    ) {
        ConfirmBus.ask(
            ConfirmRequest(
                title = title,
                summary = summary,
                type = type,
                payload = payload,
                baseRev = state.rev,
                onResult = { r: Result<ActionDto> ->
                    if (r.isSuccess && undoLabel != null && undoBefore != null && undoAfter != null) {
                        undo.push(undoLabel, undoBefore, undoAfter, System.currentTimeMillis())
                        undoTick++
                    }
                    Toast.makeText(
                        context,
                        r.fold({ "已确认" }, { it.message ?: "失败" }),
                        Toast.LENGTH_SHORT
                    ).show()
                    if (r.isSuccess) {
                        viewModel.dispatch(InventoryViewModel.InventoryIntent.Refresh)
                        if (type == "pos.pay") cart = emptyMap()
                        after?.invoke()
                    }
                    selected = emptyList()
                    mode = PosMode.STATE
                }
            )
        )
    }

    fun addDish(d: DishDto) {
        val cur = cart[d.id]
        cart = cart + (d.id to CartLine(d, (cur?.qty ?: 0) + 1))
    }

    fun decDish(id: String) {
        val cur = cart[id] ?: return
        cart = if (cur.qty <= 1) cart - id
        else cart + (id to cur.copy(qty = cur.qty - 1))
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(AppBgBrush)
            .padding(horizontal = 14.dp, vertical = 12.dp)
            .padding(bottom = 88.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        com.pandawufu.app.ui.designsystem.BrandBar(
            title = BossIa.Pos.TITLE,
            subtitle = when {
                page == PosPage.FLOOR && mode == PosMode.SERVICE ->
                    "服务模式 · 点就餐桌：加菜/催菜/退菜/打包/客诉"
                page == PosPage.FLOOR && busyCount > 0 ->
                    "就餐 $busyCount · 待清 $cleanCount · 点桌改态"
                page == PosPage.MENU && cartCount > 0 ->
                    "已点 $cartCount 份 · ¥${fmtMoney(cartTotal)}"
                page == PosPage.PAY ->
                    if (cartCount > 0) "待收 ¥${fmtMoney(cartTotal)}"
                    else "选已挂单桌或先点菜"
                tables.isEmpty() -> "先配桌台平面"
                else -> BossIa.Pos.SUB
            },
            onBack = com.pandawufu.app.features.modules.LocalModuleBack.current
        )
            PillTabRow(
            tabs = BossIa.Pos.pills,
            selected = page.ordinal,
            onSelect = { page = PosPage.entries[it] }
        )

        SoftRefreshBar(active = state.loading && tables.isNotEmpty())

        PosInsightCard(modState.pos?.insight)

        SmoothPane(key = page, modifier = Modifier.weight(1f).fillMaxWidth()) {
            when (page) {
                PosPage.FLOOR -> PosFloorPage(
                    tables = tables,
                    loading = state.loading,
                    mode = mode,
                    selected = selected,
                    undoSize = undo.size,
                    onMode = { mode = it; selected = emptyList() },
                    onSelect = { selected = it },
                    onServiceTable = { serviceTable = it },
                    onUndo = {
                        val op = undo.undo() ?: return@PosFloorPage
                        undoTick++
                        val parts = op.before.split("|")
                        if (parts.size >= 2) {
                            askConfirm(
                                title = "撤销 ${op.opType}",
                                summary = "回滚：${op.before}",
                                type = "pos.table_state",
                                payload = buildJsonObject {
                                    put("table_id", parts[0])
                                    put("state", parts[1])
                                }
                            )
                        }
                    },
                    onAsk = { title, summary, type, payload, ul, ub, ua ->
                        askConfirm(title, summary, type, payload, ul, ub, ua)
                    }
                )
                PosPage.MENU -> PosMenuPage(
                    dishes = dishes,
                    tables = tables,
                    dishCat = dishCat,
                    onCat = { dishCat = it },
                    cart = cart,
                    onAdd = ::addDish,
                    onDec = ::decDish,
                    onGoPay = { page = PosPage.PAY },
                    canWrite = AppModule.canWrite(),
                    onHang = { table ->
                        if (cartLines.isEmpty()) {
                            Toast.makeText(context, "请先点菜再挂单", Toast.LENGTH_SHORT).show()
                            return@PosMenuPage
                        }
                        val dishSummary = cartLines.joinToString("、") { "${it.dish.name}×${it.qty}" }
                        // FP-SALE-14：挂单（建后厨工单备料扣）前提示未配配方菜品不扣料
                        val noRecipeNames = cartLines.map { it.dish }.filter { !it.hasRecipe }.map { it.name }.distinct()
                        val recipeWarn = if (noRecipeNames.isNotEmpty()) {
                            "\n⚠ 以下菜品未配置配方，挂单/结账后不会扣减原料库存、成本按估算值：${noRecipeNames.joinToString("、")}"
                        } else ""
                        askConfirm(
                            title = "绑桌挂单",
                            summary = "桌 ${table.no ?: table.id} · ¥${fmtMoney(cartTotal)}\n$dishSummary\n挂单=就餐 · 并建后厨挂桌工单（备料扣；结账不叠扣）$recipeWarn",
                            type = "pos.table_state",
                            payload = buildJsonObject {
                                put("table_id", table.id)
                                put("no", table.no ?: table.id)
                                put("state", "busy")
                                put("amount", cartTotal)
                                put("bill_summary", dishSummary.take(120))
                                put("dish", dishSummary.take(80))
                                put("items", cartItemsJson(cartLines))
                                put("spawn_kitchen", true)
                            },
                            undoLabel = "hang",
                            undoBefore = "${table.id}|${table.state}",
                            undoAfter = "${table.id}|busy"
                        )
                        payTableId = table.id
                    }
            )
            PosPage.PAY -> PosPayPage(
                tables = tables,
                cartLines = cartLines,
                cartTotal = cartTotal,
                payTableId = payTableId,
                onPickTable = { payTableId = it },
                canWrite = AppModule.canWrite(),
                onClear = { cart = emptyMap() },
                onPay = { table, method ->
                    if (cartLines.isEmpty() && (table.amount == null || table.amount == 0.0) &&
                        table.billSummary.isNullOrBlank()
                    ) {
                        Toast.makeText(context, "请先点菜或选已挂单桌", Toast.LENGTH_SHORT).show()
                        page = PosPage.MENU
                        return@PosPayPage
                    }
                    val useCart = cartLines.isNotEmpty()
                    val amount = if (useCart) cartTotal else (table.amount ?: 0.0)
                    val dishSummary = if (useCart) {
                        cartLines.joinToString("、") { "${it.dish.name}×${it.qty}" }
                    } else {
                        table.billSummary ?: "挂单结账"
                    }
                    val qty = if (useCart) cartCount else 1
                    // FP-SALE-14：未配配方菜品告警（结账后不扣原料库存）
                    val noRecipeNames = if (useCart) {
                        cartLines.map { it.dish }.filter { !it.hasRecipe }.map { it.name }.distinct()
                    } else emptyList()
                    val recipeWarn = if (noRecipeNames.isNotEmpty()) {
                        "\n⚠ 以下菜品未配置配方，结账后不会扣减原料库存、成本按估算值：${noRecipeNames.joinToString("、")}"
                    } else ""
                    // 储值结账：需该桌已识别会员；结账成功后联动会员储值扣减
                    if (method == "储值" && table.vipMemberId.isNullOrBlank()) {
                        Toast.makeText(
                            context,
                            "该桌未识别会员，无法储值结账；请先在「会员·到店」识别会员",
                            Toast.LENGTH_SHORT
                        ).show()
                        return@PosPayPage
                    }
                    askConfirm(
                        title = "确认结账",
                        summary = "桌 ${table.no ?: table.id} · ¥${fmtMoney(amount)} · $method\n$dishSummary$recipeWarn",
                        type = "pos.pay",
                        payload = buildJsonObject {
                            put("table_id", table.id)
                            put("no", table.no ?: table.id)
                            put("amount", amount)
                            put("method", method)
                            put("channel", "堂食")
                            put("dish", dishSummary.take(80))
                            put("qty", qty)
                            put("deduct", true)
                            if (useCart) put("items", cartItemsJson(cartLines))
                        },
                        undoLabel = "pay",
                        undoBefore = "${table.id}|busy",
                        undoAfter = "${table.id}|free",
                        after = if (method == "储值") {
                            {
                                ConfirmBus.ask(
                                    ConfirmRequest(
                                        title = "会员储值扣减",
                                        summary = "${table.vipName ?: table.vipMemberId} · 扣 ¥${fmtMoney(amount)}（储值结账联动）",
                                        type = "vip.balance_deduct",
                                        payload = buildJsonObject {
                                            put("member_id", table.vipMemberId ?: "")
                                            put("amount", amount)
                                            put("table_id", table.id)
                                            put("note", "储值结账·桌 ${table.no ?: table.id}")
                                        },
                                        baseRev = null,
                                        onResult = { Toast.makeText(context, "储值扣减已提交", Toast.LENGTH_SHORT).show() }
                                    )
                                )
                            }
                        } else null
                    )
                }
            )
            }
        }
    }

    val svc = serviceTable
    if (svc != null) {
        AlertDialog(
            onDismissRequest = { serviceTable = null },
            title = {
                Text("桌 ${svc.no ?: svc.id} · 服务中", fontWeight = FontWeight.Bold)
            },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        "就餐桌快捷：加菜、催/齐/传、退菜、打包、客诉。改数经确认台。",
                        color = Sub,
                        fontSize = 12.sp
                    )
                    if (!svc.billSummary.isNullOrBlank()) {
                        Text("挂单：${svc.billSummary}", color = Ink, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    }
                    Button(
                        onClick = {
                            serviceTable = null
                            payTableId = svc.id
                            page = PosPage.MENU
                            mode = PosMode.STATE
                        },
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("加菜 / 点菜", fontWeight = FontWeight.Bold) }
                    OutlinedButton(
                        onClick = {
                            serviceTable = null
                            askConfirm(
                                title = "催菜",
                                summary = "桌 ${svc.no ?: svc.id} · 请后厨优先出品（催）",
                                type = "pos.rush",
                                payload = buildJsonObject {
                                    put("table_id", svc.id)
                                    put("no", svc.no ?: svc.id)
                                    put("action", "催菜")
                                    put("note", "前厅催菜")
                                }
                            )
                        },
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("催菜") }
                    OutlinedButton(
                        onClick = {
                            serviceTable = null
                            askConfirm(
                                title = "齐菜",
                                summary = "桌 ${svc.no ?: svc.id} · 挂桌工单标「待传」（齐）",
                                type = "pos.ready",
                                payload = buildJsonObject {
                                    put("table_id", svc.id)
                                    put("no", svc.no ?: svc.id)
                                    put("action", "齐菜")
                                    put("note", "前厅齐菜")
                                }
                            )
                        },
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("齐菜（待传）") }
                    OutlinedButton(
                        onClick = {
                            serviceTable = null
                            askConfirm(
                                title = "传菜上桌",
                                summary = "桌 ${svc.no ?: svc.id} · 挂桌工单收口「已完成」（传）",
                                type = "pos.pass",
                                payload = buildJsonObject {
                                    put("table_id", svc.id)
                                    put("no", svc.no ?: svc.id)
                                    put("action", "传菜")
                                    put("note", "前厅传菜上桌")
                                }
                            )
                        },
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("传菜上桌") }
                    OutlinedButton(
                        onClick = {
                            serviceTable = null
                            voidTable = svc
                            voidPick = svc.bill.firstOrNull()?.label()
                                ?: svc.billSummary?.split("、", "·", ",")?.firstOrNull()
                                    ?.substringBefore("×")?.trim()?.takeIf { it.isNotBlank() }
                        },
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("退菜", color = FiveRed) }
                    OutlinedButton(
                        onClick = {
                            serviceTable = null
                            askConfirm(
                                title = "打包外带",
                                summary = "桌 ${svc.no ?: svc.id} · 登记打包外带",
                                type = "pos.pack",
                                payload = buildJsonObject {
                                    put("table_id", svc.id)
                                    put("no", svc.no ?: svc.id)
                                    put("action", "打包")
                                    put("note", "堂食打包")
                                }
                            )
                        },
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("打包外带") }
                    OutlinedButton(
                        onClick = {
                            serviceTable = null
                            askConfirm(
                                title = "客诉当场",
                                summary = "桌 ${svc.no ?: svc.id} · 登记客诉并跟进",
                                type = "review.followup",
                                payload = buildJsonObject {
                                    put("table_id", svc.id)
                                    put("no", svc.no ?: svc.id)
                                    put("source", "堂食当场")
                                    put("status", "待跟进")
                                    put("content", "桌${svc.no ?: svc.id}客诉 · 前厅登记")
                                    put("owner", AppModule.role ?: "店长")
                                    put("note", "当场处理")
                                }
                            )
                        },
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("客诉当场", color = FiveRed) }
                    OutlinedButton(
                        onClick = {
                            serviceTable = null
                            payTableId = svc.id
                            page = PosPage.PAY
                            mode = PosMode.STATE
                        },
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("去结账") }
                }
            },
            confirmButton = {
                TextButton(onClick = { serviceTable = null }) { Text("关闭", color = Ink) }
            }
        )
    }

    val voidT = voidTable
    if (voidT != null) {
        val lines = voidT.bill
        val summaryBits = voidT.billSummary
            ?.split("、")
            ?.map { it.substringBefore("×").trim() }
            ?.filter { it.isNotBlank() }
            .orEmpty()
        val choices = when {
            lines.isNotEmpty() -> lines.map { it.label() }.distinct()
            summaryBits.isNotEmpty() -> summaryBits.distinct()
            else -> listOf("红饺", "黄饺", "绿饺", "紫饺", "黑饺")
        }
        val pick = voidPick ?: choices.firstOrNull().orEmpty()
        AlertDialog(
            onDismissRequest = { voidTable = null; voidPick = null },
            title = { Text("桌 ${voidT.no ?: voidT.id} · 退菜", fontWeight = FontWeight.Bold) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("从挂单反向减菜；经确认台后落库。", color = Sub, fontSize = 12.sp)
                    choices.forEach { name ->
                        val on = name == pick
                        OutlinedButton(
                            onClick = { voidPick = name },
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.fillMaxWidth(),
                            border = BorderStroke(
                                1.dp,
                                if (on) FiveRed else Line
                            )
                        ) {
                            Text(
                                if (on) "✓ $name" else name,
                                color = if (on) FiveRed else Ink,
                                fontWeight = if (on) FontWeight.Bold else FontWeight.Medium
                            )
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val dish = (voidPick ?: pick).ifBlank { return@TextButton }
                        val line = lines.firstOrNull { it.label() == dish }
                        voidTable = null
                        voidPick = null
                        askConfirm(
                            title = "退菜",
                            summary = "桌 ${voidT.no ?: voidT.id} · 退 $dish ×1",
                            type = "pos.void",
                            payload = buildJsonObject {
                                put("table_id", voidT.id)
                                put("no", voidT.no ?: voidT.id)
                                put("dish", dish)
                                line?.skuId?.takeIf { it.isNotBlank() }?.let { put("sku_id", it) }
                                line?.sku?.takeIf { it.isNotBlank() }?.let { put("sku", it) }
                                put("qty", 1)
                                put("reason", "前厅退菜")
                                put("note", "服务模式退菜")
                            }
                        )
                    }
                ) { Text("确认退菜", color = FiveRed, fontWeight = FontWeight.Bold) }
            },
            dismissButton = {
                TextButton(onClick = { voidTable = null; voidPick = null }) { Text("取消", color = Ink) }
            }
        )
    }
}

@Composable
private fun PosFloorPage(
    tables: List<PosTableDto>,
    loading: Boolean,
    mode: PosMode,
    selected: List<String>,
    undoSize: Int,
    onMode: (PosMode) -> Unit,
    onSelect: (List<String>) -> Unit,
    onServiceTable: (PosTableDto) -> Unit,
    onUndo: () -> Unit,
    onAsk: (String, String, String, kotlinx.serialization.json.JsonObject, String?, String?, String?) -> Unit
) {
    val context = LocalContext.current
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Text(
            when {
                tables.isEmpty() -> "店内快照暂无桌台。推送 data.pos 后可用。"
                !AppModule.canWrite() -> "只读账号不可改桌态"
                mode == PosMode.SERVICE -> "服务：点就餐桌 → 加菜/催菜/退菜/打包/客诉"
                mode == PosMode.MERGE -> "并单：先点源桌，再点目标桌"
                mode == PosMode.SPLIT -> "拆单：先点源桌，再点空闲目标桌"
                else -> "巡台：就餐(红)优先 · 点桌改态即可；服务请切「服务」"
            },
            style = MaterialTheme.typography.bodySmall,
            color = Sub
        )
        if (tables.isNotEmpty()) {
            val freeN = tables.count { it.state == "free" || it.state.isBlank() }
            val busyN = tables.count { it.state == "busy" }
            val cleanN = tables.count { it.state == "clean" }
            val rsvN = tables.count { it.state == "rsv" }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PatrolStat("就餐", busyN, FiveRed, Modifier.weight(1f))
                PatrolStat("待清", cleanN, TableCleanTxt, Modifier.weight(1f))
                PatrolStat("预订", rsvN, TableRsvTxt, Modifier.weight(1f))
                PatrolStat("空闲", freeN, FiveGreen, Modifier.weight(1f))
            }
        }
        if (tables.isEmpty() && !loading) {
            PandaCard {
                Text("暂无桌台", fontWeight = FontWeight.Bold)
                Text("请确认 snapshot_pusher 已推送 data.pos", style = MaterialTheme.typography.bodySmall, color = Sub)
            }
        }
        if (AppModule.canWrite() && tables.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ModeChip("改态", mode == PosMode.STATE) { onMode(PosMode.STATE) }
                ModeChip("服务", mode == PosMode.SERVICE) { onMode(PosMode.SERVICE) }
                ModeChip("并单", mode == PosMode.MERGE) { onMode(PosMode.MERGE) }
                ModeChip("拆单", mode == PosMode.SPLIT) { onMode(PosMode.SPLIT) }
                if (undoSize > 0) {
                    OutlinedButton(onClick = onUndo, shape = RoundedCornerShape(12.dp)) {
                        Text("撤销($undoSize)")
                    }
                }
            }
            val freeTable = tables.firstOrNull { it.state == "free" || it.state.isBlank() || it.state == "空闲" }
            if (freeTable != null) {
                Button(
                    onClick = {
                        onAsk(
                            "空闲开台",
                            "桌 ${freeTable.no ?: freeTable.id}：空闲 → 就餐",
                            "pos.table_state",
                            buildJsonObject {
                                put("table_id", freeTable.id)
                                put("state", "busy")
                                put("no", freeTable.no ?: freeTable.id)
                            },
                            "state",
                            "${freeTable.id}|free",
                            "${freeTable.id}|busy"
                        )
                    },
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth()
                ) { Text("空闲开台（${freeTable.no ?: freeTable.id}）", fontWeight = FontWeight.Bold) }
            }
        }
        val ordered = remember(tables) {
            tables.sortedBy {
                when (it.state) {
                    "busy" -> 0
                    "clean" -> 1
                    "rsv" -> 2
                    else -> 3
                }
            }
        }
        ordered.chunked(4).forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                row.forEach { table ->
                    Box(Modifier.weight(1f)) {
                        TableCell(
                            table = table,
                            clickable = AppModule.canWrite(),
                            selected = selected.contains(table.id),
                            patrolHighlight = table.state == "busy"
                        ) {
                            when (mode) {
                                PosMode.SERVICE -> {
                                    if (table.state == "busy") onServiceTable(table)
                                    else Toast.makeText(context, "请点就餐桌做服务", Toast.LENGTH_SHORT).show()
                                }
                                PosMode.STATE -> {
                                    val cur = table.state.ifBlank { "free" }
                                    val idx = STATE_CYCLE.indexOf(cur).let { if (it < 0) 0 else it }
                                    val next = STATE_CYCLE[(idx + 1) % STATE_CYCLE.size]
                                    val label = mapOf(
                                        "free" to "空闲", "busy" to "就餐",
                                        "clean" to "待清", "rsv" to "预订"
                                    )
                                    onAsk(
                                        "切换桌态",
                                        "桌 ${table.no ?: table.id}：${label[cur] ?: cur} → ${label[next] ?: next}",
                                        "pos.table_state",
                                        buildJsonObject {
                                            put("table_id", table.id)
                                            put("state", next)
                                            put("no", table.no ?: table.id)
                                        },
                                        "state",
                                        "${table.id}|$cur",
                                        "${table.id}|$next"
                                    )
                                }
                                PosMode.MERGE -> when (selected.size) {
                                    0 -> onSelect(listOf(table.id))
                                    1 -> if (selected[0] == table.id) onSelect(emptyList())
                                    else onAsk(
                                        "并单",
                                        "桌 ${selected[0]} 并入 ${table.id}",
                                        "pos.merge",
                                        buildJsonObject {
                                            put("from", selected[0])
                                            put("to", table.id)
                                            put("tables", JsonArray(listOf(JsonPrimitive(selected[0]), JsonPrimitive(table.id))))
                                        },
                                        "merge", "${selected[0]}|busy", "${table.id}|busy"
                                    )
                                    else -> onSelect(listOf(table.id))
                                }
                                PosMode.SPLIT -> when (selected.size) {
                                    0 -> onSelect(listOf(table.id))
                                    1 -> if (selected[0] == table.id) onSelect(emptyList())
                                    else onAsk(
                                        "拆单",
                                        "桌 ${selected[0]} 拆出到 ${table.id}",
                                        "pos.split",
                                        buildJsonObject {
                                            put("from", selected[0])
                                            put("to", table.id)
                                            put("tables", JsonArray(listOf(JsonPrimitive(selected[0]), JsonPrimitive(table.id))))
                                        },
                                        "split", "${table.id}|free", "${table.id}|busy"
                                    )
                                    else -> onSelect(listOf(table.id))
                                }
                            }
                        }
                    }
                }
                repeat(4 - row.size) { Box(Modifier.weight(1f)) }
            }
        }
        if (tables.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                LegendDot(TableFreeBg, "空闲 ${tables.count { it.state == "free" || it.state == "空闲" }}")
                LegendDot(TableBusyBg, "就餐 ${tables.count { it.state == "busy" || it.state == "就餐" }}")
                LegendDot(TableCleanBg, "待清 ${tables.count { it.state == "clean" || it.state == "待清" }}")
                LegendDot(TableRsvBg, "预订 ${tables.count { it.state == "rsv" || it.state == "预订" }}")
            }
        }
    }
}

@Composable
private fun PosMenuPage(
    dishes: List<DishDto>,
    tables: List<PosTableDto>,
    dishCat: String,
    onCat: (String) -> Unit,
    cart: Map<String, CartLine>,
    onAdd: (DishDto) -> Unit,
    onDec: (String) -> Unit,
    onGoPay: () -> Unit,
    canWrite: Boolean,
    onHang: (PosTableDto) -> Unit
) {
    var hangPick by remember { mutableStateOf(false) }
    val preferred = listOf("引流", "爆品", "利润", "形象", "常规")
    val cats = remember(dishes) {
        val fromDishes = dishes.map { it.cat ?: "常规" }.distinct()
        listOf("全部") + preferred.filter { c -> fromDishes.contains(c) || dishes.any { it.cat == c } } +
            listOf("五福饺") +
            fromDishes.filter { it !in preferred && it !in listOf("全部", "五福饺") }
    }
    val filtered = remember(dishes, dishCat) {
        when (dishCat) {
            "全部" -> dishes
            "五福饺" -> dishes.filter {
                val n = it.name
                n.contains("饺") || n.contains("五福") || n.contains("冰花")
            }
            else -> dishes.filter { (it.cat ?: "常规") == dishCat }
        }
    }
    val cartCount = cart.values.sumOf { it.qty }
    val cartTotal = cart.values.sumOf { it.amount }
    val hangTargets = remember(tables) {
        tables.sortedBy {
            when (it.state) {
                "free", "空闲", "" -> 0
                "busy", "就餐" -> 1
                else -> 2
            }
        }
    }

    if (hangPick) {
        AlertDialog(
            onDismissRequest = { hangPick = false },
            title = { Text("绑到哪一桌？", fontWeight = FontWeight.Bold) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("挂单后桌态变为就餐，金额写入桌台。", color = Sub, fontSize = 12.sp)
                    hangTargets.forEach { t ->
                        val st = when (t.state) {
                            "busy", "就餐" -> "就餐"
                            "clean", "待清" -> "待清"
                            "rsv", "预订" -> "预订"
                            else -> "空闲"
                        }
                        Text(
                            "${t.no ?: t.id} · $st" + (t.amount?.let { " · 已挂¥${fmtMoney(it)}" } ?: ""),
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    hangPick = false
                                    onHang(t)
                                }
                                .padding(vertical = 8.dp)
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { hangPick = false }) { Text("取消") }
            }
        )
    }

    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("堂食菜单 · 先点菜再「绑桌挂单」或去结账", fontSize = 12.sp, color = Sub)
        Row(
            Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            cats.forEach { c ->
                val n = when (c) {
                    "全部" -> dishes.size
                    "五福饺" -> dishes.count { it.name.contains("饺") || it.name.contains("五福") || it.name.contains("冰花") }
                    else -> dishes.count { (it.cat ?: "常规") == c }
                }
                val on = dishCat == c
                Box(
                    Modifier
                        .clip(RoundedCornerShape(16.dp))
                        .background(if (on) Ink else CardBg)
                        .then(if (!on) Modifier.border(1.dp, Line, RoundedCornerShape(16.dp)) else Modifier)
                        .clickable { onCat(c) }
                        .padding(horizontal = 12.dp, vertical = 7.dp)
                ) {
                    Text(
                        "$c $n",
                        color = if (on) CardBg else Ink,
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.Bold
                    )
                }
            }
        }
        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            if (filtered.isEmpty()) {
                PandaCard { Text("该类暂无在售菜品", color = Sub) }
            }
            filtered.forEach { d ->
                val q = cart[d.id]?.qty ?: 0
                val marginPct = d.grossMargin?.let { (it * 100).roundToInt() }
                    ?: d.price?.let { p -> d.cost?.let { c -> if (p > 0) ((p - c) / p * 100).roundToInt() else null } }
                PandaCard {
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(d.name, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                            Text(
                                listOfNotNull(
                                    d.cat ?: d.dishType,
                                    d.cost?.let { "成本¥${fmtMoney(it)}" },
                                    marginPct?.let { "毛利约$it%" }
                                ).joinToString(" · "),
                                fontSize = 11.sp,
                                color = Sub
                            )
                        }
                        Text(
                            "¥${fmtMoney(d.price ?: 0.0)}",
                            fontWeight = FontWeight.ExtraBold,
                            color = FiveRed,
                            fontSize = 16.sp
                        )
                        if (q > 0) {
                            Text("−", fontWeight = FontWeight.Bold, modifier = Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .background(Line)
                                .clickable { onDec(d.id) }
                                .padding(horizontal = 10.dp, vertical = 6.dp))
                            Text("$q", fontWeight = FontWeight.Bold)
                        }
                        Text("+", fontWeight = FontWeight.Bold, color = CardBg, modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .background(Ink)
                            .clickable { onAdd(d) }
                            .padding(horizontal = 10.dp, vertical = 6.dp))
                    }
                }
            }
        }
        if (cartCount > 0) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (canWrite && tables.isNotEmpty()) {
                    Box(
                        Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(14.dp))
                            .background(FiveGreen)
                            .clickable { hangPick = true }
                            .padding(14.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text("绑桌挂单", color = CardBg, fontWeight = FontWeight.Bold)
                    }
                }
                Box(
                    Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(14.dp))
                        .background(Ink)
                        .clickable(onClick = onGoPay)
                        .padding(14.dp)
                ) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("已点 $cartCount · 结账", color = CardBg, fontWeight = FontWeight.Bold)
                        Text("¥${fmtMoney(cartTotal)}", color = CardBg, fontWeight = FontWeight.ExtraBold)
                    }
                }
            }
        }
    }
}

@Composable
private fun PosPayPage(
    tables: List<PosTableDto>,
    cartLines: List<CartLine>,
    cartTotal: Double,
    payTableId: String?,
    onPickTable: (String) -> Unit,
    canWrite: Boolean,
    onClear: () -> Unit,
    onPay: (PosTableDto, String) -> Unit
) {
    val hung = tables.filter {
        (it.state == "busy" || it.state == "就餐") &&
            (it.amount != null || !it.billSummary.isNullOrBlank())
    }
    val pickables = tables.ifEmpty { emptyList() }
    val pickId = payTableId
        ?: hung.firstOrNull()?.id
        ?: tables.firstOrNull { it.state == "busy" || it.state == "就餐" }?.id
        ?: tables.firstOrNull()?.id
    val table = tables.firstOrNull { it.id == pickId }
    var method by remember { mutableStateOf("微信") }
    val displayTotal = if (cartLines.isNotEmpty()) cartTotal else (table?.amount ?: 0.0)

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        PandaCard {
            Text("本单合计", color = Sub, fontSize = 12.sp)
            Text("¥${fmtMoney(displayTotal)}", fontWeight = FontWeight.ExtraBold, fontSize = 28.sp, color = Ink)
            if (cartLines.isNotEmpty()) {
                cartLines.forEach {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("${it.dish.name} ×${it.qty}", fontSize = 13.sp)
                        Text("¥${fmtMoney(it.amount)}", fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    }
                }
                Text("清空购物车", color = Sub, fontSize = 12.sp, modifier = Modifier.clickable(onClick = onClear))
            } else if (!table?.billSummary.isNullOrBlank()) {
                Text("桌台挂单：${table?.billSummary}", fontSize = 13.sp)
                Text("也可回「点菜」加菜后结账", color = Sub, fontSize = 12.sp)
            } else {
                Text("还没点菜 · 先去点菜，或选已挂单桌", color = FiveRed, fontSize = 13.sp)
            }
        }
        PandaCard {
            Text("选择桌台（可开空闲桌结账）", fontWeight = FontWeight.Bold)
            if (pickables.isEmpty()) {
                Text("暂无桌台", color = Sub, fontSize = 12.sp)
            } else {
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    pickables.forEach { t ->
                        val on = t.id == pickId
                        val tag = when (t.state) {
                            "busy", "就餐" -> "就餐"
                            "clean", "待清" -> "待清"
                            "rsv", "预订" -> "预订"
                            else -> "空闲"
                        }
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(12.dp))
                                .background(if (on) FiveGreen else CardBg)
                                .border(1.dp, if (on) FiveGreen else Line, RoundedCornerShape(12.dp))
                                .clickable { onPickTable(t.id) }
                                .padding(horizontal = 12.dp, vertical = 8.dp)
                        ) {
                            Text(
                                "${t.no ?: t.id}·$tag" + (t.amount?.let { "¥${fmtMoney(it)}" } ?: ""),
                                color = if (on) CardBg else Ink,
                                fontWeight = FontWeight.Bold,
                                fontSize = 12.sp
                            )
                        }
                    }
                }
            }
        }
        PandaCard {
            Text("支付方式", fontWeight = FontWeight.Bold)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("微信", "支付宝", "现金", "储值").forEach { m ->
                    val on = method == m
                    Box(
                        Modifier
                            .clip(RoundedCornerShape(12.dp))
                            .background(if (on) Ink else CardBg)
                            .border(1.dp, if (on) Ink else Line, RoundedCornerShape(12.dp))
                            .clickable { method = m }
                            .padding(horizontal = 12.dp, vertical = 8.dp)
                    ) {
                        Text(m, color = if (on) CardBg else Ink, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                    }
                }
            }
        }
        val tableAmt = table?.amount
        val canPay = canWrite && table != null && (
            cartLines.isNotEmpty() || (tableAmt != null && tableAmt > 0) || !table.billSummary.isNullOrBlank()
            )
        if (canPay) {
            Button(
                onClick = { onPay(table!!, method) },
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(14.dp)
            ) {
                Text("确认收款 ¥${fmtMoney(displayTotal)}", fontWeight = FontWeight.Bold)
            }
        }
    }
}

private fun fmtMoney(v: Double): String =
    if (v == v.toLong().toDouble()) String.format(Locale.CHINA, "%.0f", v)
    else String.format(Locale.CHINA, "%.1f", v)

@Composable
private fun ModeChip(label: String, on: Boolean, onClick: () -> Unit) {
    Box(
        Modifier
            .clip(RoundedCornerShape(16.dp))
            .background(if (on) Ink else CardBg)
            .border(1.dp, if (on) Ink else Line, RoundedCornerShape(16.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp)
    ) {
        Text(label, color = if (on) CardBg else Ink, fontWeight = FontWeight.Bold, fontSize = 12.sp)
    }
}

@Composable
private fun LegendDot(color: Color, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(Modifier.size(10.dp).clip(RoundedCornerShape(3.dp)).background(color))
        Text(label, fontSize = 11.sp, color = Sub)
    }
}

@Composable
private fun TableCell(
    table: PosTableDto,
    clickable: Boolean,
    selected: Boolean,
    patrolHighlight: Boolean = false,
    onClick: () -> Unit
) {
    val st = table.state.ifBlank { "free" }
    val (bg, border, txt, label) = when (st) {
        "busy", "就餐" -> Quad(TableBusyBg, TableBusyBorder, TableBusyTxt, "就餐")
        "clean", "待清" -> Quad(TableCleanBg, TableCleanBorder, TableCleanTxt, "待清")
        "rsv", "预订" -> Quad(TableRsvBg, TableRsvBorder, TableRsvTxt, "预订")
        else -> Quad(TableFreeBg, TableFreeBorder, TableFreeTxt, "空闲")
    }
    val borderW = when {
        selected -> 2.5.dp
        patrolHighlight -> 2.5.dp
        else -> 1.5.dp
    }
    val borderC = when {
        selected -> Ink
        patrolHighlight -> FiveRed
        else -> border
    }
    Box(
        Modifier
            .fillMaxWidth()
            .aspectRatio(1f)
            .clip(RoundedCornerShape(11.dp))
            .background(bg)
            .border(borderW, borderC, RoundedCornerShape(11.dp))
            .semantics {
                contentDescription = "桌台 ${table.no ?: table.id} $label"
            }
            .then(if (clickable) Modifier.clickable(onClick = onClick) else Modifier),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(table.no ?: table.id, fontWeight = FontWeight.ExtraBold, color = txt, fontSize = 13.sp)
            val amt = table.amount
            Text(
                when {
                    amt != null && amt > 0 -> "¥${fmtMoney(amt)}"
                    patrolHighlight -> "久占关注"
                    else -> label
                },
                color = txt,
                fontSize = 10.sp
            )
        }
    }
}

@Composable
private fun PatrolStat(label: String, n: Int, color: Color, modifier: Modifier = Modifier) {
    Column(
        modifier
            .clip(RoundedCornerShape(10.dp))
            .background(CardBg)
            .border(1.dp, Line, RoundedCornerShape(10.dp))
            .padding(vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text("$n", fontWeight = FontWeight.ExtraBold, color = color, fontSize = 16.sp)
        Text(label, fontSize = 10.sp, color = Sub)
    }
}

private data class Quad<A, B, C, D>(val a: A, val b: B, val c: C, val d: D)

/** SI 堂食洞察卡：桌台四态 + 今日实收/支付方式 */
@Composable
private fun PosInsightCard(ins: PosInsightDto?) {
    if (ins == null) return
    PandaCard {
        Text("SI · 堂食经营", fontWeight = FontWeight.Bold, color = Ink, fontSize = 14.sp)
        ins.tables?.let { t ->
            KvRow(
                "桌台",
                "${t.total} 桌 · 空闲 ${t.byState["free"] ?: 0} · 就餐 ${t.byState["busy"] ?: 0} · 待清 ${t.byState["clean"] ?: 0} · 预订 ${t.byState["rsv"] ?: 0}"
            )
            t.occupancyPct?.let { KvRow("占用率", "$it%" + if (t.vipTables > 0) " · VIP 桌 ${t.vipTables}" else "") }
        }
        ins.payments?.let { p ->
            KvRow("今日实收", "¥${p.amount.toInt()} · ${p.count} 笔 · 桌均 ¥${p.avg.toInt()}")
            if (p.byMethod.isNotEmpty()) {
                KvRow("支付方式", p.byMethod.entries.joinToString(" · ") { "${it.key} ¥${it.value.toInt()}" })
            }
        }
        ins.revenue?.let { r ->
            if (r.dineToday > 0) KvRow("今日堂食销售", "¥${r.dineToday.toInt()}")
        }
        ins.advice.forEach {
            val warn = it.contains("待清") || it.contains("占用") || it.contains("未登记")
            Text("· $it", color = if (warn) FiveRed else Ink, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}
