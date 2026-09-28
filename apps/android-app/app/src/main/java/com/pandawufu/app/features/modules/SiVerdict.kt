package com.pandawufu.app.features.modules

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.AppModule
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.PandaCard
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.model.SpecialistDto
import com.pandawufu.shared.model.TeamReviewDto

/**
 * 统一 SI 专家结论卡：把 SI 专家团对应域的巡检结论嵌进每个模块顶部，
 * 让老板在任何子板块都能看到「SI 怎么看 + 一条可执行建议」。
 * 数据源 /api/si/team（60s 缓存，避免每屏重复请求）。
 */
object SiVerdictCache {
    @Volatile
    var data: TeamReviewDto? = null

    @Volatile
    var at: Long = 0L
}

@Composable
fun SiVerdictCard(specialist: String, onOpen: ((String) -> Unit)? = null) {
    var review by remember { mutableStateOf(SiVerdictCache.data) }
    LaunchedEffect(specialist) {
        val stale = System.currentTimeMillis() - SiVerdictCache.at > 60_000
        if (SiVerdictCache.data == null || stale) {
            runCatching {
                AppModule.ensureSession()
                AppModule.siRepository.team()
            }.onSuccess {
                SiVerdictCache.data = it
                SiVerdictCache.at = System.currentTimeMillis()
                review = it
            }
        } else {
            review = SiVerdictCache.data
        }
    }
    val review0 = review ?: return
    if (specialist == "all") {
        PandaCard {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("SI · 总协调", fontWeight = FontWeight.Bold, color = Ink)
                Text(
                    "${review0.counts.off} 告警 · ${review0.counts.risk} 提醒",
                    color = if (review0.counts.off > 0) FiveRed else FiveGreen,
                    fontWeight = FontWeight.Bold
                )
            }
            Text(review0.summary, color = Sub, fontSize = 12.sp)
        }
        return
    }
    val s: SpecialistDto = review0.specialists.firstOrNull { it.id == specialist } ?: return
    val color = when (s.status) {
        "off_track" -> FiveRed
        "at_risk" -> Color(0xFFE4871A)
        else -> FiveGreen
    }
    PandaCard {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text("SI · ${s.name}", fontWeight = FontWeight.Bold, color = Ink)
            Text(
                when (s.status) {
                    "off_track" -> "告警"
                    "at_risk" -> "提醒"
                    else -> "正常"
                },
                color = color,
                fontWeight = FontWeight.Bold
            )
        }
        s.findings.take(2).forEach {
            Text("· $it", color = Sub, fontSize = 12.sp)
        }
        s.recommends.firstOrNull()?.let { rec ->
            Row(
                Modifier.fillMaxWidth().padding(top = 4.dp),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(rec.text, color = color, fontWeight = FontWeight.SemiBold)
                rec.route?.takeIf { it.isNotBlank() }?.let { r ->
                    if (onOpen != null) {
                        OutlinedButton(onClick = { onOpen(r) }, shape = RoundedCornerShape(8.dp)) { Text("去办") }
                    }
                }
            }
        }
        review?.rev?.let {
            Text("rev ${it.toString().trim('\"')} · SI 只读巡检", color = Sub, fontSize = 10.sp)
        }
    }
}
