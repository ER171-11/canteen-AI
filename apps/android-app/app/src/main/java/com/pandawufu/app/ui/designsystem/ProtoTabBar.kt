package com.pandawufu.app.ui.designsystem

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DinnerDining
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Storefront
import androidx.compose.material.icons.filled.Today
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.R
import kotlin.random.Random

data class ProtoTab(
    val route: String,
    val label: String,
    val icon: ImageVector,
    val isAiFab: Boolean = false
)

/** 底栏方案 C：今日 · 前厅 · AI · 后厨 · 我的（货品收入「我的·进销」） */
val DefaultProtoTabs = listOf(
    ProtoTab("home", "今日", Icons.Filled.Today),
    ProtoTab("front", "前厅", Icons.Filled.Storefront),
    // icon 仅占位；AI FAB 用熊猫头像
    ProtoTab("chat", "AI", Icons.Filled.Today, isAiFab = true),
    ProtoTab("kitchen", "后厨", Icons.Filled.DinnerDining),
    ProtoTab("more", "我的", Icons.Filled.Person)
)

/**
 * 原型悬浮毛玻璃 TabBar：左右 12 / 底 12 / 高 72 / 圆角 26，
 * AI 为粉紫圆角方块 + 圆形熊猫 logo（对齐 HTML .tab.ai-fab img）。
 */
@Composable
fun ProtoTabBar(
    tabs: List<ProtoTab>,
    currentRoute: String?,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    val pandaRes = remember {
        if (Random.nextBoolean()) R.drawable.panda_male_sq else R.drawable.panda_female_sq
    }

    Box(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .padding(horizontal = 12.dp, vertical = 12.dp)
                .fillMaxWidth()
                .height(72.dp)
                .shadow(10.dp, RoundedCornerShape(26.dp), ambientColor = ShadowColor, spotColor = ShadowColor)
                .clip(RoundedCornerShape(26.dp))
                .background(Color.White.copy(alpha = 0.92f))
                .border(1.dp, Color.White.copy(alpha = 0.6f), RoundedCornerShape(26.dp))
                .padding(horizontal = 8.dp),
            horizontalArrangement = Arrangement.SpaceAround,
            verticalAlignment = Alignment.CenterVertically
        ) {
            tabs.forEach { tab ->
                val selected = currentRoute == tab.route
                if (tab.isAiFab) {
                    // 占位，真实 FAB 叠在上层避免被 clip 裁掉
                    Box(Modifier.size(56.dp))
                } else {
                    val tint by animateColorAsState(
                        targetValue = if (selected) Ink else Sub,
                        animationSpec = tween(200),
                        label = "tab-tint"
                    )
                    Column(
                        Modifier
                            .clip(RoundedCornerShape(14.dp))
                            .background(
                                if (selected) Brush.verticalGradient(listOf(Color(0xFFFFF0F4), Color.White))
                                else Brush.verticalGradient(listOf(Color.Transparent, Color.Transparent))
                            )
                            .clickable(
                                interactionSource = remember { MutableInteractionSource() },
                                indication = ripple(bounded = true, color = AiPink.copy(alpha = 0.28f))
                            ) { onSelect(tab.route) }
                            .padding(horizontal = 10.dp, vertical = 6.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(3.dp)
                    ) {
                        Icon(
                            tab.icon,
                            contentDescription = tab.label,
                            tint = tint,
                            modifier = Modifier.size(22.dp)
                        )
                        Text(
                            tab.label,
                            fontSize = 9.5.sp,
                            fontWeight = if (selected) FontWeight.ExtraBold else FontWeight.SemiBold,
                            color = tint
                        )
                    }
                }
            }
        }

        // 中间粉紫 FAB + 完整熊猫（略上浮，对齐原型）
        Box(
            Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 20.dp)
                .offset(y = (-6).dp)
                .size(56.dp)
                .shadow(8.dp, RoundedCornerShape(20.dp), ambientColor = Color(155, 107, 191, 100), spotColor = Color(155, 107, 191, 100))
                .clip(RoundedCornerShape(20.dp))
                .background(Brush.linearGradient(listOf(AiPink, AiPurple)))
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = ripple(bounded = true, color = Color.White.copy(alpha = 0.35f))
                ) { onSelect("chat") },
            contentAlignment = Alignment.Center
        ) {
            Image(
                painter = painterResource(pandaRes),
                contentDescription = "问店 AI",
                modifier = Modifier
                    .size(46.dp)
                    .background(Color.White, CircleShape)
                    .border(2.dp, Color.White.copy(alpha = 0.92f), CircleShape)
                    .padding(6.dp),
                contentScale = ContentScale.Fit,
                alignment = Alignment.Center
            )
        }
    }
}
