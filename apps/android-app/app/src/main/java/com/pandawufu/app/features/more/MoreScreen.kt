package com.pandawufu.app.features.more

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.AppModule
import com.pandawufu.app.ui.BossIa
import com.pandawufu.app.ui.designsystem.BrandBar
import com.pandawufu.app.ui.designsystem.CardHeader
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.Line
import com.pandawufu.app.ui.designsystem.ModuleCell
import com.pandawufu.app.ui.designsystem.PageBg
import com.pandawufu.app.ui.designsystem.AppBgBrush
import com.pandawufu.app.ui.designsystem.PandaCard
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.app.ui.designsystem.Txt

/**
 * 「我的」应用中心 —— 目录来自 [BossIa.modules] + [BossIa.goodsEntries]。
 * 方案 C：前厅主入口在底栏；本页首组「进销」承接原货品底栏。
 */
internal data class ModuleEntry(
    val label: String,
    val sub: String,
    val route: String,
    val iconBg: Color,
    val keywords: String = "",
    val group: String = "进销"
)

internal val allModules: List<ModuleEntry> =
    BossIa.goodsEntries.map { g ->
        ModuleEntry(
            label = g.label,
            sub = g.gridSub,
            route = g.route,
            iconBg = Color(g.iconBgArgb),
            keywords = g.keywords,
            group = "进销"
        )
    } + BossIa.modules.map { m ->
        ModuleEntry(
            label = m.label,
            sub = m.gridSub,
            route = m.route,
            iconBg = Color(m.iconBgArgb),
            keywords = m.keywords,
            group = m.group
        )
    }

/** 分组阅读顺序 */
private val groupOrder = BossIa.Mine.groupOrder

private val groupHint = BossIa.Mine.groupHint

/** 顶栏「今日常用」六格（不等于全部分组） */
internal val bossPrimaryRoutes = BossIa.Mine.primaryRoutes

@Composable
private fun ModuleGrid(
    mods: List<ModuleEntry>,
    favRoutes: Set<String>,
    onOpen: (String) -> Unit,
    onToggleFav: (String) -> Unit
) {
    mods.chunked(3).forEach { row ->
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            row.forEach { m ->
                val mark = if (favRoutes.contains(m.route)) "★ ${m.sub}" else m.sub
                ModuleCell(
                    label = m.label,
                    subtitle = mark,
                    iconBg = m.iconBg,
                    modifier = Modifier.weight(1f),
                    onLongClick = { onToggleFav(m.route) }
                ) { onOpen(m.route) }
            }
            repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
        }
    }
}

