package com.pandawufu.app.features.modules

import android.widget.Toast
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.AppModule
import com.pandawufu.app.confirm.ConfirmBus
import com.pandawufu.app.confirm.ConfirmRequest
import com.pandawufu.app.confirm.OpsSignal
import com.pandawufu.app.ui.BossIa
import com.pandawufu.app.ui.Routes
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.Line
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.model.DishDto
import com.pandawufu.shared.model.OrgStoreDto
import com.pandawufu.shared.model.OrgUpdateStoreRequest
import com.pandawufu.shared.model.PosTableDto
import com.pandawufu.shared.model.RecipeDto
import com.pandawufu.shared.viewmodel.InventoryViewModel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * 我的餐厅 — 门店资料、桌台、营业偏好、菜单价盘。
 * 组织账号进「门店岗位」；产品库/供应商从底栏「货品」进；收银从「我的」进。
 */
@Composable
fun RestaurantSettingsScreen(onOpen: (String) -> Unit = {}) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val invVm = remember { InventoryViewModel(AppModule.inventoryRepository) }
    val invState by invVm.state.collectAsState()
    var tab by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var stores by remember { mutableStateOf<List<OrgStoreDto>>(emptyList()) }
    var store by remember { mutableStateOf<OrgStoreDto?>(null) }
    var openHour by remember { mutableStateOf("10:00") }
    var closeHour by remember { mutableStateOf("21:00") }
    var defaultCat by remember { mutableStateOf(AppModule.modulePrefs.posDefaultCat()) }
    var flourSafe by remember { mutableStateOf("10") }
    var cfgRev by remember { mutableStateOf<String?>(null) }
    var editStore by remember { mutableStateOf(false) }
    var tableEdit by remember { mutableStateOf<PosTableDto?>(null) }
    var tableAdd by remember { mutableStateOf(false) }

    val canOrg = AppModule.can("org", write = true) ||
        AppModule.role == "老板" || AppModule.role == "店长"
    val canWrite = AppModule.canWrite()

    fun toast(msg: String) = Toast.makeText(context, msg, Toast.LENGTH_SHORT).show()

    fun reload() {
        scope.launch {
            loading = true
            error = null
            try {
                AppModule.ensureSession()
                invVm.dispatch(InventoryViewModel.InventoryIntent.Refresh)
                val org = AppModule.bffClient.orgOverview()
                if (!org.ok) {
                    val fail = com.pandawufu.shared.util.LoadFailure.fromMessage(org.error)
                    error = fail.error ?: fail.hint ?: (org.error ?: "组织数据加载失败")
                } else {
                    stores = org.stores
                    store = org.stores.firstOrNull {
                        it.name == AppModule.storeName
                    } ?: org.stores.firstOrNull()
                }
                runCatching {
                    val cfg = AppModule.bffClient.adminConfig()
                    if (cfg.ok) {
                        cfgRev = cfg.rev?.toString()?.trim('"')
                        val c = cfg.config
                        val hours = c?.get("business_hours")?.jsonObject
                        hours?.get("open")?.jsonPrimitive?.contentOrNull?.let { openHour = it }
                        hours?.get("close")?.jsonPrimitive?.contentOrNull?.let { closeHour = it }
                        c?.get("pos")?.jsonObject?.get("default_cat")?.jsonPrimitive?.contentOrNull
                            ?.takeIf { it.isNotBlank() }?.let { defaultCat = it }
                        c?.get("pos.default_cat")?.jsonPrimitive?.contentOrNull
                            ?.takeIf { it.isNotBlank() }?.let { defaultCat = it }
                        val safe = c?.get("safety_stock")?.jsonObject
                        safe?.get("面粉")?.jsonPrimitive?.contentOrNull?.let { flourSafe = it }
                            ?: safe?.get("flour")?.jsonPrimitive?.contentOrNull?.let { flourSafe = it }
                    }
                }
            } catch (e: Exception) {
                val fail = com.pandawufu.shared.util.LoadFailure.from(e)
                error = fail.error ?: fail.hint
            } finally {
                loading = false
            }
        }
    }

    LaunchedEffect(Unit) { reload() }

    ModuleScaffold(
        title = BossIa.Restaurant.TITLE,
        subtitle = BossIa.Restaurant.SUB,
        loading = loading && store == null && invState.posTables.isEmpty(),
        error = error,
        hint = invState.emptyHint,
        onRetry = { reload() },
        empty = false,
        pills = BossIa.Restaurant.pills,
        selectedPill = tab,
        onPill = { tab = it }
    ) {
        ConfigHealthCard(
            tables = invState.posTables,
            dishes = invState.dishes,
            openHour = openHour,
            closeHour = closeHour,
            defaultCat = defaultCat,
            flourSafe = flourSafe
        )
        when (tab) {
            0 -> StoreProfileSection(
                store = store,
                stores = stores,
                canEdit = canOrg,
                onPick = { store = it },
                onEdit = { editStore = true },
                onReload = { reload() },
                onOpenOrg = { onOpen(Routes.M_ORG) }
            )
            1 -> DiningSection(
                tables = invState.posTables,
                rev = invState.rev,
                canWrite = canWrite,
                onAdd = { tableAdd = true },
                onEdit = { tableEdit = it },
                onRemove = { t ->
                    ConfirmBus.ask(
                        ConfirmRequest(
                            title = "删除桌台",
                            summary = "删除 ${t.no ?: t.id}（仅空闲桌可删）",
                            type = "pos.table_remove",
                            payload = buildJsonObject {
                                put("table_id", t.id)
                                put("id", t.id)
                            },
                            baseRev = invState.rev,
                            onResult = { r ->
                                toast(r.fold({ "已提交删桌" }, { it.message ?: "失败" }))
                                if (r.isSuccess) invVm.dispatch(InventoryViewModel.InventoryIntent.Refresh)
                            }
                        )
                    )
                }
            )
            2 -> OpsPrefsSection(
                openHour = openHour,
                closeHour = closeHour,
                defaultCat = defaultCat,
                flourSafe = flourSafe,
                cfgRev = cfgRev,
                canWrite = canWrite,
                onOpen = { openHour = it },
                onClose = { closeHour = it },
                onCat = { defaultCat = it },
                onFlour = { flourSafe = it },
                onSaveHours = {
                    ConfirmBus.ask(
                        ConfirmRequest(
                            title = "保存营业时段",
                            summary = "开门 $openHour · 打烊 $closeHour",
                            type = "config.update",
                            payload = buildJsonObject {
                                put(
                                    "business_hours",
                                    buildJsonObject {
                                        put("open", openHour)
                                        put("close", closeHour)
                                    }
                                )
                            },
                            baseRev = cfgRev ?: invState.rev,
                            onResult = { r ->
                                toast(r.fold({ "营业时段已入队" }, { it.message ?: "失败" }))
                            }
                        )
                    )
                },
                onSaveCat = {
                    AppModule.modulePrefs.setPosDefaultCat(defaultCat)
                    ConfirmBus.ask(
                        ConfirmRequest(
                            title = "保存默认菜类",
                            summary = "收银默认分类：$defaultCat（本机已同步，店内需确认）",
                            type = "config.update",
                            payload = buildJsonObject {
                                put(
                                    "pos",
                                    buildJsonObject { put("default_cat", defaultCat) }
                                )
                                put("pos.default_cat", defaultCat)
                            },
                            baseRev = cfgRev ?: invState.rev,
                            onResult = { r ->
                                toast(r.fold({ "默认菜类已入队" }, { it.message ?: "失败" }))
                            }
                        )
                    )
                },
                onSaveFlour = {
                    val n = flourSafe.toDoubleOrNull()
                    if (n == null) {
                        toast("请输入有效公斤数")
                        return@OpsPrefsSection
                    }
                    ConfirmBus.ask(
                        ConfirmRequest(
                            title = "保存面粉安全库存",
                            summary = "面粉安全线 $n",
                            type = "config.update",
                            payload = buildJsonObject {
                                put(
                                    "safety_stock",
                                    buildJsonObject { put("面粉", n) }
                                )
                            },
                            baseRev = cfgRev ?: invState.rev,
                            onResult = { r ->
                                toast(r.fold({ "安全库存已入队" }, { it.message ?: "失败" }))
                            }
                        )
                    )
                }
            )
            3 -> MenuDishesSection(
                dishes = invState.dishes,
                rev = invState.rev,
                canWrite = canWrite,
                onRefresh = { invVm.dispatch(InventoryViewModel.InventoryIntent.Refresh) }
            )
        }
    }

    if (editStore && store != null) {
        StoreEditDialog(
            initial = store!!,
            onDismiss = { editStore = false },
            onSave = { name, brand, city, address, status ->
                editStore = false
                scope.launch {
                    try {
                        val resp = AppModule.bffClient.orgUpdateStore(
                            OrgUpdateStoreRequest(
                                id = store!!.id ?: return@launch,
                                name = name,
                                brand = brand,
                                city = city,
                                address = address,
                                status = status
                            )
                        )
                        if (resp.ok) {
                            toast("门店资料已保存")
                            reload()
                        } else {
                            toast(resp.error ?: "保存失败")
                        }
                    } catch (e: Exception) {
                        toast(e.message ?: "保存失败")
                    }
                }
            }
        )
    }

    if (tableAdd || tableEdit != null) {
        TableEditDialog(
            initial = tableEdit,
            onDismiss = { tableAdd = false; tableEdit = null },
            onSave = { no, name, zone, seats ->
                val editing = tableEdit
                tableAdd = false
                tableEdit = null
                ConfirmBus.ask(
                    ConfirmRequest(
                        title = if (editing == null) "新增桌台" else "改桌台",
                        summary = "$zone · ${no}号 · ${seats}座" + (name.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""),
                        type = "pos.table_upsert",
                        payload = buildJsonObject {
                            if (editing != null) put("table_id", editing.id)
                            put("no", no)
                            put("name", name.ifBlank { "${no}号桌" })
                            put("zone", zone)
                            put("seats", seats)
                            if (editing == null) put("state", "free")
                        },
                        baseRev = invState.rev,
                        onResult = { r ->
                            toast(r.fold({ "桌台已提交" }, { it.message ?: "失败" }))
                            if (r.isSuccess) invVm.dispatch(InventoryViewModel.InventoryIntent.Refresh)
                        }
                    )
                )
            }
        )
    }
}

