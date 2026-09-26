package com.pandawufu.app.features.inventory

import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pandawufu.app.AppModule
import com.pandawufu.app.confirm.ConfirmBus
import com.pandawufu.app.confirm.ConfirmRequest
import com.pandawufu.app.confirm.OpsSignal
import com.pandawufu.app.features.kitchen.StatusTag
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FiveYellow
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.model.RecvRecordDto
import com.pandawufu.shared.viewmodel.InventoryViewModel
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private fun poStage(rec: RecvRecordDto): String = when (rec.status) {
    "已转进货", "已入库", "done" -> "已入库"
    "已发", "shipped", "已下单" -> "待到货"
    else -> "待下单"
}

/**
 * 采购单 = 办货第2步：对「缺货」开出的单做确认下单。
 * 入库动作留给「入库」页（待到货也可在此一键入库）。
 */
@Composable
fun PurchaseTab(
    state: InventoryViewModel.InventoryState,
    onGoRestock: () -> Unit = {},
    onGoRecv: () -> Unit = {},
    onRefresh: () -> Unit = {}
) {
    val context = LocalContext.current
    val docs = remember(state.orders) {
        state.orders.sortedWith(
            compareBy<RecvRecordDto> { rec ->
                when (poStage(rec)) {
                    "待下单" -> 0
                    "待到货" -> 1
                    else -> 2
                }
            }.thenByDescending { it.date ?: it.ts ?: it.no ?: it.id }
        )
    }
    val needOrder = docs.filter { poStage(it) == "待下单" }
    val awaiting = docs.filter { poStage(it) == "待到货" }
    val done = docs.filter { poStage(it) == "已入库" }
    val tip = OpsSignal.peekBanner()
    val fromRestock = tip?.contains("采购") == true || tip?.contains("补货") == true || tip?.contains("缺货") == true

    fun toast(msg: String) = Toast.makeText(context, msg, Toast.LENGTH_SHORT).show()

    fun markOrdered(rec: RecvRecordDto) {
        ConfirmBus.ask(
            ConfirmRequest(
                title = "确认下单给供应商",
                summary = "${rec.no ?: rec.id} · ${rec.supplier ?: "供应商"}\n打电话/下单后点确认；货到去「入库」改账面。",
                type = "order.mark",
                payload = buildJsonObject {
                    put("order_id", rec.id)
                    put("status", "已发")
                    put("note", "App 确认下单")
                    rec.supplier?.let { put("supplier", it) }
                },
                baseRev = state.rev,
                onResult = { result ->
                    result.fold(
                        onSuccess = {
                            toast("已下单 · 等货到入库")
                            onRefresh()
                        },
                        onFailure = { toast(it.message ?: "失败") }
                    )
                }
            )
        )
    }

    @Composable
    fun PoCard(rec: RecvRecordDto) {
        val stage = poStage(rec)
        Card(
            shape = RoundedCornerShape(14.dp),
            colors = CardDefaults.cardColors(containerColor = CardBg),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            rec.no ?: rec.id,
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            listOfNotNull(
                                rec.supplier,
                                rec.summary ?: rec.note,
                                rec.payable?.let { "应付¥$it" } ?: rec.amount?.let { "¥$it" },
                                rec.date ?: rec.ts
                            ).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall
                        )
                        if (!rec.lines.isNullOrEmpty()) {
                            Text(
                                rec.lines!!.take(4).joinToString("、") { line ->
                                    val q = line.qty?.let {
                                        if (it >= 10) "%.0f".format(it) else "%.1f".format(it)
                                    } ?: "?"
                                    "${line.name ?: line.ing ?: "料"}×$q${line.unit.orEmpty()}"
                                } + if (rec.lines!!.size > 4) "…" else "",
                                style = MaterialTheme.typography.labelSmall,
                                color = Sub
                            )
                        }
                    }
                    StatusTag(
                        stage,
                        if (stage == "已入库") FiveGreen else FiveYellow
                    )
                }
                if (AppModule.canWrite()) {
                    when (stage) {
                        "待下单" -> {
                            Button(
                                onClick = { markOrdered(rec) },
                                shape = RoundedCornerShape(10.dp),
                                modifier = Modifier.fillMaxWidth()
                            ) { Text("确认已下单给供应商") }
                        }
                        "待到货" -> {
                            Text(
                                "已下单 · 货到请去「入库」页改账面",
                                style = MaterialTheme.typography.labelSmall,
                                color = Sub
                            )
                            OutlinedButton(
                                onClick = onGoRecv,
                                shape = RoundedCornerShape(10.dp),
                                modifier = Modifier.fillMaxWidth()
                            ) { Text("去入库 ›") }
                        }
                    }
                }
            }
        }
    }

    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (fromRestock && !tip.isNullOrBlank()) {
            item {
                Card(
                    shape = RoundedCornerShape(14.dp),
                    colors = CardDefaults.cardColors(containerColor = CardBg),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("刚从缺货开出", fontWeight = FontWeight.ExtraBold)
                        Text(tip, style = MaterialTheme.typography.bodySmall, color = Sub)
                        Text(
                            "下一步：点「确认已下单」",
                            style = MaterialTheme.typography.bodySmall,
                            color = FiveGreen,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            "知道了",
                            color = Sub,
                            modifier = Modifier.clickable { OpsSignal.clearBanner() }
                        )
                    }
                }
            }
        }

        item {
            Text("下单 · 确认给供应商", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Text(
                "本页只下单不改库存 · 待下单 ${needOrder.size} · 待到货 ${awaiting.size}",
                style = MaterialTheme.typography.bodySmall,
                color = Sub
            )
        }

        if (docs.isEmpty() && !state.loading) {
            item {
                Card(
                    shape = RoundedCornerShape(14.dp),
                    colors = CardDefaults.cardColors(containerColor = CardBg),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("还没有采购单", fontWeight = FontWeight.Bold)
                        Text(
                            "先去「缺货」看建议，点「开采购单」。",
                            style = MaterialTheme.typography.bodySmall,
                            color = Sub
                        )
                        OutlinedButton(
                            onClick = onGoRestock,
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.fillMaxWidth()
                        ) { Text("去缺货建议") }
                    }
                }
            }
        }

        if (needOrder.isNotEmpty()) {
            item {
                Text("① 待下单", fontWeight = FontWeight.ExtraBold, color = FiveYellow)
            }
            items(needOrder, key = { "n-${it.id}" }) { PoCard(it) }
        }
        if (awaiting.isNotEmpty()) {
            item {
                Text("② 待到货", fontWeight = FontWeight.ExtraBold, color = FiveYellow)
            }
            items(awaiting, key = { "a-${it.id}" }) { PoCard(it) }
        }
        if (done.isNotEmpty()) {
            item {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text("③ 已入库（最近）", fontWeight = FontWeight.ExtraBold, color = FiveGreen)
                    Text(
                        "入库明细 ›",
                        color = FiveGreen,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.clickable(onClick = onGoRecv)
                    )
                }
            }
            items(done.take(8), key = { "d-${it.id}" }) { PoCard(it) }
        }
    }
}
