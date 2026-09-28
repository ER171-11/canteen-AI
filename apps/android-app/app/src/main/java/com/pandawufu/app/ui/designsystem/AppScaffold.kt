package com.pandawufu.app.ui.designsystem

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.pandawufu.app.ui.BossIa

/**
 * 统一页面骨架：渐变底 + 标准内距 + 品牌栏 + 分区间距。
 * 各页面用它包裹内容，保证密度/圆角/间距一致（替代各页自绘 Column）。
 */
@Composable
fun AppScaffold(
    subtitle: String = BossIa.Brand.TAGLINE,
    title: String = BossIa.Brand.NAME,
    onBack: (() -> Unit)? = null,
    trailing: @Composable (() -> Unit)? = null,
    header: Boolean = true,
    scroll: Boolean = false,
    content: @Composable ColumnScope.() -> Unit
) {
    val base = Modifier
        .fillMaxSize()
        .background(AppBgBrush)
        .then(if (scroll) Modifier.verticalScroll(rememberScrollState()) else Modifier)
        .padding(horizontal = PagePadH, vertical = PagePadTop)
        .padding(bottom = PageBottomInset)
    Column(base, verticalArrangement = Arrangement.spacedBy(SectionGap)) {
        if (header) BrandBar(title = title, subtitle = subtitle, onBack = onBack, trailing = trailing)
        content()
    }
}
