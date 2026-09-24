package com.pandawufu.app.features.inventory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.pandawufu.app.AppModule
import com.pandawufu.app.features.kitchen.PillTabRow
import com.pandawufu.shared.viewmodel.InventoryViewModel

// 对应原型 p-inventory（pill 子页：库存 inv-stock / 补货 inv-restock / 采购 inv-po / 进货 inv-recv）
@Composable
fun InventoryScreen() {
    val viewModel = remember { InventoryViewModel(AppModule.inventoryRepository) }
    val state by viewModel.state.collectAsState()

    LaunchedEffect(Unit) { viewModel.dispatch(InventoryViewModel.InventoryIntent.Refresh) }

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("进销存", style = MaterialTheme.typography.titleLarge)
        PillTabRow(
            tabs = InventoryViewModel.InventoryTab.entries.map { it.label },
            selected = state.tab.ordinal,
            onSelect = { idx ->
                viewModel.dispatch(
                    InventoryViewModel.InventoryIntent.SelectTab(InventoryViewModel.InventoryTab.entries[idx])
                )
            }
        )
        if (state.error != null) {
            Text("加载失败：${state.error}", style = MaterialTheme.typography.bodySmall, color = Color(0xFFE8584A))
        }
        when (state.tab) {
            InventoryViewModel.InventoryTab.STOCK -> StockTab(state)
            InventoryViewModel.InventoryTab.RESTOCK -> RestockTab(state)
            InventoryViewModel.InventoryTab.PURCHASE -> PurchaseTab()
            InventoryViewModel.InventoryTab.RECV -> RecvTab(state)
        }
    }
}
