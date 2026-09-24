package com.pandawufu.app.features.inventory

import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pandawufu.app.features.kitchen.StatusTag
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.FiveYellow
import com.pandawufu.app.ui.designsystem.Line
import com.pandawufu.shared.repository.StockStatus
import com.pandawufu.shared.viewmodel.InventoryViewModel

// 原型 inv-stock：donut（充足/偏低/告急占比）+ 原料行（安全线进度条 + 状态 Tag）
@Composable
fun StockTab(state: InventoryViewModel.InventoryState) {
    if (state.loading && state.stock.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        return
    }
    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    StockDonut(state.countEnough, state.countLow, state.countCritical)
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        DonutLegend(FiveGreen, "充足", state.countEnough)
                        DonutLegend(FiveYellow, "偏低", state.countLow)
                        DonutLegend(FiveRed, "告急", state.countCritical)
                    }
                }
            }
        }
        item { Text("原料库存（${state.stock.size}）", style = MaterialTheme.typography.titleMedium) }
        items(state.stock, key = { it.ingredient.id }) { item ->
            val statusColor = when (item.status) {
                StockStatus.ENOUGH -> FiveGreen
                StockStatus.LOW -> FiveYellow
                StockStatus.CRITICAL -> FiveRed
            }
            val ratio = if (item.safety > 0) (item.qty / item.safety).toFloat().coerceIn(0f, 1f) else 1f
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text(item.ingredient.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
                        Text("${item.ingredient.cat ?: "原料"} · 安全 ${item.safety}${item.ingredient.unit}", style = MaterialTheme.typography.bodySmall)
                    }
                    Column(Modifier.weight(1f)) {
                        Text("${item.qty}/${item.safety}${item.ingredient.unit}", style = MaterialTheme.typography.bodySmall)
                        Box(Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)).background(Line)) {
                            Box(Modifier.fillMaxWidth(ratio).height(6.dp).clip(RoundedCornerShape(3.dp)).background(statusColor))
                        }
                    }
                    StatusTag(item.status.label, statusColor)
                }
            }
        }
    }
}

@Composable
private fun StockDonut(enough: Int, low: Int, critical: Int) {
    val total = (enough + low + critical).coerceAtLeast(1)
    androidx.compose.foundation.Canvas(Modifier.size(96.dp)) {
        val stroke = Stroke(width = 22.dp.toPx())
        var start = -90f
        listOf(
            FiveGreen to enough,
            FiveYellow to low,
            FiveRed to critical
        ).forEach { (color, count) ->
            val sweep = 360f * count / total
            if (sweep > 0f) drawArc(color, start, sweep, useCenter = false, style = stroke)
            start += sweep
        }
    }
}

@Composable
private fun DonutLegend(color: Color, label: String, count: Int) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(10.dp).clip(RoundedCornerShape(5.dp)).background(color))
        Text("$label  $count 项", style = MaterialTheme.typography.bodySmall)
    }
}
