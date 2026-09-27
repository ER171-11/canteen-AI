package com.pandawufu.app.features.inventory

import android.widget.Toast
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pandawufu.app.AppModule
import com.pandawufu.app.confirm.ConfirmBus
import com.pandawufu.app.confirm.ConfirmRequest
import com.pandawufu.app.confirm.KimiCtaByType
import com.pandawufu.app.features.kitchen.StatusTag
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.FiveYellow
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.model.AcceptStandardDto
import com.pandawufu.shared.model.RecvAcceptRecordDto
import com.pandawufu.shared.model.RecvLineDto
import com.pandawufu.shared.model.RecvRecordDto
import com.pandawufu.shared.viewmodel.InventoryViewModel
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * 入库 = 办货第3步：验收 → 入库。
 * 待入库单先按行验收（合格/让步/拒收），通过后再走 recv.inbound。
 */
@Composable
fun RecvTab(
    state: InventoryViewModel.InventoryState,
    onGoPurchase: () -> Unit = {},
    onRefresh: () -> Unit = {}
) {
    val context = LocalContext.current
    val awaiting = remember(state.orders) {
        state.orders.filter {
            val s = it.status.orEmpty()
            s == "已发" || s == "shipped" || s == "已下单"
        }
    }
    val draftLeft = remember(state.orders) {
        state.orders.count {
            val s = it.status.orEmpty()
            s != "已发" && s != "shipped" && s != "已下单" &&
                s != "已转进货" && s != "已入库" && s != "done"
        }
    }
    val stdByName = remember(state.acceptStandards) {
        state.acceptStandards.associateBy { it.ingName.trim() }
    }
    val acceptedKeys = remember(state.recvAccept) {
        state.recvAccept.mapNotNull { rec ->
            val id = rec.recvId?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val name = rec.ingName?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            "$id|$name" to rec
        }.toMap()
    }

    fun inbound(orderId: String, label: String) {
        ConfirmBus.ask(
            ConfirmRequest(
                title = "确认到货入库",
                summary = "将 $label 入库并改账面库存。",
                type = "recv.inbound",
                payload = buildJsonObject { put("order_id", orderId) },
                baseRev = state.rev,
                onResult = { result ->
                    Toast.makeText(
                        context,
                        result.fold({ "已入库 · 库存已更新" }, { it.message ?: "失败" }),
                        Toast.LENGTH_SHORT
                    ).show()
                    if (result.isSuccess) onRefresh()
                }
            )
        )
    }

    fun acceptLine(order: RecvRecordDto, line: RecvLineDto, verdict: String) {
        val ingName = lineLabel(line)
        if (ingName.isBlank()) {
            Toast.makeText(context, "无行名，无法验收", Toast.LENGTH_SHORT).show()
            return
        }
        ConfirmBus.ask(
            ConfirmRequest(
                title = "验收 · $verdict",
                summary = buildString {
                    append("${order.no ?: order.id} · $ingName")
                    line.qty?.let { append(" · 订 $it${line.unit.orEmpty()}") }
                    append("\n结论：$verdict")
                    stdByName[ingName]?.let { std ->
                        append("\n标准：")
                        append(stdBrief(std))
                    }
                },
                type = "recv.accept",
                payload = buildJsonObject {
                    put("recv_id", order.id)
                    put(
                        "items",
                        buildJsonArray {
                            add(
                                buildJsonObject {
                                    put("ing_name", ingName)
                                    line.qty?.let { put("qty_ordered", it) }
                                    if (verdict != "拒收" && verdict != "fail") {
                                        line.qty?.let { put("qty_received", it) }
                                    }
                                    if (verdict == "拒收" || verdict == "fail") {
                                        line.qty?.let { put("qty_rejected", it) }
                                    }
                                    put("verdict", verdict)
                                }
                            )
                        }
                    )
                },
                baseRev = state.rev,
                onResult = { result ->
                    Toast.makeText(
                        context,
                        result.fold({ "已登记验收 · $verdict" }, { it.message ?: "失败" }),
                        Toast.LENGTH_SHORT
                    ).show()
                    if (result.isSuccess) onRefresh()
                }
            )
        )
    }

    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("到货验收入库", fontWeight = FontWeight.ExtraBold)
                    Text(
                        "先对照验收标准逐项判定（合格/让步/拒收），通过后再确认入库改账面。",
                        style = MaterialTheme.typography.bodySmall,
                        color = Sub
                    )
                }
            }
        }

        item { AcceptStandardsSummary(state.acceptStandards) }

        item { KimiCtaByType("recv", baseRev = state.rev) }

        item {
            Text("待入库（${awaiting.size}）", style = MaterialTheme.typography.titleMedium)
        }

        if (awaiting.isEmpty()) {
            item {
                Card(
                    shape = RoundedCornerShape(14.dp),
                    colors = CardDefaults.cardColors(containerColor = CardBg),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            if (draftLeft > 0) "有 $draftLeft 张采购单还没下单"
                            else "暂无待到货单据",
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            if (draftLeft > 0) "先去「下单」页确认，货到再回这里验收入库。"
                            else "缺货开单 → 下单 → 再回来验收入库。",
                            style = MaterialTheme.typography.bodySmall,
                            color = Sub
                        )
                        OutlinedButton(
                            onClick = onGoPurchase,
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.fillMaxWidth()
                        ) { Text("去下单") }
                    }
                }
            }
        }

        items(awaiting, key = { "po-${it.id}" }) { rec ->
            val lines = rec.lines.orEmpty()
            val lineKeys = lines.map { "${rec.id}|${lineLabel(it)}" }
            val acceptedCount = lineKeys.count { acceptedKeys.containsKey(it) }
            val allAccepted = lines.isNotEmpty() && acceptedCount >= lines.size
            val anyFail = lineKeys.any { key ->
                val v = acceptedKeys[key]?.verdict.orEmpty()
                v == "fail" || v == "拒收"
            }
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
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
                                listOfNotNull(rec.supplier, rec.summary ?: rec.note, rec.date ?: rec.ts)
                                    .joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall
                            )
                            if (lines.isNotEmpty()) {
                                Text(
                                    "验收 $acceptedCount/${lines.size}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = if (allAccepted && !anyFail) FiveGreen else Sub
                                )
                            }
                        }
                        StatusTag(
                            when {
                                anyFail -> "有拒收"
                                allAccepted -> "已验收"
                                else -> "待入库"
                            },
                            when {
                                anyFail -> FiveRed
                                allAccepted -> FiveGreen
                                else -> FiveYellow
                            }
                        )
                    }

                    if (lines.isEmpty()) {
                        Text(
                            "无明细行 · 可直接入库，或回看采购摘要",
                            style = MaterialTheme.typography.bodySmall,
                            color = Sub
                        )
                    } else {
                        lines.forEach { line ->
                            val name = lineLabel(line)
                            val key = "${rec.id}|$name"
                            val prior = acceptedKeys[key]
                            val std = stdByName[name]
                            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                                ) {
                                    Column(Modifier.weight(1f)) {
                                        Text(
                                            buildString {
                                                append(name)
                                                line.qty?.let { append(" · $it${line.unit.orEmpty()}") }
                                            },
                                            style = MaterialTheme.typography.bodyMedium,
                                            fontWeight = FontWeight.Medium
                                        )
                                        std?.let {
                                            Text(
                                                stdBrief(it),
                                                style = MaterialTheme.typography.labelSmall,
                                                color = Sub
                                            )
                                        }
                                    }
                                    if (prior != null) {
                                        StatusTag(
                                            verdictLabel(prior.verdict),
                                            verdictColor(prior.verdict)
                                        )
                                    }
                                }
                                if (prior == null && AppModule.canWrite()) {
                                    Row(
                                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                                        modifier = Modifier.fillMaxWidth()
                                    ) {
                                        OutlinedButton(
                                            onClick = { acceptLine(rec, line, "合格") },
                                            shape = RoundedCornerShape(8.dp),
                                            modifier = Modifier.weight(1f)
                                        ) { Text("合格") }
                                        OutlinedButton(
                                            onClick = { acceptLine(rec, line, "让步") },
                                            shape = RoundedCornerShape(8.dp),
                                            modifier = Modifier.weight(1f)
                                        ) { Text("让步") }
                                        OutlinedButton(
                                            onClick = { acceptLine(rec, line, "拒收") },
                                            shape = RoundedCornerShape(8.dp),
                                            modifier = Modifier.weight(1f)
                                        ) { Text("拒收") }
                                    }
                                }
                            }
                        }
                    }

                    if (AppModule.canWrite()) {
                        val canInbound = lines.isEmpty() || (allAccepted && !anyFail)
                        Button(
                            onClick = { inbound(rec.id, rec.no ?: rec.id) },
                            enabled = canInbound,
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(
                                when {
                                    lines.isEmpty() -> "确认入库"
                                    anyFail -> "有拒收项 · 不可整单入库"
                                    !allAccepted -> "请先逐项验收"
                                    else -> "验收通过 · 确认入库"
                                }
                            )
                        }
                    }
                }
            }
        }

        item {
            Text(
                "验收记录（${state.recvAccept.size}）",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(top = 8.dp)
            )
        }
        if (state.recvAccept.isEmpty() && !state.loading) {
            item {
                Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                    Text("暂无验收记录", style = MaterialTheme.typography.bodySmall, color = Sub)
                }
            }
        }
        items(state.recvAccept, key = { "acc-${it.recvId}-${it.ingName}-${it.ts}" }) { rec ->
            RecvAcceptHistoryRow(rec)
        }

        item {
            Text(
                "入库历史（${state.recv.size}）",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(top = 8.dp)
            )
        }
        if (state.recv.isEmpty() && !state.loading) {
            item {
                Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                    Text("暂无入库记录", style = MaterialTheme.typography.bodySmall, color = Sub)
                }
            }
        }
        items(state.recv, key = { "jh-${it.id}" }) { rec ->
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    Modifier.padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(rec.no ?: rec.id, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
                        Text(
                            listOfNotNull(rec.supplier, rec.summary, rec.ts).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall
                        )
                    }
                    rec.amount?.let { Text("¥$it", style = MaterialTheme.typography.bodyMedium) }
                    StatusTag(
                        rec.status ?: "-",
                        if (rec.status == "已入库" || rec.status == "done") FiveGreen else FiveYellow
                    )
                }
            }
        }
    }
}

