package com.pandawufu.app.features.inventory

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.unit.sp
import com.pandawufu.app.AppModule
import com.pandawufu.app.features.kitchen.PillTabRow
import com.pandawufu.app.ui.BossIa
import com.pandawufu.app.ui.designsystem.BrandBar
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.LoadStatusBanner
import com.pandawufu.app.ui.designsystem.PageBg
import com.pandawufu.app.ui.designsystem.SmoothPane
import com.pandawufu.app.ui.designsystem.SoftRefreshBar
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.util.LoadFailure
import com.pandawufu.shared.viewmodel.InventoryViewModel

/** 货品：库存 → 缺货 → 下单 → 入库；产品库/供应商为主数据 */
@Composable
fun InventoryScreen(
    initialTab: InventoryViewModel.InventoryTab = InventoryViewModel.InventoryTab.STOCK
) {
    val viewModel = remember { InventoryViewModel(AppModule.inventoryRepository) }
    val state by viewModel.state.collectAsState()

    fun go(tab: InventoryViewModel.InventoryTab) {
        if (tab == state.tab) {
            viewModel.dispatch(InventoryViewModel.InventoryIntent.Refresh)
        } else {
            viewModel.dispatch(InventoryViewModel.InventoryIntent.SelectTab(tab))
        }
    }

    LaunchedEffect(Unit) {
        AppModule.ensureSession()
        viewModel.dispatch(InventoryViewModel.InventoryIntent.SelectTab(initialTab))
        viewModel.dispatch(InventoryViewModel.InventoryIntent.Refresh)
    }

    val hasBody = state.stock.isNotEmpty() ||
        state.orders.isNotEmpty() ||
        state.recv.isNotEmpty() ||
        state.restock.isNotEmpty() ||
        state.vendors.isNotEmpty()

    Column(
        Modifier
            .fillMaxSize()
            .background(PageBg)
            .padding(horizontal = 14.dp, vertical = 12.dp)
            .padding(bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        BrandBar(
            title = BossIa.Brand.NAME,
            subtitle = BossIa.Brand.tabSubtitle(
                BossIa.Tab.GOODS,
                when (state.tab) {
                    InventoryViewModel.InventoryTab.STOCK -> BossIa.Goods.stockSub(
                        state.countCritical, state.countLow, state.stock.size
                    )
                    InventoryViewModel.InventoryTab.RESTOCK -> BossIa.Goods.RESTOCK_SUB
                    InventoryViewModel.InventoryTab.PURCHASE -> BossIa.Goods.PURCHASE_SUB
                    InventoryViewModel.InventoryTab.RECV -> BossIa.Goods.RECV_SUB
                    InventoryViewModel.InventoryTab.CATALOG -> BossIa.Goods.CATALOG_SUB
                    InventoryViewModel.InventoryTab.VENDORS ->
                        BossIa.Goods.VENDORS_SUB + " · ${state.vendors.size.coerceAtLeast(state.suppliers.size)} 家"
                }
            )
        )

        PillTabRow(
            tabs = InventoryViewModel.InventoryTab.entries.map { it.label },
            selected = state.tab.ordinal,
            onSelect = { idx -> go(InventoryViewModel.InventoryTab.entries[idx]) }
        )

        val onPipe = state.tab == InventoryViewModel.InventoryTab.RESTOCK ||
            state.tab == InventoryViewModel.InventoryTab.PURCHASE ||
            state.tab == InventoryViewModel.InventoryTab.RECV
        if (onPipe) {
            BuyPipelineStrip(active = state.tab, onStep = { go(it) })
        }

        SoftRefreshBar(active = state.loading && hasBody)

        if (state.error != null || state.emptyHint != null) {
            val fail = state.error?.let { LoadFailure.fromMessage(it) }
            LoadStatusBanner(
                error = fail?.error ?: state.error,
                hint = state.emptyHint ?: fail?.hint,
                onRetry = { viewModel.dispatch(InventoryViewModel.InventoryIntent.Refresh) }
            )
        } else if (
            state.tab == InventoryViewModel.InventoryTab.STOCK &&
            !state.loading &&
            state.stock.isEmpty() &&
            state.restock.isEmpty()
        ) {
            LoadStatusBanner(
                hint = LoadFailure.NO_SNAPSHOT_MSG,
                onRetry = { viewModel.dispatch(InventoryViewModel.InventoryIntent.Refresh) }
            )
        }
        SmoothPane(key = state.tab, modifier = Modifier.weight(1f, fill = false).fillMaxWidth()) {
            when (state.tab) {
                InventoryViewModel.InventoryTab.STOCK -> StockTab(
                    state = state,
                    onGoRestock = { go(InventoryViewModel.InventoryTab.RESTOCK) },
                    onGoCatalog = { go(InventoryViewModel.InventoryTab.CATALOG) }
                )
                InventoryViewModel.InventoryTab.CATALOG -> CatalogTab(
                    state = state,
                    onRefresh = { viewModel.dispatch(InventoryViewModel.InventoryIntent.Refresh) }
                )
                InventoryViewModel.InventoryTab.VENDORS -> VendorsTab(
                    state = state,
                    onRefresh = { viewModel.dispatch(InventoryViewModel.InventoryIntent.Refresh) }
                )
                InventoryViewModel.InventoryTab.RESTOCK -> RestockTab(
                    state = state,
                    onOpenedPo = { go(InventoryViewModel.InventoryTab.PURCHASE) }
                )
                InventoryViewModel.InventoryTab.PURCHASE -> PurchaseTab(
                    state = state,
                    onGoRestock = { go(InventoryViewModel.InventoryTab.RESTOCK) },
                    onGoRecv = { go(InventoryViewModel.InventoryTab.RECV) },
                    onRefresh = { viewModel.dispatch(InventoryViewModel.InventoryIntent.Refresh) }
                )
                InventoryViewModel.InventoryTab.RECV -> RecvTab(
                    state = state,
                    onGoPurchase = { go(InventoryViewModel.InventoryTab.PURCHASE) },
                    onRefresh = { viewModel.dispatch(InventoryViewModel.InventoryIntent.Refresh) }
                )
            }
        }
    }
}

@Composable
private fun BuyPipelineStrip(
    active: InventoryViewModel.InventoryTab,
    onStep: (InventoryViewModel.InventoryTab) -> Unit
) {
    val steps = listOf(
        InventoryViewModel.InventoryTab.RESTOCK to "缺货",
        InventoryViewModel.InventoryTab.PURCHASE to "下单",
        InventoryViewModel.InventoryTab.RECV to "入库"
    )
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(Color.White)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        steps.forEachIndexed { i, (tab, label) ->
            val on = tab == active
            Text(
                "${i + 1}.$label",
                fontSize = 12.sp,
                fontWeight = if (on) FontWeight.ExtraBold else FontWeight.Medium,
                color = when {
                    on -> FiveGreen
                    else -> Sub
                },
                modifier = Modifier.clickable { onStep(tab) }
            )
            if (i < steps.lastIndex) {
                Text("→", fontSize = 12.sp, color = if (on) Ink else Sub)
            }
        }
    }
}
