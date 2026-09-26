package com.pandawufu.app.features.kitchen

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pandawufu.app.AppModule
import com.pandawufu.app.confirm.ConfirmBus
import com.pandawufu.app.confirm.ConfirmRequest
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.Line
import com.pandawufu.shared.viewmodel.KitchenViewModel
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * 出品 = 后厨第2步：看出品进度与外卖待做。
 * 建工单统一在「工单」页；挂桌可标齐/确认传。
 */
@Composable
fun BoardTab(
    state: KitchenViewModel.KitchenState,
    viewModel: KitchenViewModel,
    onGoWorkorders: () -> Unit = {}
) {
    val context = LocalContext.current
    fun askPass(kind: String, tableId: String, no: String?) {
        if (!AppModule.canWrite()) {
            Toast.makeText(context, "当前岗位只读", Toast.LENGTH_SHORT).show()
            return
        }
        val (title, type, action, tip) = when (kind) {
            "pass" -> listOf("传菜 · 桌 ${no ?: tableId}", "pos.pass", "传菜", "挂桌工单→已完成")
            else -> listOf("齐菜 · 桌 ${no ?: tableId}", "pos.ready", "齐菜", "挂桌工单→待传")
        }
        ConfirmBus.ask(
            ConfirmRequest(
                title = title,
                summary = tip,
                type = type,
                payload = buildJsonObject {
                    put("table_id", tableId)
                    put("no", no ?: tableId)
                    put("action", action)
                    put("note", "后厨出品·$action")
                },
                baseRev = state.rev,
                onResult = { r ->
                    Toast.makeText(
                        context,
                        r.fold({ "已确认$action" }, { it.message ?: "失败" }),
                        Toast.LENGTH_SHORT
                    ).show()
                    if (r.isSuccess) viewModel.dispatch(KitchenViewModel.KitchenIntent.Refresh)
                }
            )
        )
    }

    if (state.loading && state.board.isEmpty() && state.takeoutOpen.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        return
    }
    LazyColumn(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            val d = state.demand
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("出品进度总览", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Text(
                        if (d == null) "加载本餐需求…"
                        else "建议 ${d.suggestPortions} 个 · 工单已建 ${d.workorderPlanned} · 缺口 ${d.gap} · 外卖待做 ${d.takeoutOpen}",
                        style = MaterialTheme.typography.bodySmall,
                        color = SubC
                    )
                    Text(
                        "工单推进：待开始→制作中→待传→已完成；本页可对桌齐/传。",
                        style = MaterialTheme.typography.bodySmall,
                        color = SubC
                    )
                    if ((d?.gap ?: 0) > 0) {
                        OutlinedButton(
                            onClick = onGoWorkorders,
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.fillMaxWidth()
                        ) { Text("缺口 ${d!!.gap} · 去工单建单 ›") }
                    }
                }
            }
        }

        if (state.takeoutOpen.isNotEmpty()) {
            item {
                Card(
                    shape = RoundedCornerShape(14.dp),
                    colors = CardDefaults.cardColors(containerColor = CardBg),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("外卖待做（${state.takeoutOpen.size}）", fontWeight = FontWeight.Bold)
                            Text(
                                "合队到工单 ›",
                                color = FiveRedC,
                                style = MaterialTheme.typography.labelSmall,
                                fontWeight = FontWeight.Bold,
                                modifier = Modifier.clickable(onClick = onGoWorkorders)
                            )
                        }
                        state.takeoutOpen.take(8).forEach { o ->
                            Text(
                                "${o.platform ?: "-"} ${o.platformNo ?: ""} · ¥${o.amount ?: "-"} · ${o.status ?: ""}",
                                style = MaterialTheme.typography.bodySmall
                            )
                        }
                    }
                }
            }
        }

        item {
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("今日出品看板", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        Text("实时", color = FiveGreenC, style = MaterialTheme.typography.labelSmall)
                    }
                    if (state.board.isEmpty()) {
                        Text(
                            "暂无出品进度 · 先去「工单」建单并推进",
                            style = MaterialTheme.typography.bodyMedium,
                            color = SubC,
                            modifier = Modifier.clickable(onClick = onGoWorkorders)
                        )
                    }
                    if (state.boardTables.isNotEmpty()) {
                        Text("按桌待传 · 齐/传", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelMedium)
                        state.boardTables.take(8).forEach { pt ->
                            Row(
                                Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    "桌 ${pt.tableLabel()} · 待${pt.pending}/做${pt.doing}" +
                                        if (pt.ready > 0) "/齐${pt.ready}" else "",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = Ink,
                                    modifier = Modifier.weight(1f)
                                )
                                Text(
                                    "齐",
                                    color = FiveYellowC,
                                    fontWeight = FontWeight.Bold,
                                    style = MaterialTheme.typography.labelMedium,
                                    modifier = Modifier
                                        .clickable { askPass("ready", pt.tableId, pt.tableNo) }
                                        .padding(horizontal = 6.dp)
                                )
                                Text(
                                    "传",
                                    color = FiveGreenC,
                                    fontWeight = FontWeight.Bold,
                                    style = MaterialTheme.typography.labelMedium,
                                    modifier = Modifier
                                        .clickable { askPass("pass", pt.tableId, pt.tableNo) }
                                        .padding(horizontal = 6.dp)
                                )
                            }
                        }
                    }
                    state.board.forEach { item ->
                        val barColor = colorOfFive(item.color)
                        val ratio = if (item.planned > 0) item.done.toFloat() / item.planned else 0f
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Box(
                                Modifier.size(22.dp).clip(CircleShape).background(barColor),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    item.color,
                                    color = androidx.compose.ui.graphics.Color.White,
                                    style = MaterialTheme.typography.labelSmall
                                )
                            }
                            Column(Modifier.weight(1f)) {
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                    Text(
                                        "${item.done}/${item.planned}" +
                                            if (item.doing > 0) " · 制作中 ${item.doing}" else "",
                                        style = MaterialTheme.typography.bodyMedium,
                                        fontWeight = FontWeight.Bold
                                    )
                                    item.qcPassRate?.let {
                                        Text(
                                            "合格率 ${(it * 100).toInt()}%",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = FiveGreenC
                                        )
                                    }
                                }
                                Box(
                                    Modifier
                                        .fillMaxWidth()
                                        .height(6.dp)
                                        .clip(RoundedCornerShape(3.dp))
                                        .background(Line)
                                ) {
                                    Box(
                                        Modifier
                                            .fillMaxWidth(ratio.coerceIn(0f, 1f))
                                            .height(6.dp)
                                            .clip(RoundedCornerShape(3.dp))
                                            .background(barColor)
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