@Composable
private fun AcceptStandardsSummary(standards: List<AcceptStandardDto>) {
    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = CardBg),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("验收标准摘要", fontWeight = FontWeight.Bold)
            if (standards.isEmpty()) {
                Text("暂无标准库 · 推送后按规格/感官/温度验收", style = MaterialTheme.typography.bodySmall, color = Sub)
            } else {
                Text(
                    "共 ${standards.size} 项 · 下列为常用摘要",
                    style = MaterialTheme.typography.bodySmall,
                    color = Sub
                )
                standards.take(6).forEach { std ->
                    Text(
                        "· ${std.ingName}：${stdBrief(std)}",
                        style = MaterialTheme.typography.bodySmall
                    )
                }
                if (standards.size > 6) {
                    Text("… 其余 ${standards.size - 6} 项在行内对照", style = MaterialTheme.typography.labelSmall, color = Sub)
                }
            }
        }
    }
}

@Composable
private fun RecvAcceptHistoryRow(rec: RecvAcceptRecordDto) {
    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = CardBg),
        modifier = Modifier.fillMaxWidth()
    ) {
        Row(
            Modifier.padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    rec.ingName ?: "—",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    listOfNotNull(
                        rec.recvId,
                        listOfNotNull(
                            rec.qtyReceived?.let { "收$it" },
                            rec.qtyRejected?.let { "拒$it" }
                        ).takeIf { it.isNotEmpty() }?.joinToString("/"),
                        rec.batchNo?.let { "批$it" },
                        rec.ts
                    ).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = Sub
                )
            }
            StatusTag(verdictLabel(rec.verdict), verdictColor(rec.verdict))
        }
    }
}

