package com.pandawufu.app.features.inventory

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pandawufu.app.ui.designsystem.AiPink
import com.pandawufu.app.ui.designsystem.AiPurple
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.PageBg
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.viewmodel.InventoryViewModel

// 原型 inv-restock：补货建议（由库存告急/偏低项推导；AI 建议·需确认，转单走 ConfirmGateway——Sprint 后续接）
@Composable
fun RestockTab(state: InventoryViewModel.InventoryState) {
    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Box(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .background(PageBg)
                    .padding(10.dp)
            ) {
                Text(
                    "⚠ 补货建议由 AI 自动生成，自动生成 ≠ 自动下单；转采购需老板/店长确认。",
                    style = MaterialTheme.typography.bodySmall
                )
            }
        }
        if (state.restock.isEmpty() && !state.loading) {
            item {
                Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                    Text("暂无告急/偏低原料", style = MaterialTheme.typography.bodySmall, color = Sub)
                }
            }
        }
        items(state.restock, key = { it.ingredientId }) { s ->
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text("${s.name} · 补 ${s.suggestQty}${s.unit}", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
                        Text(s.reason, style = MaterialTheme.typography.bodySmall)
                        Box(
                            Modifier
                                .padding(top = 4.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(AiPink.copy(alpha = 0.2f))
                                .padding(horizontal = 6.dp, vertical = 2.dp)
                        ) {
                            Text("AI 建议 · 需确认", style = MaterialTheme.typography.labelSmall, color = AiPurple)
                        }
                    }
                    // 转单按钮：写操作，必须经 ConfirmGateway → /api/actions（Sprint 后续接入，先置灰）
                    Box(
                        Modifier
                            .clip(RoundedCornerShape(10.dp))
                            .background(Sub.copy(alpha = 0.3f))
                            .padding(horizontal = 14.dp, vertical = 8.dp)
                    ) {
                        Text("转单", style = MaterialTheme.typography.bodySmall, color = CardBg)
                    }
                }
            }
        }
    }
}
