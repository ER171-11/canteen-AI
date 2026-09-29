package com.pandawufu.app.features.fronthall

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.app.ui.designsystem.Txt
import com.pandawufu.shared.model.PosTableDto

// 四态配色（与 PosScreen 桌面风格保持一致）
private val ST_FREE = Color(0xFF9AA3B2)   // 空闲
private val ST_BUSY = Color(0xFF4C8BF5)   // 就餐
private val ST_CLEAN = Color(0xFFF2B233)  // 待清
private val ST_RSV = Color(0xFFB78BE8)    // 预订

/** 待清台超过该分钟数即视为超时（红字高亮） */
private const val CLEAN_TIMEOUT_MIN = 15

/**
 * B 块「前厅移动桌态监控」。
 * 顶部四项汇总条 + 网格桌位卡（四态着色）+ 待清台按等待时长排序与超时高亮 + 数据更新时间标注。
 */
@Composable
fun TableBoardSection(tables: List<PosTableDto>, rev: String?) {
    val busy = tables.count { it.state == "busy" || it.state == "就餐" }
    val clean = tables.filter { it.state == "clean" }
    val rsv = tables.count { it.state == "rsv" || it.state == "预订" }
    val ordered = tables.sumOf { t -> t.bill.sumOf { (it.qty ?: 0) } }
    val paid = clean.count { (it.amount ?: 0.0) > 0 || !it.billSummary.isNullOrBlank() }

    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = CardBg),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("桌态看板", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.ExtraBold)
                rev?.let {
                    Text("　数据更新 rev $it", fontSize = 11.sp, color = Sub)
                }
            }

            // 四项汇总条
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Kpi("就餐桌数", busy, ST_BUSY)
                Kpi("已点菜数", ordered, Txt)
                Kpi("已结账数", paid, ST_FREE)
                Kpi("待清台数", clean.size, ST_CLEAN)
            }

            // 网格桌位卡（每排 4 张）
            val rows = tables.chunked(4)
            rows.forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { t ->
                        TableCellCard(t, Modifier.weight(1f))
                    }
                    // 末排补齐，保持对齐
                    repeat(4 - row.size) { Box(Modifier.weight(1f)) }
                }
            }

            // 待清台：按等待时长排序 + 超时高亮
            if (clean.isNotEmpty()) {
                val cleanSince = remember { mutableStateMapOf<String, Long>() }
                val now = System.currentTimeMillis()
                cleanSince.keys.retainAll(clean.map { it.id }.toSet())
                clean.forEach { if (!cleanSince.containsKey(it.id)) cleanSince[it.id] = now }

                val sorted = clean.sortedByDescending { ((now - (cleanSince[it.id] ?: now)) / 60_000L).toInt() }
                Text("待清台（按等待时长）", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = Txt)
                sorted.forEach { t ->
                    val wait = ((now - (cleanSince[t.id] ?: now)) / 60_000L).toInt()
                    val timeout = wait >= CLEAN_TIMEOUT_MIN
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .background(if (timeout) Color(0xFFFCEAEA) else CardBg)
                            .padding(10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            (t.name ?: t.no ?: t.id),
                            fontWeight = FontWeight.Bold,
                            fontSize = 13.sp,
                            color = Txt
                        )
                        Text(
                            if (wait <= 0) "刚清台" else "等待 ${wait} 分钟",
                            fontSize = 12.sp,
                            color = if (timeout) Color(0xFFE8584A) else Sub,
                            fontWeight = if (timeout) FontWeight.Bold else FontWeight.Normal
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun Kpi(label: String, value: Int, color: Color) {
    Column(Modifier.weight(1f)) {
        Text("$value", fontSize = 22.sp, fontWeight = FontWeight.ExtraBold, color = color)
        Text(label, fontSize = 11.sp, color = Sub)
    }
}

@Composable
private fun TableCellCard(table: PosTableDto, modifier: Modifier = Modifier) {
    val (color, label) = when (table.state) {
        "busy", "就餐" -> ST_BUSY to "就餐"
        "clean" -> ST_CLEAN to "待清"
        "rsv", "预订" -> ST_RSV to "预订"
        else -> ST_FREE to "空闲"
    }
    Column(
        modifier
            .clip(RoundedCornerShape(10.dp))
            .background(color.copy(alpha = 0.12f))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp)
    ) {
        Text(
            (table.name ?: table.no ?: table.id),
            fontWeight = FontWeight.Bold,
            fontSize = 13.sp,
            color = Txt
        )
        Text(label, fontSize = 11.sp, color = color)
        table.amount?.let {
            Text("¥%.0f".format(it), fontSize = 11.sp, color = Sub)
        }
    }
}
