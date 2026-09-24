package com.pandawufu.app.ui.designsystem

import androidx.compose.ui.graphics.Color

// 视觉 token 全量（取自原型 熊猫五福App原型.html CSS 变量）
val Ink = Color(0xFF1A1A1A)          // --ink 主色
val PageBg = Color(0xFFEEF1F5)       // --bg 页面底
val CardBg = Color(0xFFFFFFFF)       // 卡片
val Txt = Color(0xFF2B2B2B)          // --txt 正文
val Sub = Color(0xFF8A8F98)          // --sub 次要文字
val Line = Color(0xFFECEEF2)         // --line 分隔线

// AI 渐变（FAB / AI 相关元素）
val AiPink = Color(0xFFF48FB1)
val AiPurple = Color(0xFF9B6BBF)

// 五福五色（寓意见 kmp-shared FiveColor：红=长寿 黑=聚财 黄=富贵 绿=康宁 紫=好德）
val FiveRed = Color(0xFFE8584A)
val FiveBlack = Color(0xFF3A3A3A)
val FiveYellow = Color(0xFFF2B233)
val FiveGreen = Color(0xFF5BA85B)
val FivePurple = Color(0xFF9B6BBF)

// 圆角 token（dp）：14 / 20 / 26
// 阴影 token：0 8px 28px rgba(40,50,70,.10)
val ShadowColor = Color(40, 50, 70, 26)

// POS 桌台四态（取自原型 .tbl.free/.busy/.clean/.rsv，bg / 文字 / 边框）
val TableFreeBg = Color(0xFFE2F0E2); val TableFreeTxt = Color(0xFF2E7D32); val TableFreeBorder = Color(0xFFB6DDB6)
val TableBusyBg = Color(0xFFFCE4E1); val TableBusyTxt = Color(0xFFC62828); val TableBusyBorder = Color(0xFFF5B0AA)
val TableCleanBg = Color(0xFFFCEDD0); val TableCleanTxt = Color(0xFF9C2C2C); val TableCleanBorder = Color(0xFFF0CF7A)
val TableRsvBg = Color(0xFFE3EDF7); val TableRsvTxt = Color(0xFF1565C0); val TableRsvBorder = Color(0xFFA8C8E8)
