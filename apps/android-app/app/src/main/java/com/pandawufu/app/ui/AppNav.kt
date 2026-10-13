package com.pandawufu.app.ui

import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.pandawufu.app.AppModule
import com.pandawufu.app.confirm.ConfirmBus
import com.pandawufu.app.confirm.ConfirmSheetHost
import com.pandawufu.app.features.auth.LoginScreen
import com.pandawufu.app.features.chat.ChatScreen
import com.pandawufu.app.features.fronthall.FrontHallScreen
import com.pandawufu.app.features.home.HomeScreen
import com.pandawufu.app.features.inventory.InventoryScreen
import com.pandawufu.app.features.kitchen.KitchenScreen
import com.pandawufu.app.features.more.MoreScreen
import com.pandawufu.app.features.modules.ActionsScreen
import com.pandawufu.app.features.modules.AnalysisScreen
import com.pandawufu.app.features.modules.BookingScreen
import com.pandawufu.app.features.modules.EquipmentScreen
import com.pandawufu.app.features.modules.FinanceScreen
import com.pandawufu.app.features.modules.FoodsafeScreen
import com.pandawufu.app.features.modules.LocalModuleBack
import com.pandawufu.app.features.modules.LossScreen
import com.pandawufu.app.features.modules.OrgScreen
import com.pandawufu.app.features.modules.RestaurantSettingsScreen
import com.pandawufu.app.features.modules.ReviewScreen
import com.pandawufu.app.features.modules.StaffScreen
import com.pandawufu.app.features.modules.SupplyScreen
import com.pandawufu.app.features.modules.TakeoutScreen
import com.pandawufu.app.features.modules.VipScreen
import com.pandawufu.app.features.pos.PosScreen
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.DisposableEffect
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.pandawufu.app.offline.SyncStatusBar
import com.pandawufu.app.push.SiPushScheduler
import androidx.compose.ui.platform.LocalContext
import com.pandawufu.app.ui.designsystem.DefaultProtoTabs
import com.pandawufu.app.ui.designsystem.PageBg
import com.pandawufu.app.ui.designsystem.AppBgBrush
import com.pandawufu.app.ui.designsystem.ProtoTab
import com.pandawufu.app.ui.designsystem.ProtoTabBar
import com.pandawufu.shared.auth.AuthTokenHolder
import kotlinx.coroutines.launch
import androidx.compose.runtime.rememberCoroutineScope

object Routes {
    const val HOME = "home"
    /** 前厅枢纽（L0 · 方案 C） */
    const val FRONT = "front"
    const val INVENTORY = "inventory"
    const val INVENTORY_CATALOG = "inventory/catalog"
    const val INVENTORY_VENDORS = "inventory/vendors"
    const val INVENTORY_RESTOCK = "inventory/restock"
    const val INVENTORY_PURCHASE = "inventory/purchase"
    const val INVENTORY_RECV = "inventory/recv"
    const val CHAT = "chat"
    const val KITCHEN = "kitchen"
    const val MORE = "more"

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
    const val M_ACTIONS = "m/actions"
    /** SI 收件箱：需拍板 / 执行中 / 预警 / 通知（原确认台升级） */
    const val M_INBOX = "m/inbox"
    /** SI 授权与审计：分级授权政策 + 决策审计 */
    const val M_SI_POLICY = "m/si-policy"
    /** SI 目标面板 */
    const val M_SI_GOALS = "m/si-goals"
    /** SI What-if 模拟 */
    const val M_SI_SIM = "m/si-simulate"
    /** SI 专家团 + 知识 */
    const val M_SI_TEAM = "m/si-team"
    /** SI 战役 */
    const val M_SI_MISSIONS = "m/si-missions"
    /** SI 设置与能力（低频聚合） */
    const val M_SI_SETTINGS = "m/si-settings"
    /** 老板全局 SI 驾驶舱 */
    const val M_SI_COCKPIT = "m/si-cockpit"
    /** 采购工作台 */
    const val M_WB_PROCUREMENT = "m/wb-procurement"
    /** 厨师工作台 */
    const val M_WB_KITCHEN = "m/wb-kitchen"
    const val M_ORG = "m/org"
    /** 我的餐厅：门店资料 / 桌台 / 经营偏好聚合配置 */
    const val M_RESTAURANT = "m/restaurant"
    /** 闭店巡检：50 节点拍照验证（C 块） */
    const val M_INSPECTION = "m/inspection"
    /** 食安拍照核验：员工拍照上报（AI 初判异步，人工复核在后台） */
    const val M_SAFETY_CHECK = "m/safety-check"

    /** 前厅子模块：底栏高亮「前厅」而非「我的」 */
    val frontChildRoutes = setOf(M_POS, M_BOOKING, M_TAKEOUT, M_VIP, M_REVIEW)

    fun inventoryTabOf(route: String): String? = when (route) {
        INVENTORY_CATALOG -> "catalog"
        INVENTORY_VENDORS -> "vendors"
        INVENTORY_RESTOCK -> "restock"
        INVENTORY_PURCHASE -> "purchase"
        INVENTORY_RECV -> "recv"
        INVENTORY -> "stock"
        else -> null
    }
}