@Composable
fun MoreScreen(onOpenModule: (String) -> Unit) {
    val context = LocalContext.current
    val prefs = AppModule.modulePrefs
    var query by remember { mutableStateOf("") }
    var favTick by remember { mutableStateOf(0) }
    var recentTick by remember { mutableStateOf(0) }

    val visible = remember(favTick, recentTick) {
        allModules.filter { AppModule.canOpenRoute(it.route) }
    }
    val filtered = remember(query, visible) {
        val q = query.trim()
        if (q.isEmpty()) visible
        else visible.filter {
            it.label.contains(q, true) ||
                it.sub.contains(q, true) ||
                it.keywords.contains(q, true) ||
                it.group.contains(q, true)
        }
    }
    val primary = remember(filtered) {
        bossPrimaryRoutes.mapNotNull { r -> filtered.find { it.route == r } }
    }
    val favRoutes = remember(favTick) { prefs.favorites().toSet() }
    val recentRoutes = remember(recentTick) { prefs.recent() }
    val byRoute = visible.associateBy { it.route }

    val storeLine = listOfNotNull(
        AppModule.storeName
            ?.removePrefix("熊猫五福餐厅")
            ?.trim()
            ?.ifBlank { AppModule.storeName }
            ?: AppModule.storeName,
        AppModule.role,
        AppModule.displayName?.takeIf { it.isNotBlank() }
    ).distinct().joinToString(" · ").ifBlank { "本店模块与设置" }

    fun open(route: String) {
        prefs.touch(route)
        recentTick++
        onOpenModule(route)
    }

    fun toggleFav(route: String) {
        val on = prefs.toggleFavorite(route)
        favTick++
        Toast.makeText(context, if (on) "已加入常用" else "已取消常用", Toast.LENGTH_SHORT).show()
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(AppBgBrush)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 14.dp, vertical = 12.dp)
            .padding(bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        BrandBar(
            title = "我的",
            subtitle = listOfNotNull(storeLine, BossIa.Tab.MINE_JOB).joinToString(" · ")
        )

        Text(
            BossIa.Tab.MINE_BOUNDARY,
            fontSize = 11.sp,
            color = Sub,
            modifier = Modifier.padding(horizontal = 2.dp)
        )

        Box(
            Modifier
                .fillMaxWidth()
                .background(Color.White, RoundedCornerShape(14.dp))
                .border(1.dp, Line, RoundedCornerShape(14.dp))
                .padding(horizontal = 14.dp, vertical = 12.dp)
        ) {
            if (query.isEmpty()) {
                Text("搜索模块（收银、食安、对账、岗位…）", color = Sub, fontSize = 13.sp)
            }
            BasicTextField(
                value = query,
                onValueChange = { query = it },
                singleLine = true,
                textStyle = TextStyle(color = Txt, fontSize = 13.sp),
                cursorBrush = SolidColor(Ink),
                modifier = Modifier.fillMaxWidth()
            )
        }

        // 常用快捷：有收藏才占位；为空时隐藏，把空间让给下方完整模块目录，
        // 避免老板打开「我的」只见空卡片、误以为功能缺失。
        val favMods = favRoutes.mapNotNull { byRoute[it] }
        if (favMods.isNotEmpty()) {
            PandaCard {
                CardHeader("常用快捷", more = "${favRoutes.size}")
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    favMods.take(4).forEach { m ->
                        Box(
                            Modifier
                                .weight(1f)
                                .background(Color(0xFFF7F8FB), RoundedCornerShape(12.dp))
                                .border(1.dp, Line, RoundedCornerShape(12.dp))
                                .clickable { open(m.route) }
                                .padding(vertical = 10.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(m.label, fontSize = 11.sp, fontWeight = FontWeight.Bold, color = Txt)
                        }
                    }
                    repeat((4 - favMods.size.coerceAtMost(4)).coerceAtLeast(0)) {
                        Spacer(Modifier.weight(1f))
                    }
                }
            }
        }

        if (recentRoutes.isNotEmpty() && query.isEmpty()) {
            PandaCard {
                CardHeader(
                    title = "最近访问",
                    more = "清空",
                    onMore = {
                        prefs.clearRecent()
                        recentTick++
                        Toast.makeText(context, "已清空最近访问", Toast.LENGTH_SHORT).show()
                    }
                )
                ModuleGrid(
                    recentRoutes.mapNotNull { byRoute[it] }.take(6),
                    favRoutes,
                    { open(it) },
                    { toggleFav(it) }
                )
            }
        }

        when {
            query.isNotBlank() -> {
                PandaCard {
                    CardHeader("搜索结果", more = "${filtered.size} 个")
                    if (filtered.isEmpty()) {
                        Text("无匹配「$query」", fontSize = 12.sp, color = Sub)
                    } else {
                        ModuleGrid(filtered, favRoutes, { open(it) }, { toggleFav(it) })
                    }
                }
            }
            else -> {
                // 先给完整模块目录（按分组），老板打开「我的」首屏即可看到全部功能；
                // 「今日常用」为快捷入口，移到分组之后，不遮挡目录。
                groupOrder.forEach { g ->
                    val mods = filtered.filter { it.group == g }
                    if (mods.isEmpty()) return@forEach
                    PandaCard {
                        CardHeader(title = g, more = "${mods.size}")
                        Text(groupHint[g] ?: "", fontSize = 11.sp, color = Sub)
                        ModuleGrid(mods, favRoutes, { open(it) }, { toggleFav(it) })
                    }
                }

                if (primary.isNotEmpty()) {
                    PandaCard {
                        CardHeader("今日常用", more = "${primary.size}")
                        Text(BossIa.Mine.PRIMARY_HINT, fontSize = 11.sp, color = Sub)
                        ModuleGrid(primary, favRoutes, { open(it) }, { toggleFav(it) })
                    }
                }
            }
        }

        Text(
            "改数经确认台 · AI 不直写库",
            fontSize = 11.sp,
            color = Sub,
            fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(horizontal = 4.dp)
        )
    }
}
