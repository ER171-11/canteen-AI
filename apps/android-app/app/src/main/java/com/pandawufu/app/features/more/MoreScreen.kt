package com.pandawufu.app.features.more

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.pandawufu.app.ui.Routes

// TODO: 对应原型 p-more（更多 Tab：12 模块宫格入口）。
private data class ModuleEntry(val label: String, val route: String)

private val modules = listOf(
    ModuleEntry("经营分析", Routes.M_ANALYSIS),
    ModuleEntry("排班员工", Routes.M_STAFF),
    ModuleEntry("会员营销", Routes.M_VIP),
    ModuleEntry("堂食收银", Routes.M_POS),
    ModuleEntry("外卖平台", Routes.M_TAKEOUT),
    ModuleEntry("预订排队", Routes.M_BOOKING),
    ModuleEntry("食安证照", Routes.M_FOODSAFE),
    ModuleEntry("设备能耗", Routes.M_EQUIPMENT),
    ModuleEntry("财务税务", Routes.M_FINANCE),
    ModuleEntry("供应链", Routes.M_SUPPLY),
    ModuleEntry("顾客口碑", Routes.M_REVIEW),
    ModuleEntry("损耗报损", Routes.M_LOSS)
)

@Composable
fun MoreScreen(onOpenModule: (String) -> Unit) {
    LazyVerticalGrid(
        columns = GridCells.Fixed(3),
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        items(modules) { m ->
            Card(
                shape = RoundedCornerShape(14.dp),
                modifier = Modifier.fillMaxWidth().clickable { onOpenModule(m.route) }
            ) {
                Text(
                    m.label,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(vertical = 20.dp, horizontal = 8.dp)
                )
            }
        }
    }
}
