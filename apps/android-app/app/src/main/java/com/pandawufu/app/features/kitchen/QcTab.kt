package com.pandawufu.app.features.kitchen

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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pandawufu.app.ui.designsystem.AiPurple
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.Line
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.viewmodel.KitchenViewModel

// 原型 kt-qc：品控记录 + Kimi 拍照入口（Sprint 3 开放）
@Composable
fun QcTab(state: KitchenViewModel.KitchenState) {
    val context = LocalContext.current
    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            // Kimi 成品拍照入口占位（Sprint 3 开放）
            Box(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .border(1.dp, AiPurple, RoundedCornerShape(14.dp))
                    .clickable { Toast.makeText(context, "Kimi 拍照品控 Sprint 3 开放", Toast.LENGTH_SHORT).show() }
                    .padding(18.dp),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("📷 拍成品照", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold, color = AiPurple)
                    Text("饺子成品 · Kimi 识别褶纹/色泽/形态/重量估值", style = MaterialTheme.typography.bodySmall, color = Sub)
                }
            }
        }
        item {
            Text("品控记录", style = MaterialTheme.typography.titleMedium)
        }
        if (state.loading && state.qc.isEmpty()) {
            item { Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
        }
        items(state.qc, key = { it.id ?: it.ts ?: it.hashCode().toString() }) { rec ->
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text(rec.name ?: rec.checkType ?: "品控记录", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
                        Text(
                            listOfNotNull(rec.checkType, rec.ts, rec.inspector).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall
                        )
                        rec.note?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    }
                    rec.rate?.let { Text("${(it * 100).toInt()}%", style = MaterialTheme.typography.bodyMedium, color = FiveGreenC) }
                    StatusTag(
                        rec.result ?: "-",
                        when (rec.result) {
                            "pass", "合格" -> FiveGreenC
                            "fail", "不合格" -> FiveRedC
                            else -> FiveYellowC
                        }
                    )
                }
            }
        }
    }
}