@Composable
private fun StoreProfileSection(
    store: OrgStoreDto?,
    stores: List<OrgStoreDto>,
    canEdit: Boolean,
    onPick: (OrgStoreDto) -> Unit,
    onEdit: () -> Unit,
    onReload: () -> Unit,
    onOpenOrg: () -> Unit
) {
    ModuleCard("当前门店") {
        if (store == null) {
            Text("暂无门店档案 · 可去「门店岗位」筹备新店", color = Sub, fontSize = 13.sp)
        } else {
            KvRow("名称", store.name ?: "-")
            KvRow("品牌", store.brand ?: "-")
            KvRow("城市", store.city ?: "-")
            KvRow("地址", store.address ?: "-")
            KvRow("状态", store.status ?: "-")
            if (canEdit) {
                Button(
                    onClick = onEdit,
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth()
                ) { Text("编辑门店资料") }
            }
        }
        if (stores.size > 1) {
            Text("切换门店", fontWeight = FontWeight.Bold, fontSize = 13.sp)
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                stores.forEach { s ->
                    val on = s.id == store?.id
                    Box(
                        Modifier
                            .clip(RoundedCornerShape(12.dp))
                            .border(1.dp, if (on) Ink else Line, RoundedCornerShape(12.dp))
                            .clickable { onPick(s) }
                            .padding(horizontal = 10.dp, vertical = 6.dp)
                    ) {
                        Text(s.name ?: s.id ?: "?", color = if (on) Ink else Sub, fontSize = 12.sp)
                    }
                }
            }
        }
        OutlinedButton(
            onClick = onOpenOrg,
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.fillMaxWidth()
        ) { Text("门店岗位 / 开账号") }
        OutlinedButton(onClick = onReload, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
            Text("刷新")
        }
    }
}

