package com.pandawufu.app.ui.designsystem

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

private val PandaColorScheme = lightColorScheme(
    primary = Ink,
    onPrimary = CardBg,
    background = PageBg,
    onBackground = Txt,
    surface = CardBg,
    onSurface = Txt,
    surfaceVariant = PageBg,
    onSurfaceVariant = Sub,
    outline = Line,
    secondary = FivePurple,
    tertiary = AiPink
)

@Composable
fun PandaWufuTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    // 原型仅浅色风格；深色主题待产品定义后再扩展
    MaterialTheme(
        colorScheme = PandaColorScheme,
        typography = PandaTypography,
        content = content
    )
}
