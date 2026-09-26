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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pandawufu.app.AppModule
import com.pandawufu.app.confirm.ConfirmBus
import com.pandawufu.app.confirm.ConfirmRequest
import com.pandawufu.app.features.kitchen.StatusTag
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FiveYellow
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.viewmodel.InventoryViewModel
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * 入库 = 办货第3步：只处理「已下单待到货」；草稿请回「下单」页先确认。
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

    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("到货入库", fontWeight = FontWeight.ExtraBold)
                    Text(
                        "只显示已向供应商下过单的货。点入库后改库存账面。",
                        style = MaterialTheme.typography.bodySmall,
                        color = Sub
                    )
                }
            }
        }

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
                            if (draftLeft > 0) "先去「下单」页确认，货到再回这里入库。"
                            else "缺货开单 → 下单 → 再回来入库。",
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
                                listOfNotNull(rec.supplier, rec.summary ?: rec.note, rec.date ?: rec.ts)
                                    .joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall
                            )
                        }
                        StatusTag("待入库", FiveYellow)
                    }
                    if (AppModule.canWrite()) {
                        Button(
                            onClick = { inbound(rec.id, rec.no ?: rec.id) },
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.fillMaxWidth()
                        ) { Text("确认入库") }
                    }
                }
            }
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