@Composable
private fun DiningSection(
    tables: List<PosTableDto>,
    rev: String?,
    canWrite: Boolean,
    onAdd: () -> Unit,
    onEdit: (PosTableDto) -> Unit,
    onRemove: (PosTableDto) -> Unit
) {
    ModuleCard("桌台平面（${tables.size}）") {
        Text("增删改桌台主数据；巡台改态/结账在「堂食收银」。", color = Sub, fontSize = 12.sp)
        if (canWrite) {
            Button(onClick = onAdd, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
                Text("新增桌台")
            }
        }
        if (tables.isEmpty()) {
            Text("暂无桌台 · 请先新增，或等店内快照推送", color = Sub, fontSize = 13.sp)
        }
        tables.sortedBy { it.no ?: it.id }.forEach { t ->
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        "${t.no ?: t.id} · ${t.zone ?: "大厅"} · ${t.seats ?: 4}座",
                        fontWeight = FontWeight.Bold,
                        fontSize = 14.sp
                    )
                    Text(
                        listOfNotNull(t.name, t.state, t.amount?.let { "挂¥$it" }).joinToString(" · "),
                        color = Sub,
                        fontSize = 12.sp
                    )
                }
                if (canWrite) {
                    Text(
                        "改",
                        color = FiveGreen,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier
                            .clickable { onEdit(t) }
                            .padding(8.dp)
                    )
                    Text(
                        "删",
                        color = Color(0xFFE8584A),
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier
                            .clickable { onRemove(t) }
                            .padding(8.dp)
                    )
                }
            }
        }
        if (rev != null) Text("快照 rev $rev", color = Sub, fontSize = 11.sp)
    }
}

@Composable
private fun OpsPrefsSection(
    openHour: String,
    closeHour: String,
    defaultCat: String,
    flourSafe: String,
    cfgRev: String?,
    canWrite: Boolean,
    onOpen: (String) -> Unit,
    onClose: (String) -> Unit,
    onCat: (String) -> Unit,
    onFlour: (String) -> Unit,
    onSaveHours: () -> Unit,
    onSaveCat: () -> Unit,
    onSaveFlour: () -> Unit
) {
    ModuleCard("营业时段") {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = openHour, onValueChange = onOpen,
                label = { Text("开门") }, singleLine = true, modifier = Modifier.weight(1f)
            )
            OutlinedTextField(
                value = closeHour, onValueChange = onClose,
                label = { Text("打烊") }, singleLine = true, modifier = Modifier.weight(1f)
            )
        }
        if (canWrite) {
            Button(onClick = onSaveHours, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
                Text("保存营业时段")
            }
        }
    }
    ModuleCard("收银默认菜类") {
        Text("点菜页打开时默认筛选的分类", color = Sub, fontSize = 12.sp)
        Row(
            Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            listOf("全部", "引流", "爆品", "利润", "形象", "常规", "五福饺").forEach { c ->
                val on = defaultCat == c
                Box(
                    Modifier
                        .clip(RoundedCornerShape(12.dp))
                        .border(1.dp, if (on) Ink else Line, RoundedCornerShape(12.dp))
                        .clickable { onCat(c) }
                        .padding(horizontal = 10.dp, vertical = 6.dp)
                ) {
                    Text(c, color = if (on) Ink else Sub, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                }
            }
        }
        if (canWrite) {
            Button(onClick = onSaveCat, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
                Text("保存默认菜类")
            }
        }
    }
    ModuleCard("库存安全线默认") {
        Text("全局面粉安全线；其它原料到产品库逐条改。", color = Sub, fontSize = 12.sp)
        OutlinedTextField(
            value = flourSafe, onValueChange = onFlour,
            label = { Text("面粉安全库存") }, singleLine = true, modifier = Modifier.fillMaxWidth()
        )
        if (canWrite) {
            Button(onClick = onSaveFlour, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
                Text("保存面粉安全线")
            }
        }
        cfgRev?.let { Text("配置 rev $it", color = Sub, fontSize = 11.sp) }
    }
}

