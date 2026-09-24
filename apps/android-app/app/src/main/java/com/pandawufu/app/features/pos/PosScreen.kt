package com.pandawufu.app.features.pos

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pandawufu.app.AppModule
import com.pandawufu.app.ui.designsystem.CardBg
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
import com.pandawufu.shared.model.PosTableDto
import com.pandawufu.shared.viewmodel.InventoryViewModel

// 对应原型 p-m-pos / pos-floor：桌台平面图（8 桌网格，四态配色取自原型 .tbl.*）。
// Sprint 1 只读：点击/长按不响应；并单/拆单为写操作，Sprint 5 开放（届时必须走
// kmp-shared pos.UndoStack + ConfirmGateway → /api/actions）。
@Composable
fun PosScreen() {
    // 桌台数据来自 snapshot.pos，复用 InventoryViewModel 的快照加载
    val viewModel = remember { InventoryViewModel(AppModule.inventoryRepository) }
    val state by viewModel.state.collectAsState()
    LaunchedEffect(Unit) { viewModel.dispatch(InventoryViewModel.InventoryIntent.Refresh) }

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("堂食收银 · 桌台", style = MaterialTheme.typography.titleLarge)

        // 工具条：并/拆单置灰（Sprint 5 开放）
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            DisabledToolButton("并单（Sprint 5 开放）")
            DisabledToolButton("拆单（Sprint 5 开放）")
        }

        LazyVerticalGrid(
            columns = GridCells.Fixed(4),
            horizontalArrangement = Arrangement.spacedBy(9.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp)
        ) {
            items(state.posTables, key = { it.id }) { table -> TableCell(table) }
        }

        // 图例 + 计数
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            LegendDot(TableFreeBg, "空闲 ${state.posTables.count { it.state == "free" }}")
            LegendDot(TableBusyBg, "就餐 ${state.posTables.count { it.state == "busy" }}")
            LegendDot(TableCleanBg, "待清 ${state.posTables.count { it.state == "clean" }}")
            LegendDot(TableRsvBg, "预订 ${state.posTables.count { it.state == "rsv" }}")
        }
    }
}

@Composable
private fun TableCell(table: PosTableDto) {
    val (bg, txt, border) = when (table.state) {
        "busy", "就餐" -> Triple(TableBusyBg, TableBusyTxt, TableBusyBorder)
        "clean", "待清" -> Triple(TableCleanBg, TableCleanTxt, TableCleanBorder)
        "rsv", "预订" -> Triple(TableRsvBg, TableRsvTxt, TableRsvBorder)
        else -> Triple(TableFreeBg, TableFreeTxt, TableFreeBorder)
    }
    val label = when (table.state) {
        "busy" -> "就餐"
        "clean" -> "待清"
        "rsv" -> "预订"
        else -> "空闲"
    }
    Column(
        Modifier
            .aspectRatio(1f)
            .clip(RoundedCornerShape(11.dp))
            .background(bg)
            .border(1.5.dp, border, RoundedCornerShape(11.dp)),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text(table.no ?: table.id, style = MaterialTheme.typography.titleMedium, color = txt, fontWeight = FontWeight.Bold)
        Text(label, style = MaterialTheme.typography.labelSmall, color = txt)
        table.seats?.let { Text("${it}座", style = MaterialTheme.typography.labelSmall, color = txt) }
    }
}

@Composable
private fun DisabledToolButton(text: String) {
    Box(
        Modifier
            .clip(RoundedCornerShape(10.dp))
            .background(Sub.copy(alpha = 0.3f))
            .padding(horizontal = 14.dp, vertical = 8.dp)
    ) {
        Text(text, style = MaterialTheme.typography.bodySmall, color = CardBg)
    }
}

@Composable
private fun LegendDot(color: Color, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(Modifier.size(10.dp).clip(RoundedCornerShape(5.dp)).background(color))
        Text(label, style = MaterialTheme.typography.bodySmall)
    }
}