@Composable
fun AppNav(modifier: Modifier = Modifier) {
    val appContext = LocalContext.current.applicationContext
    var loggedIn by remember { mutableStateOf(!AuthTokenHolder.get().isNullOrBlank()) }
    LaunchedEffect(Unit) {
        if (!loggedIn) {
            loggedIn = AppModule.ensureSession()
        }
        if (loggedIn) {
            // 离线时 refreshSession 保留本地岗权；联网时刷新 org 岗权（避免微信演示仍卡只读）
            AppModule.refreshSession()
            if (AuthTokenHolder.get().isNullOrBlank() && !AppModule.canEnterOffline()) {
                loggedIn = false
            }
        }
    }

    // 登录后排 SI 收件箱后台轮询（JobScheduler，15 分钟）；登出取消
    LaunchedEffect(loggedIn) {
        if (loggedIn) SiPushScheduler.schedule(appContext) else SiPushScheduler.cancel(appContext)
    }

    // 回到前台再刷一次岗权 / 冲刷离线队列
    val lifecycleOwner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()
    DisposableEffect(lifecycleOwner, loggedIn) {
        val obs = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME && loggedIn) {
                scope.launch {
                    val ok = AppModule.refreshSession()
                    // token 过期被清（如超过 12h TTL）时踢回登录页，避免卡在 App 里满屏报错
                    if (!ok && AuthTokenHolder.get().isNullOrBlank() && !AppModule.canEnterOffline()) {
                        loggedIn = false
                        return@launch
                    }
                    if (AppModule.isOnline()) {
                        runCatching { AppModule.syncEngine.flush() }
                    }
                }
            }
        }
        lifecycleOwner.lifecycle.addObserver(obs)
        onDispose { lifecycleOwner.lifecycle.removeObserver(obs) }
    }

    if (!loggedIn) {
        Box(modifier.fillMaxSize().background(PageBg)) {
            LoginScreen(
                onLoggedIn = { loggedIn = true },
                modifier = Modifier.navigationBarsPadding()
            )
        }
        return
    }

    val tabs: List<ProtoTab> = DefaultProtoTabs.filter { tab ->
        when (tab.route) {
            Routes.CHAT, Routes.MORE, Routes.FRONT -> true
            else -> AppModule.canOpenRoute(tab.route)
        }
    }.ifEmpty {
        DefaultProtoTabs.filter { it.route == Routes.MORE || it.route == Routes.FRONT }
    }

    val navController = rememberNavController()
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route
    val tabHighlightRoute = when {
        currentRoute == Routes.HOME -> Routes.CHAT
        currentRoute == Routes.FRONT || currentRoute in Routes.frontChildRoutes -> Routes.FRONT
        currentRoute?.startsWith("inventory") == true -> Routes.INVENTORY
        currentRoute?.startsWith("kitchen") == true -> Routes.KITCHEN
        currentRoute?.startsWith("m/") == true -> Routes.MORE
        else -> currentRoute
    }
    // 一级页（底部 5 个 Tab 根页）不出返回键；其余子页（m/*、今日总览、进销存子页）均给返回键
    val rootRoutes = setOf(Routes.FRONT, Routes.INVENTORY, Routes.CHAT, Routes.KITCHEN, Routes.MORE)
    val isMainTab = currentRoute != null && currentRoute in rootRoutes

    fun handleLogout() {
        AppModule.logout()
        SiPushScheduler.cancel(appContext)
        loggedIn = false
    }

    Box(
        modifier
            .fillMaxSize()
            .background(AppBgBrush)
    ) {
        Column(Modifier.fillMaxSize()) {
            SyncStatusBar(Modifier.fillMaxWidth())
            Box(Modifier.weight(1f).fillMaxWidth()) {
                CompositionLocalProvider(
                    LocalModuleBack provides if (isMainTab) null else ({ navController.popBackStack() })
                ) {
                    NavHost(
                        navController = navController,
                        startDestination = Routes.CHAT,
                        modifier = Modifier.fillMaxSize(),
                        enterTransition = {
                            fadeIn(tween(200)) + slideInHorizontally(tween(220)) { it / 28 }
                        },
                        exitTransition = {
                            fadeOut(tween(140))
                        },
                        popEnterTransition = {
                            fadeIn(tween(180))
                        },
                        popExitTransition = {
                            fadeOut(tween(160)) + slideOutHorizontally(tween(200)) { it / 22 }
                        }
                    ) {
                        composable(Routes.HOME) {
                            HomeScreen(
                                onOpenModule = { navController.navigate(it) },
                                onLogout = { handleLogout() }
                            )
                        }
                        composable(Routes.FRONT) {
                            FrontHallScreen(onOpen = { route ->
                                runCatching { AppModule.modulePrefs.touch(route) }
                                navController.navigate(route)
                            })
                        }
                        composable(Routes.INVENTORY) {
                            InventoryScreen(onOpenModule = { navController.navigate(it) })
                        }
                        composable(Routes.INVENTORY_CATALOG) {
                            InventoryScreen(com.pandawufu.shared.viewmodel.InventoryViewModel.InventoryTab.CATALOG)
                        }
                        composable(Routes.INVENTORY_VENDORS) {
                            InventoryScreen(com.pandawufu.shared.viewmodel.InventoryViewModel.InventoryTab.VENDORS)
                        }
                        composable(Routes.INVENTORY_RESTOCK) {
                            InventoryScreen(com.pandawufu.shared.viewmodel.InventoryViewModel.InventoryTab.RESTOCK)
                        }
                        composable(Routes.INVENTORY_PURCHASE) {
                            InventoryScreen(com.pandawufu.shared.viewmodel.InventoryViewModel.InventoryTab.PURCHASE)
                        }
                        composable(Routes.INVENTORY_RECV) {
                            InventoryScreen(com.pandawufu.shared.viewmodel.InventoryViewModel.InventoryTab.RECV)
                        }
                        composable(Routes.CHAT) {
                            ChatScreen(onOpenModule = { navController.navigate(it) })
                        }
                        composable(Routes.KITCHEN) {
                            KitchenScreen(onOpenModule = { navController.navigate(it) })
                        }
                        composable(Routes.MORE) {
                            MoreScreen(
                                onOpenModule = { route ->
                                    runCatching { AppModule.modulePrefs.touch(route) }
                                    navController.navigate(route)
                                },
                                onLogout = { handleLogout() }
                            )
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
                        composable(Routes.M_ACTIONS) { ActionsScreen() }
                        composable(Routes.M_INBOX) {
                            com.pandawufu.app.features.inbox.InboxScreen(
                                onOpen = { route ->
                                    runCatching { AppModule.modulePrefs.touch(route) }
                                    navController.navigate(route)
                                }
                            )
                        }
                        composable(Routes.M_SI_POLICY) {
                            com.pandawufu.app.features.inbox.PolicyScreen()
                        }
                        composable(Routes.M_SI_GOALS) {
                            com.pandawufu.app.features.si.GoalScreen(
                                onOpen = { route ->
                                    runCatching { AppModule.modulePrefs.touch(route) }
                                    navController.navigate(route)
                                }
                            )
                        }
                        composable(Routes.M_SI_SIM) {
                            com.pandawufu.app.features.si.SimulateScreen()
                        }
                        composable(Routes.M_SI_TEAM) {
                            com.pandawufu.app.features.si.TeamScreen(
                                onOpen = { route ->
                                    runCatching { AppModule.modulePrefs.touch(route) }
                                    navController.navigate(route)
                                }
                            )
                        }
                        composable(Routes.M_SI_MISSIONS) {
                            com.pandawufu.app.features.si.MissionScreen(
                                onOpen = { route ->
                                    runCatching { AppModule.modulePrefs.touch(route) }
                                    navController.navigate(route)
                                }
                            )
                        }
                        composable(Routes.M_SI_SETTINGS) {
                            com.pandawufu.app.features.si.SiSettingsScreen(
                                onOpen = { route ->
                                    runCatching { AppModule.modulePrefs.touch(route) }
                                    navController.navigate(route)
                                }
                            )
                        }
                        composable(Routes.M_SI_COCKPIT) {
                            com.pandawufu.app.features.si.SiCockpitScreen(
                                onOpen = { route ->
                                    runCatching { AppModule.modulePrefs.touch(route) }
                                    navController.navigate(route)
                                }
                            )
                        }
                        composable(Routes.M_WB_PROCUREMENT) {
                            com.pandawufu.app.features.si.ProcurementWorkbenchScreen(
                                onOpen = { route ->
                                    runCatching { AppModule.modulePrefs.touch(route) }
                                    navController.navigate(route)
                                }
                            )
                        }
                        composable(Routes.M_WB_KITCHEN) {
                            com.pandawufu.app.features.si.KitchenWorkbenchScreen(
                                onOpen = { route ->
                                    runCatching { AppModule.modulePrefs.touch(route) }
                                    navController.navigate(route)
                                }
                            )
                        }
                        composable(Routes.M_ORG) { OrgScreen() }
                        composable(Routes.M_RESTAURANT) {
                            RestaurantSettingsScreen(
                                onOpen = { route -> navController.navigate(route) }
                            )
                        }
                        composable(Routes.M_INSPECTION) {
                            com.pandawufu.app.features.inspection.InspectionScreen()
                        }
                        composable(Routes.M_SAFETY_CHECK) {
                            com.pandawufu.app.features.safety.SafetyCheckScreen()
                        }
                    }
                }

                if (ConfirmBus.request == null) {
                    ProtoTabBar(
                        tabs = tabs,
                        currentRoute = tabHighlightRoute ?: Routes.MORE,
                        onSelect = { navController.navigateToTab(it) },
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .navigationBarsPadding()
                    )
                }

                ConfirmSheetHost()
                com.pandawufu.app.features.inventory.RestockEditHost()
            }
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