@Composable
private fun MenuDishesSection(
    dishes: List<DishDto>,
    rev: String?,
    canWrite: Boolean,
    onRefresh: () -> Unit
) {
    var edit by remember { mutableStateOf<DishDto?>(null) }
    var add by remember { mutableStateOf(false) }
    var linkDish by remember { mutableStateOf<DishDto?>(null) }
    var recipes by remember { mutableStateOf<List<RecipeDto>>(emptyList()) }
    var showPreview by remember { mutableStateOf(false) }
    var showResult by remember { mutableStateOf<String?>(null) }
    val ctx = LocalContext.current
    val bomRecipes = remember(recipes) {
        recipes.filter { it.main.isNotEmpty() || it.aux.isNotEmpty() || it.seasoning.isNotEmpty() }
    }
    val skuName = remember(bomRecipes) {
        bomRecipes.associate { it.skuId to it.name }
    }
    val unlinked = remember(dishes) { dishes.filter { it.skuId.isNullOrBlank() } }
    val linked = remember(dishes) { dishes.filter { !it.skuId.isNullOrBlank() } }
    val linkedN = linked.size
    val jiaoUnlinked = remember(unlinked) {
        unlinked.filter { d ->
            val n = d.name
            "饺" in n || d.cat in setOf("红", "黄", "绿", "紫", "黑", "白")
        }
    }
    val preview = remember(dishes, bomRecipes) {
        previewAutoLink(dishes, bomRecipes)
    }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        runCatching {
            AppModule.ensureSession()
            recipes = AppModule.bffClient.kitchenRecipes().items
        }
    }

    ModuleCard("堂食菜单（${dishes.size}）· 已挂 $linkedN · 未挂 ${unlinked.size}") {
        Text(
            "结账扣料只认「菜品 ↔ 厨房菜谱」。智能关联只动有把握的饺子；没把握的留给你手选，普通凉菜/热菜不动。",
            color = Sub,
            fontSize = 12.sp
        )
        Text(
            "厨房可扣料 ${bomRecipes.size} 道 · 饺类未挂 ${jiaoUnlinked.size} · 普通菜未挂 ${unlinked.size - jiaoUnlinked.size}（可不挂）",
            color = Ink,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(top = 2.dp, bottom = 4.dp)
        )
        if (canWrite) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Button(
                    onClick = {
                        if (bomRecipes.isEmpty()) {
                            Toast.makeText(ctx, "厨房还没有可扣料菜谱，先去「后厨 → 菜谱」建 BOM", Toast.LENGTH_LONG).show()
                        } else {
                            showPreview = true
                        }
                    },
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.weight(1f)
                ) { Text("智能关联") }
                OutlinedButton(
                    onClick = { add = true },
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.weight(1f)
                ) { Text("新增菜品") }
            }
        }
        if (dishes.isEmpty()) {
            Text("暂无菜品 · 等快照或手动新增", color = Sub, fontSize = 13.sp)
        }
        if (jiaoUnlinked.isNotEmpty()) {
            Text(
                "饺类未挂（${jiaoUnlinked.size}）— 结账扣料前建议处理",
                color = Color(0xFFE8584A),
                fontWeight = FontWeight.Bold,
                fontSize = 12.sp,
                modifier = Modifier.padding(top = 4.dp)
            )
            jiaoUnlinked.take(20).forEach { d ->
                DishMenuRow(
                    d = d,
                    linked = false,
                    recipeHint = null,
                    canWrite = canWrite,
                    rev = rev,
                    onLink = { linkDish = d },
                    onEdit = { edit = d },
                    onRefresh = onRefresh
                )
            }
        }
        val otherUnlinked = unlinked.filter { d -> jiaoUnlinked.none { it.id == d.id } }
        if (otherUnlinked.isNotEmpty()) {
            Text(
                "其他未挂（${otherUnlinked.size}）— 无饺子 BOM 可跳过",
                color = Sub,
                fontWeight = FontWeight.Bold,
                fontSize = 12.sp,
                modifier = Modifier.padding(top = 6.dp)
            )
            otherUnlinked.take(12).forEach { d ->
                DishMenuRow(
                    d = d,
                    linked = false,
                    recipeHint = null,
                    canWrite = canWrite,
                    rev = rev,
                    onLink = { linkDish = d },
                    onEdit = { edit = d },
                    onRefresh = onRefresh
                )
            }
            if (otherUnlinked.size > 12) {
                Text("…还有 ${otherUnlinked.size - 12} 道", color = Sub, fontSize = 11.sp)
            }
        }
        if (linked.isNotEmpty()) {
            Text(
                "已挂菜谱（${linked.size}）— 结账会扣这些 BOM",
                color = FiveGreen,
                fontWeight = FontWeight.Bold,
                fontSize = 12.sp,
                modifier = Modifier.padding(top = 6.dp)
            )
            linked.take(30).forEach { d ->
                val hint = d.skuId?.let { sku ->
                    skuName[sku]?.take(18) ?: sku
                }
                DishMenuRow(
                    d = d,
                    linked = true,
                    recipeHint = hint,
                    canWrite = canWrite,
                    rev = rev,
                    onLink = { linkDish = d },
                    onEdit = { edit = d },
                    onRefresh = onRefresh
                )
            }
            if (linked.size > 30) {
                Text("…还有 ${linked.size - 30} 道已挂", color = Sub, fontSize = 11.sp)
            }
        }
    }

    if (showPreview) {
        AlertDialog(
            onDismissRequest = { showPreview = false },
            title = { Text("智能关联 · 先看清再执行", fontWeight = FontWeight.Bold) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        "只改「有把握」的挂靠；已挂的不动；普通菜不动。",
                        color = Sub,
                        fontSize = 12.sp
                    )
                    if (preview.willLink.isNotEmpty()) {
                        Text("将自动挂靠（${preview.willLink.size}）", fontWeight = FontWeight.Bold, color = FiveGreen, fontSize = 13.sp)
                        preview.willLink.take(8).forEach { (dish, recipe) ->
                            Text(
                                "· ${dish.name} → ${recipe.color?.let { "${it}饺" } ?: recipe.name.take(14)}",
                                fontSize = 13.sp,
                                color = Ink
                            )
                        }
                        if (preview.willLink.size > 8) {
                            Text("…还有 ${preview.willLink.size - 8} 道", color = Sub, fontSize = 11.sp)
                        }
                    } else {
                        Text("没有新的可自动挂靠项", color = Sub, fontSize = 13.sp)
                    }
                    if (preview.needManual.isNotEmpty()) {
                        Text("需你手选（${preview.needManual.size}）", fontWeight = FontWeight.Bold, color = Color(0xFFE8584A), fontSize = 13.sp)
                        preview.needManual.take(6).forEach { d ->
                            Text("· ${d.name}（多色/歧义，不敢瞎挂）", fontSize = 13.sp, color = Ink)
                        }
                    }
                    if (preview.willCreate > 0) {
                        Text(
                            "菜单缺壳时会补建 ${preview.willCreate} 道（厨房有 BOM、菜单没有）",
                            color = Sub,
                            fontSize = 12.sp
                        )
                    }
                    Text(
                        "已挂跳过 ${preview.skipLinked} · 非扣料菜跳过 ${preview.skipOther}",
                        color = Sub,
                        fontSize = 12.sp
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    showPreview = false
                    val summary = buildString {
                        append("有把握才挂，已挂不动。\n")
                        if (preview.willLink.isNotEmpty()) {
                            append("将挂：")
                            append(preview.willLink.take(5).joinToString("、") { (d, r) ->
                                "${d.name}→${r.color ?: r.name.take(8)}"
                            })
                            if (preview.willLink.size > 5) append("…")
                            append("\n")
                        } else append("无新挂项\n")
                        if (preview.needManual.isNotEmpty()) {
                            append("手选留给你：")
                            append(preview.needManual.take(4).joinToString("、") { it.name })
                        }
                    }
                    ConfirmBus.ask(
                        ConfirmRequest(
                            title = "确认执行智能关联",
                            summary = summary,
                            type = "dish.auto_link",
                            payload = buildJsonObject {
                                put("min_score", 0.72)
                                put("create_missing", true)
                            },
                            baseRev = rev,
                            onResult = { r ->
                                if (r.isSuccess) {
                                    val tip = OpsSignal.lastDetail
                                        ?.removePrefix("dish.auto_link ")
                                        ?.trim()
                                        ?: OpsSignal.banner
                                    showResult = tip ?: "已执行，请下拉核对已挂列表"
                                    onRefresh()
                                    scope.launch {
                                        runCatching {
                                            recipes = AppModule.bffClient.kitchenRecipes().items
                                        }
                                    }
                                }
                            }
                        )
                    )
                }) { Text(if (preview.willLink.isEmpty() && preview.willCreate == 0) "仍要跑一遍" else "确认执行") }
            },
            dismissButton = {
                TextButton(onClick = { showPreview = false }) { Text("取消") }
            }
        )
    }

    showResult?.let { msg ->
        AlertDialog(
            onDismissRequest = { showResult = null },
            title = { Text("关联结果", fontWeight = FontWeight.Bold) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(msg, fontSize = 14.sp, color = Ink)
                    Text(
                        "请在下方「已挂 / 饺类未挂」核对；不对的点「换挂」或「挂」。",
                        color = Sub,
                        fontSize = 12.sp
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = { showResult = null }) { Text("知道了") }
            }
        )
    }

    linkDish?.let { d ->
        AlertDialog(
            onDismissRequest = { linkDish = null },
            title = { Text("挂菜谱 · ${d.name}", fontWeight = FontWeight.Bold) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        "手选后结账按该菜谱扣料。当前：${d.skuId?.let { skuName[it] ?: it } ?: "未挂"}",
                        color = Sub,
                        fontSize = 12.sp
                    )
                    if (bomRecipes.isEmpty()) {
                        Text("暂无带 BOM 的菜谱 · 先去厨房建菜谱", color = Sub, fontSize = 12.sp)
                    }
                    bomRecipes.forEach { r ->
                        val selected = r.skuId == d.skuId
                        Text(
                            "${if (selected) "● " else "○ "}${r.name.take(28)}" +
                                (r.color?.let { " · $it" } ?: ""),
                            color = if (selected) FiveGreen else Ink,
                            fontSize = 13.sp,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    linkDish = null
                                    ConfirmBus.ask(
                                        ConfirmRequest(
                                            title = "确认挂靠菜谱",
                                            summary = "${d.name} → ${r.color?.let { "${it}饺" } ?: r.name}\n结账将按此 BOM 扣料",
                                            type = "dish.upsert",
                                            payload = buildJsonObject {
                                                put("id", d.id)
                                                put("name", d.name)
                                                put("sku_id", r.skuId)
                                                put("recipe_link", "manual")
                                            },
                                            baseRev = rev,
                                            onResult = { res -> if (res.isSuccess) onRefresh() }
                                        )
                                    )
                                }
                                .padding(vertical = 4.dp)
                        )
                    }
                    if (!d.skuId.isNullOrBlank()) {
                        Text(
                            "清除关联",
                            color = Color(0xFFE8584A),
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier
                                .clickable {
                                    linkDish = null
                                    ConfirmBus.ask(
                                        ConfirmRequest(
                                            title = "清除菜谱关联",
                                            summary = "${d.name} 取消挂靠后，结账将不再扣 BOM",
                                            type = "dish.upsert",
                                            payload = buildJsonObject {
                                                put("id", d.id)
                                                put("name", d.name)
                                                put("sku_id", "")
                                            },
                                            baseRev = rev,
                                            onResult = { res -> if (res.isSuccess) onRefresh() }
                                        )
                                    )
                                }
                                .padding(top = 8.dp)
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { linkDish = null }) { Text("关闭") }
            }
        )
    }

    if (edit != null || add) {
        val d = edit
        var name by remember(d) { mutableStateOf(d?.name ?: "") }
        var cat by remember(d) { mutableStateOf(d?.cat ?: "常规") }
        var price by remember(d) { mutableStateOf(d?.price?.let { if (it == it.toLong().toDouble()) "%.0f".format(it) else "%.1f".format(it) } ?: "") }
        AlertDialog(
            onDismissRequest = { edit = null; add = false },
            title = { Text(if (d == null) "新增菜品" else "改价 · ${d.name}", fontWeight = FontWeight.Bold) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (d == null) {
                        OutlinedTextField(
                            value = name, onValueChange = { name = it },
                            label = { Text("菜名") }, singleLine = true, modifier = Modifier.fillMaxWidth()
                        )
                        OutlinedTextField(
                            value = cat, onValueChange = { cat = it },
                            label = { Text("分类") }, singleLine = true, modifier = Modifier.fillMaxWidth()
                        )
                    }
                    OutlinedTextField(
                        value = price, onValueChange = { price = it },
                        label = { Text("售价") }, singleLine = true, modifier = Modifier.fillMaxWidth()
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val p = price.toDoubleOrNull()
                    if (p == null) return@TextButton
                    edit = null
                    add = false
                    if (d == null) {
                        if (name.isBlank()) return@TextButton
                        ConfirmBus.ask(
                            ConfirmRequest(
                                title = "新增菜品",
                                summary = "$name · $cat · ¥$p",
                                type = "dish.upsert",
                                payload = buildJsonObject {
                                    put("name", name.trim())
                                    put("cat", cat.trim().ifBlank { "常规" })
                                    put("price", p)
                                    put("on", true)
                                },
                                baseRev = rev,
                                onResult = { r -> if (r.isSuccess) onRefresh() }
                            )
                        )
                    } else {
                        ConfirmBus.ask(
                            ConfirmRequest(
                                title = "调价",
                                summary = "${d.name} ¥${d.price ?: 0} → ¥$p",
                                type = "dish.price",
                                payload = buildJsonObject {
                                    put("id", d.id)
                                    put("name", d.name)
                                    put("price", p)
                                    put("reason", "App 调价")
                                },
                                baseRev = rev,
                                onResult = { r -> if (r.isSuccess) onRefresh() }
                            )
                        )
                    }
                }) { Text("提交") }
            },
            dismissButton = {
                TextButton(onClick = { edit = null; add = false }) { Text("取消") }
            }
        )
    }
}


