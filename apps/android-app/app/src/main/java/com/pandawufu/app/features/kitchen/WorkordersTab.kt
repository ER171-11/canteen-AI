package com.pandawufu.app.features.kitchen

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
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
import com.pandawufu.shared.viewmodel.KitchenViewModel

// 原型 kt-sop：工单倒排时间线（done/now 状态点）
@Composable
fun WorkordersTab(state: KitchenViewModel.KitchenState) {
    if (state.loading && state.workorders.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        return
    }
    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        items(state.workorders, key = { it.id }) { wo ->
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Box(Modifier.size(12.dp).clip(CircleShape).background(colorOfFive(wo.color)))
                        Text("${wo.name} · 工单", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
                        Text("计划 ${wo.qty} 份", style = MaterialTheme.typography.bodySmall)
                        wo.plannedStart?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                        StatusTag(wo.status, if (wo.status == "doing" || wo.status == "进行中") FiveRedC else FiveGreenC)
                    }
                    // 时间线：step_no 顺序即倒排计划序列；done/now 由 status 字段推断
                    wo.steps.forEach { step ->
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
                            Box(
                                Modifier
                                    .padding(top = 4.dp)
                                    .size(8.dp)
                                    .clip(CircleShape)
                                    .background(
                                        when (step.params?.get("state")?.toString()?.trim('"')) {
                                            "done" -> FiveGreenC
                                            "now" -> FiveRedC
                                            else -> SubC
                                        }
                                    )
                            )
                            Column {
                                Text("${step.stepNo}. ${step.stage}（${step.durationMin ?: "-"}min）", style = MaterialTheme.typography.bodyMedium)
                                step.keyPoints.firstOrNull()?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                                step.qcPoint?.let { Text("✓ $it", style = MaterialTheme.typography.bodySmall, color = FiveGreenC) }
                            }
                        }
                    }
                }
            }
        }
    }
}