private fun lineLabel(line: RecvLineDto): String =
    line.name?.takeIf { it.isNotBlank() } ?: line.ing?.takeIf { it.isNotBlank() } ?: ""

private fun stdBrief(std: AcceptStandardDto): String =
    listOfNotNull(
        std.specReq?.takeIf { it.isNotBlank() }?.let { "规格 $it" },
        std.sensory?.takeIf { it.isNotBlank() }?.let { "感官 $it" },
        std.tempReq?.takeIf { it.isNotBlank() }?.let { "温度 $it" },
        std.shelfLifeReq?.takeIf { it.isNotBlank() }?.let { "保质 $it" },
        std.certReq?.takeIf { it.isNotBlank() }?.let { "证件 $it" },
        std.weightTolPct?.let { "重量±${it}%" }
    ).joinToString(" · ").ifBlank { "见标准库" }

private fun verdictLabel(raw: String?): String = when (raw?.trim()?.lowercase()) {
    "pass", "合格", "ok" -> "合格"
    "warn", "让步", "concession" -> "让步"
    "fail", "拒收", "reject" -> "拒收"
    else -> raw?.takeIf { it.isNotBlank() } ?: "-"
}

private fun verdictColor(raw: String?): Color = when (raw?.trim()?.lowercase()) {
    "pass", "合格", "ok" -> FiveGreen
    "warn", "让步", "concession" -> FiveYellow
    "fail", "拒收", "reject" -> FiveRed
    else -> Sub
}