private data class AutoLinkPreview(
    val willLink: List<Pair<DishDto, RecipeDto>>,
    val needManual: List<DishDto>,
    val skipLinked: Int,
    val skipOther: Int,
    val willCreate: Int
)

/** 与店内消费器规则对齐的轻量预览（别名/色别/全名），给老板先看清单再确认。 */
private fun previewAutoLink(dishes: List<DishDto>, bom: List<RecipeDto>): AutoLinkPreview {
    val alias = mapOf(
        "红饺" to "SKU-WF-HONG", "黄饺" to "SKU-WF-HUANG", "绿饺" to "SKU-WF-LV",
        "紫饺" to "SKU-WF-ZI", "黑饺" to "SKU-WF-HEI",
        "墨云水饺" to "SKU-WF-HEI", "墨云饺" to "SKU-WF-HEI", "黑金饺" to "SKU-WF-HEI",
        "长寿饺" to "SKU-WF-HONG", "富贵饺" to "SKU-WF-HUANG",
        "康宁饺" to "SKU-WF-LV", "好德饺" to "SKU-WF-ZI",
        "酸菜饺" to "SKU-WF-BAI-SUANCAI", "牛肉饺" to "SKU-WF-BAI-NIUROU",
        "西葫芦饺" to "SKU-WF-BAI-XIHULU", "山药饺" to "SKU-WF-BAI-SHANYAO"
    )
    val nickColor = mapOf(
        "墨云" to "黑", "墨鱼" to "黑", "三鲜" to "黑", "黑金" to "黑",
        "翡翠" to "绿", "菠菜" to "绿", "玉米" to "绿", "康宁" to "绿",
        "长寿" to "红", "冬菇" to "红", "荸荠" to "红",
        "富贵" to "黄", "茴香" to "黄",
        "好德" to "紫", "香芹" to "紫"
    )
    val colorSku = bom.filter { it.color in setOf("红", "黄", "绿", "紫", "黑") }
        .associateBy { it.color!! }
    val bySku = bom.associateBy { it.skuId }
    val byName = bom.associateBy { it.name }
    val ambiguousNames = setOf("五福饺子", "全家福水饺", "水饺", "饺子")
    val will = mutableListOf<Pair<DishDto, RecipeDto>>()
    val manual = mutableListOf<DishDto>()
    var skipLinked = 0
    var skipOther = 0
    for (d in dishes) {
        if (!d.skuId.isNullOrBlank()) {
            skipLinked++
            continue
        }
        val name = d.name.trim()
        val isJiao = "饺" in name || d.cat in setOf("红", "黄", "绿", "紫", "黑", "白")
        if (name in ambiguousNames) {
            manual.add(d)
            continue
        }
        val hit: RecipeDto? = when {
            byName[name] != null -> byName[name]
            alias[name]?.let { bySku[it] } != null -> bySku[alias[name]]
            isJiao -> {
                val nick = nickColor.entries.firstOrNull { it.key in name }?.value
                if (nick != null) colorSku[nick] else null
            }
            else -> null
        }
        when {
            hit != null -> will.add(d to hit)
            isJiao -> manual.add(d)
            else -> skipOther++
        }
    }
    val used = dishes.mapNotNull { it.skuId }.toSet() + will.map { it.second.skuId }.toSet()
    val willCreate = bom.count { it.skuId !in used && dishes.none { d -> d.name == it.name } }
    return AutoLinkPreview(will, manual, skipLinked, skipOther, willCreate)
}

