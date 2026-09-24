package com.pandawufu.app.features.kitchen

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.pandawufu.app.AppModule
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.Line
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.viewmodel.KitchenViewModel

// 对应原型 p-kitchen（pill 子页：菜谱 kt-rec / 工单 kt-sop / 出品看板 kt-board / 品控 kt-qc）
@Composable
fun KitchenScreen() {
    val viewModel = remember { KitchenViewModel(AppModule.kitchenRepository) }
    val state by viewModel.state.collectAsState()

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("厨房中枢", style = MaterialTheme.typography.titleLarge)
        PillTabRow(
            tabs = KitchenViewModel.KitchenTab.entries.map { it.label },
            selected = state.tab.ordinal,
            onSelect = { idx ->
                viewModel.dispatch(
                    KitchenViewModel.KitchenIntent.SelectTab(KitchenViewModel.KitchenTab.entries[idx])
                )
            }
        )
        if (state.error != null) {
            Text("加载失败：${state.error}", style = MaterialTheme.typography.bodySmall, color = Color(0xFFE8584A))
        }
        when (state.tab) {
            KitchenViewModel.KitchenTab.RECIPES -> RecipesTab(state, viewModel)
            KitchenViewModel.KitchenTab.WORKORDERS -> WorkordersTab(state)
            KitchenViewModel.KitchenTab.BOARD -> BoardTab(state)
            KitchenViewModel.KitchenTab.QC -> QcTab(state)
        }
    }

    androidx.compose.runtime.LaunchedEffect(Unit) {
        viewModel.dispatch(KitchenViewModel.KitchenIntent.Refresh)
    }
}

/** 原型 .pill-grp 风格分段切换 */
@Composable
internal fun PillTabRow(tabs: List<String>, selected: Int, onSelect: (Int) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(CardBg)
            .padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        tabs.forEachIndexed { idx, label ->
            val on = idx == selected
            Box(
                Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(10.dp))
                    .background(if (on) Ink else Color.Transparent)
                    .clickable { onSelect(idx) }
                    .padding(vertical = 8.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    label,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (on) CardBg else Sub
                )
            }
        }
    }
}

/** 状态 Tag（原型 .tag ok/warn/danger） */
@Composable
internal fun StatusTag(text: String, color: Color) {
    Box(
        Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(color.copy(alpha = 0.14f))
            .padding(horizontal = 8.dp, vertical = 3.dp)
    ) {
        Text(text, style = MaterialTheme.typography.labelSmall, color = color)
    }
}

internal val FiveRedC = Color(0xFFE8584A)
internal val FiveGreenC = Color(0xFF5BA85B)
internal val FiveYellowC = Color(0xFFF2B233)
internal val SubC = Sub
internal val LineC = Line

/** 五色别 → 色值（白/其他用次要色兜底） */
internal fun colorOfFive(color: String?): Color = when (color) {
    "红" -> Color(0xFFE8584A)
    "黑" -> Color(0xFF3A3A3A)
    "黄" -> Color(0xFFF2B233)
    "绿" -> Color(0xFF5BA85B)
    "紫" -> Color(0xFF9B6BBF)
    "白" -> Color(0xFFB9C0C9)
    else -> Sub
}
