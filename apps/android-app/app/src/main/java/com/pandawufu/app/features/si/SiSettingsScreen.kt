package com.pandawufu.app.features.si

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.AppModule
import com.pandawufu.app.features.modules.ModuleCard
import com.pandawufu.app.features.modules.ModuleScaffold
import com.pandawufu.app.ui.BossIa
import com.pandawufu.app.ui.Routes
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.viewmodel.SiViewModel

/**
 * SI 设置与能力（低频）：把「授权/目标/战役/专家团/知识/模拟」收进一处，
 * 让指挥台只保留老板高频的 3 件事：要拍板 / 在办 / 问一句。
 */
@Composable
fun SiSettingsScreen(onOpen: (String) -> Unit = {}) {
    LaunchedEffect(Unit) { AppModule.ensureSession() }

    val canCockpit = AppModule.role == "老板" || AppModule.role == "店长" || AppModule.can("analysis")
    val canActions = AppModule.canWrite() || AppModule.can("actions")

    val groups = buildList {
        if (canActions) add(
            "拍板与授权" to listOf(
                Triple("收件箱", "需拍板 / 执行中 / 预警 / 通知", Routes.M_INBOX),
                Triple("授权与审计", "自动执行政策 · 决策审计", Routes.M_SI_POLICY)
            )
        )
        if (canCockpit) add(
            "SI 在办" to listOf(
                Triple("战役", "超长期目标 · SI 持续执行", Routes.M_SI_MISSIONS),
                Triple("目标", "老板定标 · SI 盯进度", Routes.M_SI_GOALS)
            )
        )
        if (canCockpit) add(
            "SI 认知与工具" to listOf(
                Triple("专家团与知识", "六域值守 · 经营打法沉淀", Routes.M_SI_TEAM),
                Triple("What-if 模拟", "先算后做 · 不落库", Routes.M_SI_SIM)
            )
        )
    }

    ModuleScaffold(
        title = "SI 设置与能力",
        subtitle = "低频配置收口 · 高频在指挥台与今日主线",
        loading = false,
        error = null,
        siSpecialist = ""
    ) {
        groups.forEach { (title, items) ->
            ModuleCard(title) {
                items.forEach { (label, desc, route) ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(Color.White)
                            .border(1.dp, Color(0xFFECEEF2), RoundedCornerShape(12.dp))
                            .clickable { onOpen(route) }
                            .padding(12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(label, fontWeight = FontWeight.Bold, color = Ink, fontSize = 13.sp)
                            Text(desc, color = Sub, fontSize = 11.sp)
                        }
                        Text("›", color = Sub, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
        Text(
            "说明：老板高频只有三件事——看今日主线、批该批的、问 SI；此处为低频设置与能力。",
            color = Sub, fontSize = 11.sp
        )
    }
}