@Composable
private fun DishMenuRow(
    d: DishDto,
    linked: Boolean,
    recipeHint: String?,
    canWrite: Boolean,
    rev: String?,
    onLink: () -> Unit,
    onEdit: () -> Unit,
    onRefresh: () -> Unit
) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                "${d.name} · ${d.cat ?: "常规"}",
                fontWeight = FontWeight.Bold,
                fontSize = 14.sp
            )
            Text(
                "¥${d.price ?: 0}" +
                    (if (d.on == false) " · 已下架" else " · 在售") +
                    when {
                        linked && !recipeHint.isNullOrBlank() -> " · ✓$recipeHint"
                        linked -> " · ✓${d.skuId}"
                        else -> " · 未挂菜谱"
                    },
                color = if (linked) FiveGreen else Color(0xFFE8584A),
                fontSize = 11.sp
            )
        }
        if (canWrite) {
            Text(
                if (linked) "换挂" else "挂",
                color = FiveGreen,
                fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .clickable(onClick = onLink)
                    .padding(6.dp)
            )
            Text(
                "改价",
                color = FiveGreen,
                fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .clickable(onClick = onEdit)
                    .padding(6.dp)
            )
            Text(
                if (d.on == false) "上架" else "下架",
                color = if (d.on == false) FiveGreen else Color(0xFFE8584A),
                fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .clickable {
                        val on = d.on != false
                        ConfirmBus.ask(
                            ConfirmRequest(
                                title = if (on) "下架菜品" else "上架菜品",
                                summary = "${d.name} → ${if (on) "下架" else "上架"}",
                                type = "dish.set_active",
                                payload = buildJsonObject {
                                    put("id", d.id)
                                    put("name", d.name)
                                    put("on", !on)
                                },
                                baseRev = rev,
                                onResult = { r ->
                                    if (r.isSuccess) onRefresh()
                                }
                            )
                        )
                    }
                    .padding(6.dp)
            )
        }
    }
}

