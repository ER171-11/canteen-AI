package com.pandawufu.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.DinnerDining
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.pandawufu.app.features.chat.ChatScreen
import com.pandawufu.app.features.home.HomeScreen
import com.pandawufu.app.features.inventory.InventoryScreen
import com.pandawufu.app.features.kitchen.KitchenScreen
import com.pandawufu.app.features.more.MoreScreen
import com.pandawufu.app.features.modules.AnalysisScreen
import com.pandawufu.app.features.modules.BookingScreen
import com.pandawufu.app.features.modules.EquipmentScreen
import com.pandawufu.app.features.modules.FinanceScreen
import com.pandawufu.app.features.modules.FoodsafeScreen
import com.pandawufu.app.features.modules.LossScreen
import com.pandawufu.app.features.modules.ReviewScreen
import com.pandawufu.app.features.modules.StaffScreen
import com.pandawufu.app.features.modules.SupplyScreen
import com.pandawufu.app.features.modules.TakeoutScreen
import com.pandawufu.app.features.modules.VipScreen
import com.pandawufu.app.features.pos.PosScreen
import com.pandawufu.app.ui.designsystem.AiPink
import com.pandawufu.app.ui.designsystem.AiPurple
import com.pandawufu.app.ui.designsystem.ShadowColor
import com.pandawufu.app.ui.designsystem.Sub

object Routes {
    const val HOME = "home"
    const val INVENTORY = "inventory"
    const val CHAT = "chat"       // 中间 AI Tab（由 FAB 触发）
    const val KITCHEN = "kitchen"
    const val MORE = "more"

    // 12 个二级模块页（对应原型 p-m-*）
    const val M_ANALYSIS = "m/analysis"
    const val M_STAFF = "m/staff"
    const val M_VIP = "m/vip"
    const val M_POS = "m/pos"
    const val M_TAKEOUT = "m/takeout"
    const val M_BOOKING = "m/booking"
    const val M_FOODSAFE = "m/foodsafe"
    const val M_EQUIPMENT = "m/equipment"
    const val M_FINANCE = "m/finance"
    const val M_SUPPLY = "m/supply"
    const val M_REVIEW = "m/review"
    const val M_LOSS = "m/loss"
}

private data class MainTab(val route: String, val label: String, val icon: androidx.compose.ui.graphics.vector.ImageVector)

private val tabs = listOf(
    MainTab(Routes.HOME, "简报", Icons.Filled.Home),
    MainTab(Routes.INVENTORY, "进销存", Icons.Filled.Inventory2),
    MainTab(Routes.CHAT, "AI", Icons.Filled.AutoAwesome),
    MainTab(Routes.KITCHEN, "厨房", Icons.Filled.DinnerDining),
    MainTab(Routes.MORE, "更多", Icons.Filled.MoreHoriz)
)

@Composable
fun AppNav() {
    val navController = rememberNavController()
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route
    val isMainTab = tabs.any { it.route == currentRoute }

    Scaffold(
        bottomBar = {
            if (isMainTab) {
                Box {
                    NavigationBar {
                        tabs.forEach { tab ->
                            NavigationBarItem(
                                selected = currentRoute == tab.route,
                                onClick = { navController.navigateToTab(tab.route) },
                                icon = {
                                    if (tab.route == Routes.CHAT) {
                                        // 中间 AI 位留空，由悬浮 FAB 承载
                                        Box(Modifier.size(24.dp))
                                    } else {
                                        Icon(tab.icon, contentDescription = tab.label)
                                    }
                                },
                                label = { Text(tab.label) }
                            )
                        }
                    }
                    // 中间 AI FAB：粉紫渐变（#F48FB1 → #9B6BBF）
                    Box(
                        modifier = Modifier
                            .align(Alignment.TopCenter)
                            .offset(y = (-18).dp)
                            .size(56.dp)
                            .shadow(8.dp, CircleShape, ambientColor = ShadowColor, spotColor = ShadowColor)
                            .background(Brush.linearGradient(listOf(AiPink, AiPurple)), CircleShape),
                        contentAlignment = Alignment.Center
                    ) {
                        androidx.compose.material3.IconButton(
                            onClick = { navController.navigateToTab(Routes.CHAT) }
                        ) {
                            Icon(
                                Icons.Filled.AutoAwesome,
                                contentDescription = "AI 对话",
                                tint = Color.White
                            )
                        }
                    }
                }
            }
        }
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = Routes.HOME,
            modifier = Modifier.fillMaxSize().padding(padding)
        ) {
            composable(Routes.HOME) { HomeScreen() }
            composable(Routes.INVENTORY) { InventoryScreen() }
            composable(Routes.CHAT) { ChatScreen() }
            composable(Routes.KITCHEN) { KitchenScreen() }
            composable(Routes.MORE) {
                MoreScreen(onOpenModule = { route -> navController.navigate(route) })
            }
            composable(Routes.M_ANALYSIS) { AnalysisScreen() }
            composable(Routes.M_STAFF) { StaffScreen() }
            composable(Routes.M_VIP) { VipScreen() }
            composable(Routes.M_POS) { PosScreen() }
            composable(Routes.M_TAKEOUT) { TakeoutScreen() }
            composable(Routes.M_BOOKING) { BookingScreen() }
            composable(Routes.M_FOODSAFE) { FoodsafeScreen() }
            composable(Routes.M_EQUIPMENT) { EquipmentScreen() }
            composable(Routes.M_FINANCE) { FinanceScreen() }
            composable(Routes.M_SUPPLY) { SupplyScreen() }
            composable(Routes.M_REVIEW) { ReviewScreen() }
            composable(Routes.M_LOSS) { LossScreen() }
        }
    }
}

private fun NavHostController.navigateToTab(route: String) {
    navigate(route) {
        popUpTo(graph.findStartDestination().id) { saveState = true }
        launchSingleTop = true
        restoreState = true
    }
}
