package com.pandawufu.app.ui.designsystem

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// 字号层级对齐原型（标题 17-20 粗体 / 正文 13-14 / 次要 11-12）
val PandaTypography = Typography(
    titleLarge = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.Bold, color = Txt),
    titleMedium = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold, color = Txt),
    bodyMedium = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Normal, color = Txt),
    bodySmall = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Normal, color = Sub),
    labelSmall = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Medium, color = Sub)
)