@Composable
private fun StoreEditDialog(
    initial: OrgStoreDto,
    onDismiss: () -> Unit,
    onSave: (name: String, brand: String, city: String, address: String, status: String) -> Unit
) {
    var name by remember { mutableStateOf(initial.name.orEmpty()) }
    var brand by remember { mutableStateOf(initial.brand.orEmpty()) }
    var city by remember { mutableStateOf(initial.city.orEmpty()) }
    var address by remember { mutableStateOf(initial.address.orEmpty()) }
    var status by remember { mutableStateOf(initial.status.orEmpty().ifBlank { "营业中" }) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("编辑门店资料", fontWeight = FontWeight.Bold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("门店名") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(value = brand, onValueChange = { brand = it }, label = { Text("品牌") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(value = city, onValueChange = { city = it }, label = { Text("城市") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(value = address, onValueChange = { address = it }, label = { Text("地址") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Text("状态", fontSize = 12.sp, color = Sub)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("营业中", "筹备中", "暂停").forEach { s ->
                        val on = status == s
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(12.dp))
                                .border(1.dp, if (on) Ink else Line, RoundedCornerShape(12.dp))
                                .clickable { status = s }
                                .padding(horizontal = 10.dp, vertical = 6.dp)
                        ) { Text(s, fontSize = 12.sp, fontWeight = FontWeight.Bold) }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                if (name.isBlank()) return@TextButton
                onSave(name.trim(), brand.trim(), city.trim(), address.trim(), status)
            }) { Text("保存") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}

@Composable
private fun TableEditDialog(
    initial: PosTableDto?,
    onDismiss: () -> Unit,
    onSave: (no: String, name: String, zone: String, seats: Int) -> Unit
) {
    var no by remember { mutableStateOf(initial?.no ?: "") }
    var name by remember { mutableStateOf(initial?.name ?: "") }
    var zone by remember { mutableStateOf(initial?.zone ?: "大厅") }
    var seats by remember { mutableStateOf((initial?.seats ?: 4).toString()) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (initial == null) "新增桌台" else "改桌台", fontWeight = FontWeight.Bold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(value = no, onValueChange = { no = it }, label = { Text("桌号") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("名称（可选）") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(value = seats, onValueChange = { seats = it }, label = { Text("座位数") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Text("区域", fontSize = 12.sp, color = Sub)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("大厅", "包间").forEach { z ->
                        val on = zone == z
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(12.dp))
                                .border(1.dp, if (on) Ink else Line, RoundedCornerShape(12.dp))
                                .clickable { zone = z }
                                .padding(horizontal = 10.dp, vertical = 6.dp)
                        ) { Text(z, fontSize = 12.sp, fontWeight = FontWeight.Bold) }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                val s = seats.toIntOrNull() ?: 4
                val n = no.ifBlank { initial?.no ?: "" }
                if (n.isBlank() && initial == null) return@TextButton
                onSave(n.ifBlank { initial?.id ?: "1" }, name, zone, s.coerceIn(1, 40))
            }) { Text("提交") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}

/** SI 门店配置体检：桌台/营业偏好/菜单挂菜谱覆盖率 */
@Composable
private fun ConfigHealthCard(
    tables: List<PosTableDto>,
    dishes: List<DishDto>,
    openHour: String,
    closeHour: String,
    defaultCat: String,
    flourSafe: String
) {
    val seats = tables.sumOf { it.seats ?: 0 }
    val byZone = tables.groupingBy { it.zone?.takeIf { z -> z.isNotBlank() } ?: "未分区" }.eachCount()
    val linked = dishes.count {
        !it.skuId.isNullOrBlank() || !it.recipeLink.isNullOrBlank() || !it.baobenId.isNullOrBlank()
    }
    val cov = if (dishes.isEmpty()) null else linked * 100 / dishes.size
    com.pandawufu.app.ui.designsystem.PandaCard {
        Text("SI · 门店配置体检", fontWeight = FontWeight.Bold, color = Ink)
        KvRow("桌台", "${tables.size} 张 · 座位 $seats · " + byZone.entries.joinToString(" ") { "${it.key}${it.value}" })
        KvRow("营业时段", "$openHour - $closeHour · 默认菜类 $defaultCat")
        KvRow("面粉安全线", flourSafe)
        KvRow("菜单挂菜谱", "${dishes.size} 道 · 已挂 $linked" + (cov?.let { "（覆盖 $it%）" } ?: ""))
        if (tables.isEmpty()) {
            Text("· 未配桌台：收银/预订无法开台", color = androidx.compose.ui.graphics.Color(0xFFE8584A), fontSize = 12.sp)
        }
        if (cov != null && cov < 80) {
            Text("· 菜谱覆盖率 ${cov}%：未挂菜谱的菜无法自动扣料/算成本", color = androidx.compose.ui.graphics.Color(0xFFE8584A), fontSize = 12.sp)
        }
    }
}
