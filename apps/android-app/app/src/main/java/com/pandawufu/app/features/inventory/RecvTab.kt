package com.pandawufu.app.features.inventory

import android.widget.Toast
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pandawufu.app.features.kitchen.StatusTag
import com.pandawufu.app.ui.designsystem.AiPurple
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FiveYellow
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.viewmodel.InventoryViewModel

// 原型 inv-recv：进货入库记录（snapshot.recv）+ 拍照验货占位（Sprint 3 开放）
@Composable
fun RecvTab(state: InventoryViewModel.InventoryState) {
    val context = LocalContext.current
    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Box(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .border(1.dp, AiPurple, RoundedCornerShape(14.dp))
                    .clickable { Toast.makeText(context, "Kimi 拍照验货 Sprint 3 开放", Toast.LENGTH_SHORT).show() }
                    .padding(18.dp),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("📷 拍照验货", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold, color = AiPurple)
                    Text("对准送货单/实物 · Kimi 自动核对数量·鲜度·规格", style = MaterialTheme.typography.bodySmall, color = Sub)
                }
            }
        }
        item { Text("进货入库（${state.recv.size}）", style = MaterialTheme.typography.titleMedium) }
        if (state.recv.isEmpty() && !state.loading) {
            item {
                Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                    Text("暂无入库记录", style = MaterialTheme.typography.bodySmall, color = Sub)
                }
            }
        }
        items(state.recv, key = { it.id }) { rec ->
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text(rec.id, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
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
