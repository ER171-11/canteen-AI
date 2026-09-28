package com.pandawufu.app.ui.designsystem

import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

// 视觉 token 全量（对齐现代 iOS/原生 App 观感）
val Ink = Color(0xFF17181C)          // 主色（近黑）
val PageBg = Color(0xFFF3F5F9)       // 页面底（柔和中性）
val CardBg = Color(0xFFFFFFFF)       // 卡片
val CardTop = Color(0xFFFFFFFF)      // 卡片渐变上
val CardBottom = Color(0xFFFBFCFE)   // 卡片渐变下
val CardHairline = Color(0xFFECEFF5) // 卡片发丝边
val Txt = Color(0xFF23252B)          // 正文
val Sub = Color(0xFF8A909C)          // 次要文字
val Line = Color(0xFFE9ECF2)         // 分隔线

/** 页面背景渐变（顶部更亮，营造层次） */
val AppBgBrush = Brush.verticalGradient(listOf(Color(0xFFF7F9FD), PageBg))

// 品牌主色（粉紫渐变）
val Brand = Color(0xFF7C5CFF)
val BrandSoft = Color(0xFFEDE7FF)

// AI 渐变（FAB / AI 相关元素）
val AiPink = Color(0xFFF48FB1)
val AiPurple = Color(0xFF9B6BBF)

// 五福五色（寓意见 kmp-shared FiveColor：红=长寿 黑=聚财 黄=富贵 绿=康宁 紫=好德）
val FiveRed = Color(0xFFE8584A)
val FiveBlack = Color(0xFF3A3A3A)
val FiveYellow = Color(0xFFF2B233)
val FiveGreen = Color(0xFF3FA25A)
val FivePurple = Color(0xFF9B6BBF)

// 圆角 token（dp）：14 / 20 / 26
// 阴影 token：0 8px 28px rgba(40,50,70,.10)
val ShadowColor = Color(40, 50, 70, 26)

// POS 桌台四态（取自原型 .tbl.free/.busy/.clean/.rsv，bg / 文字 / 边框）
val TableFreeBg = Color(0xFFE2F0E2); val TableFreeTxt = Color(0xFF2E7D32); val TableFreeBorder = Color(0xFFB6DDB6)
val TableBusyBg = Color(0xFFFCE4E1); val TableBusyTxt = Color(0xFFC62828); val TableBusyBorder = Color(0xFFF5B0AA)
val TableCleanBg = Color(0xFFFCEDD0); val TableCleanTxt = Color(0xFF9C2C2C); val TableCleanBorder = Color(0xFFF0CF7A)
val TableRsvBg = Color(0xFFE3EDF7); val TableRsvTxt = Color(0xFF1565C0); val TableRsvBorder = Color(0xFFA8C8E8)
