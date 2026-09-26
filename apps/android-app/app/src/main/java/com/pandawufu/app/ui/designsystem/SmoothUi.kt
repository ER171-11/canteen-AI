package com.pandawufu.app.ui.designsystem

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.animation.animateColorAsState

private val Smooth = tween<Float>(220, easing = FastOutSlowInEasing)
private val SmoothColor = tween<Color>(220, easing = FastOutSlowInEasing)

/**
 * 子模块丝滑基建：分段切换动画、内容交叉淡入、轻量刷新条。
 * 切 Tab 不要整页空白转圈；有数据时只在顶部轻扫进度。
 */
@Composable
fun SoftRefreshBar(active: Boolean, modifier: Modifier = Modifier) {
    AnimatedVisibility(
        visible = active,
        enter = fadeIn(Smooth),
        exit = fadeOut(Smooth),
        modifier = modifier.fillMaxWidth()
    ) {
        LinearProgressIndicator(
            modifier = Modifier
                .fillMaxWidth()
                .height(2.dp)
                .clip(RoundedCornerShape(1.dp)),
            color = AiPink,
            trackColor = Line.copy(alpha = 0.35f)
        )
    }
}

/** 子模块内容区：按 key 交叉淡入，避免生硬闪切 */
@Composable
fun SmoothPane(
    key: Any?,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit
) {
    AnimatedContent(
        targetState = key,
        modifier = modifier,
        transitionSpec = {
            (fadeIn(Smooth) + slideInHorizontally(animationSpec = tween(220)) { it / 24 }) togetherWith
                (fadeOut(Smooth) + slideOutHorizontally(animationSpec = tween(180)) { -it / 28 })
        },
        label = "smooth-pane"
    ) {
        // key 参与动画；内容由调用方闭包持有最新态
        @Suppress("UNUSED_EXPRESSION")
        it
        content()
    }
}

/** 丝滑分段 pill：选中色过渡 + 触感 ripple */
@Composable
fun SmoothPillRow(
    tabs: List<String>,
    selected: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier
) {
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(CardBg)
            .padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        tabs.forEachIndexed { idx, label ->
            val on = idx == selected
            val bg by animateColorAsState(
                targetValue = if (on) Ink else Color.Transparent,
                animationSpec = SmoothColor,
                label = "pill-bg"
            )
            val fg by animateColorAsState(
                targetValue = if (on) CardBg else Sub,
                animationSpec = SmoothColor,
                label = "pill-fg"
            )
            Box(
                Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(10.dp))
                    .background(bg)
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = ripple(bounded = true, color = AiPink.copy(alpha = 0.35f))
                    ) { onSelect(idx) }
                    .padding(vertical = 8.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    label,
                    style = MaterialTheme.typography.bodySmall,
                    color = fg,
                    fontWeight = if (on) FontWeight.Bold else FontWeight.Medium,
                    fontSize = 12.sp,
                    maxLines = 1
                )
            }
        }
    }
}

/** 模块页主体：状态条 + 内容交叉淡入 */
@Composable
fun SmoothModuleBody(
    paneKey: Any?,
    refreshing: Boolean = false,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit
) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        SoftRefreshBar(active = refreshing)
        SmoothPane(key = paneKey) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
        }
    }
}
