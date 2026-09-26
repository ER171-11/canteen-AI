package com.pandawufu.app.features.kitchen

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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.confirm.KimiCtaByType
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.viewmodel.KitchenViewModel

/**
 * 品控 = 后厨第3步：成品/摆盘拍照、留样与着装合规；记录在下。
 * 识别结论仅供参考，入账仍走确认台。
 */
@Composable
fun QcTab(state: KitchenViewModel.KitchenState) {
    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("品控抽检 · 对照菜谱标准", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.ExtraBold)
                    Text(
                        "成品/摆盘须符合菜谱质检点；识别≠入账，确认台点过后才落库。",
                        fontSize = 12.sp,
                        color = Sub
                    )
                }
            }
        }

        item {
            Text("出品拍照", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
        }
        item { KimiCtaByType("qc", baseRev = state.rev) }
        item { KimiCtaByType("plate", baseRev = state.rev) }

        item {
            Text("合规与留样", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
        }
        item { KimiCtaByType("sample", baseRev = state.rev) }
        item { KimiCtaByType("uniform", baseRev = state.rev) }

        item {
            Text(
                "品控记录${if (state.qc.isNotEmpty()) " · ${state.qc.size}" else ""}",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
        }
        if (state.loading && state.qc.isEmpty()) {
            item {
                Box(
                    Modifier.fillMaxWidth().padding(24.dp),
                    contentAlignment = Alignment.Center
                ) { CircularProgressIndicator() }
            }
        }
        if (!state.loading && state.qc.isEmpty()) {
            item {
                Text("暂无品控记录 · 拍一张成品开始", color = SubC, style = MaterialTheme.typography.bodySmall)
            }
        }
        items(state.qc, key = { it.id ?: it.ts ?: it.hashCode().toString() }) { rec ->
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
                        Text(
                            rec.name ?: rec.checkType ?: "品控记录",
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            listOfNotNull(rec.checkType, rec.ts, rec.inspector).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall
                        )
                        rec.note?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    }
                    rec.rate?.let {
                        Text("${(it * 100).toInt()}%", style = MaterialTheme.typography.bodyMedium, color = FiveGreenC)
                    }
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
