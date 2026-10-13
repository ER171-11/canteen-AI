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
import com.pandawufu.app.ui.BossIa
import com.pandawufu.app.ui.designsystem.BrandBar
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.Line
import com.pandawufu.app.ui.designsystem.LoadStatusBanner
import com.pandawufu.app.ui.designsystem.PageBg
import com.pandawufu.app.ui.designsystem.AppBgBrush
import com.pandawufu.app.ui.designsystem.SmoothPane
import com.pandawufu.app.ui.designsystem.SoftRefreshBar
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.viewmodel.KitchenViewModel

/** 后厨日路径：按菜谱标准做工单 → 出品 → 品控；菜谱页即出品标准 */
@Composable
fun KitchenScreen(onOpenModule: (String) -> Unit = {}) {
    val viewModel = remember {
        KitchenViewModel(
            kitchenRepository = AppModule.kitchenRepository,
            inventoryRepository = AppModule.inventoryRepository
        )
    }
    val state by viewModel.state.collectAsState()

    fun go(tab: KitchenViewModel.KitchenTab) {
        // 同 Tab 再点 = 轻刷新；切 Tab 只切换（SelectTab 内懒加载），避免整页空白转圈
        if (tab == state.tab) {
            viewModel.dispatch(KitchenViewModel.KitchenIntent.Refresh)
        } else {
            viewModel.dispatch(KitchenViewModel.KitchenIntent.SelectTab(tab))
        }
    }

    LaunchedEffect(Unit) {
        AppModule.ensureSession()
        viewModel.dispatch(KitchenViewModel.KitchenIntent.Refresh)
    }

    val hasBody = state.recipes.isNotEmpty() ||
        state.workorders.isNotEmpty() ||
        state.board.isNotEmpty() ||
        state.qc.isNotEmpty()

    Column(
        Modifier
            .fillMaxSize()
            .background(AppBgBrush)
            .padding(horizontal = 14.dp, vertical = 12.dp)
            .padding(bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        BrandBar(
            title = BossIa.Tab.KITCHEN,
            subtitle = when (state.tab) {
                KitchenViewModel.KitchenTab.WORKORDERS -> BossIa.Kitchen.WO_SUB
                KitchenViewModel.KitchenTab.BOARD -> BossIa.Kitchen.BOARD_SUB
                KitchenViewModel.KitchenTab.QC -> BossIa.Kitchen.QC_SUB
                KitchenViewModel.KitchenTab.RECIPES -> BossIa.Kitchen.RECIPE_SUB
            }
        )

        PillTabRow(
            tabs = KitchenViewModel.KitchenTab.entries.map { it.label },
            selected = state.tab.ordinal,
            onSelect = { idx ->
                go(KitchenViewModel.KitchenTab.entries[idx])
            }
        )

        val onPipe = state.tab != KitchenViewModel.KitchenTab.RECIPES
        if (onPipe) {
            KitchenPipelineStrip(active = state.tab, onStep = { go(it) })
        }

        SoftRefreshBar(active = state.loading && hasBody)

        Row(
            Modifier
                .fillMaxWidth()
                .clip(androidx.compose.foundation.shape.RoundedCornerShape(12.dp))
                .background(com.pandawufu.app.ui.designsystem.Ink)
                .clickable { onOpenModule(com.pandawufu.app.ui.Routes.M_WB_KITCHEN) }
                .padding(horizontal = 12.dp, vertical = 9.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("厨师工作台", fontSize = 12.5.sp, fontWeight = FontWeight.ExtraBold, color = Color.White)
            Text("按菜谱标准制作与品控 ›", fontSize = 10.5.sp, color = Color.White.copy(alpha = 0.8f))
        }

        /*
         * 食安拍照核验：厨房端直达入口。
         * 此前该页只在「我的 → 人与合规」二级目录里，现场（厨师/帮厨）根本找不到拍照上报入口。
         * 可见性按 foodsafe 权限；无写权限（如只读岗）仍可进页面看进度，只是拍不了。
         */
        if (AppModule.can("foodsafe")) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(Color.White)
                    .clickable { onOpenModule(com.pandawufu.app.ui.Routes.M_SAFETY_CHECK) }
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    "食安拍照核验",
                    fontSize = 12.5.sp,
                    fontWeight = FontWeight.ExtraBold,
                    color = FiveGreen
                )
                Text(
                    if (AppModule.can("foodsafe", write = true)) "点位拍照上报 ›" else "仅可查看进度 ›",
                    fontSize = 10.5.sp,
                    color = Sub
                )
            }
        }

        com.pandawufu.app.features.modules.SiVerdictCard("kitchen")

        if (state.error != null || state.emptyHint != null) {
            LoadStatusBanner(
                error = state.error,
                hint = state.emptyHint,
                onRetry = { viewModel.dispatch(KitchenViewModel.KitchenIntent.Refresh) }
            )
        }

        Box(Modifier.weight(1f).fillMaxWidth()) {
            SmoothPane(key = state.tab) {
                when (state.tab) {
                    KitchenViewModel.KitchenTab.WORKORDERS -> WorkordersTab(
                        state = state,
                        viewModel = viewModel,
                        onGoRecipes = { go(KitchenViewModel.KitchenTab.RECIPES) },
                        onGoBoard = { go(KitchenViewModel.KitchenTab.BOARD) }
                    )
                    KitchenViewModel.KitchenTab.BOARD -> BoardTab(
                        state = state,
                        viewModel = viewModel,
                        onGoWorkorders = { go(KitchenViewModel.KitchenTab.WORKORDERS) }
                    )
                    KitchenViewModel.KitchenTab.QC -> QcTab(state)
                    KitchenViewModel.KitchenTab.RECIPES -> RecipesTab(
                        state = state,
                        viewModel = viewModel,
                        onOpenPurchase = { onOpenModule(com.pandawufu.app.ui.Routes.INVENTORY_PURCHASE) },
                        onGoWorkorders = { go(KitchenViewModel.KitchenTab.WORKORDERS) }
                    )
                }
            }
        }
    }
}

@Composable
private fun KitchenPipelineStrip(
    active: KitchenViewModel.KitchenTab,
    onStep: (KitchenViewModel.KitchenTab) -> Unit
) {
    val steps = listOf(
        KitchenViewModel.KitchenTab.WORKORDERS to "工单",
        KitchenViewModel.KitchenTab.BOARD to "出品",
        KitchenViewModel.KitchenTab.QC to "品控"
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
                color = if (on) FiveGreen else Sub,
                modifier = Modifier.clickable { onStep(tab) }
            )
            if (i < steps.lastIndex) {
                Text("→", fontSize = 12.sp, color = if (on) Ink else Sub)
            }
        }
    }
}

/** 原型 .pill-grp 风格分段切换（丝滑色过渡，各子模块共用） */
@Composable
internal fun PillTabRow(tabs: List<String>, selected: Int, onSelect: (Int) -> Unit) {
    com.pandawufu.app.ui.designsystem.SmoothPillRow(
        tabs = tabs,
        selected = selected,
        onSelect = onSelect
    )
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
