package com.pandawufu.app.features.kitchen

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
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.Line
import com.pandawufu.shared.viewmodel.KitchenViewModel

// 原型 kt-board：今日出品看板（五色进度条 + 合格率）
@Composable
fun BoardTab(state: KitchenViewModel.KitchenState) {
    if (state.loading && state.board.isEmpty()) {
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
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("今日出品看板", style = MaterialTheme.typography.titleMedium)
                    state.board.forEach { item ->
                        val barColor = colorOfFive(item.color)
                        val ratio = if (item.planned > 0) item.done.toFloat() / item.planned else 0f
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Box(
                                Modifier.size(22.dp).clip(CircleShape).background(barColor),
                                contentAlignment = Alignment.Center
                            ) { Text(item.color, color = androidx.compose.ui.graphics.Color.White, style = MaterialTheme.typography.labelSmall) }
                            Column(Modifier.weight(1f)) {
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                    Text("${item.done}/${item.planned}", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
                                    item.qcPassRate?.let {
                                        Text("合格率 ${(it * 100).toInt()}%", style = MaterialTheme.typography.bodySmall, color = FiveGreenC)
                                    }
                                }
                                Box(Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)).background(Line)) {
                                    Box(Modifier.fillMaxWidth(ratio.coerceIn(0f, 1f)).height(6.dp).clip(RoundedCornerShape(3.dp)).background(barColor))
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
