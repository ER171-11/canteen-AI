package com.pandawufu.app.features.modules

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.AppModule
import com.pandawufu.app.ui.designsystem.DualSparkline
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.viewmodel.HomeViewModel
import com.pandawufu.shared.viewmodel.InventoryViewModel
import com.pandawufu.shared.viewmodel.KitchenViewModel
import com.pandawufu.shared.viewmodel.ModulesViewModel
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

@Composable
fun TakeoutScreen() {
    val viewModel = remember { ModulesViewModel(AppModule.modulesRepository) }
    val kitchenVm = remember {
        KitchenViewModel(
            kitchenRepository = AppModule.kitchenRepository,
            inventoryRepository = AppModule.inventoryRepository
        )
    }
    val state by viewModel.state.collectAsState()
    val kitchenState by kitchenVm.state.collectAsState()
    var tab by remember { mutableIntStateOf(ModuleEntry.consumePill(0)) }
    val pills = listOf("概览", "对账", "差评")
    LaunchedEffect(Unit) {
        AppModule.ensureSession()
        viewModel.dispatch(ModulesViewModel.Intent.LoadTakeout)
        kitchenVm.dispatch(KitchenViewModel.KitchenIntent.Refresh)
    }
    val t = state.takeout
    ModuleScaffold(
        title = "外卖",
        subtitle = when (tab) {
            0 -> "平台订单概览"
            1 -> "渠道对账"
            else -> "差评跟进"
        },
        loading = state.loading && t == null,
        error = state.error,
        hint = state.emptyHint,
        onRetry = { viewModel.dispatch(ModulesViewModel.Intent.LoadTakeout) },
        empty = false,
        pills = pills,
        selectedPill = tab,
        onPill = { tab = it }
    ) {
        when (tab) {
            0 -> {
                WriteActionButton(
                    label = "对账确认",
                    type = "takeout.ack",
                    summary = "确认今日外卖平台对账并计入售出",
                    payload = buildJsonObject {
                        val plat = t?.platforms?.firstOrNull()
                        put("platform", plat?.name ?: "美团")
                        put("status", "已对账")
                        put("note", "App 对账确认")
                        plat?.amount?.let { put("amount", it) }
                        plat?.orders?.let { put("qty", it) }
                        put("dish", (plat?.name ?: "美团") + "外卖")
                        put("channel", "外卖")
                    },
                    baseRev = t?.rev?.toString(),
                    onSuccess = { viewModel.dispatch(ModulesViewModel.Intent.LoadTakeout) }
                )
                val sug = kitchenState.demand?.suggestWorkorders?.firstOrNull()
                    ?: kitchenState.recipes.firstOrNull()?.let {
                        com.pandawufu.shared.model.DemandSuggestWoDto(
                            skuId = it.skuId,
                            name = it.name,
                            qty = ((t?.orders?.count { o ->
                                val st = o.status.orEmpty()
                                st.isNotBlank() && !Regex("完成|已送达|已取消|closed|done|cancel", RegexOption.IGNORE_CASE).containsMatchIn(st)
                            } ?: 1).coerceAtLeast(1) * 2),
                            reason = "按未完结外卖粗估"
                        )
                    }
                if (sug != null && AppModule.canWrite()) {
                    WriteActionButton(
                        label = "待做转工单（${sug.qty}份）",
                        type = "workorder.create",
                        summary = "外卖待做 → ${sug.name ?: sug.skuId} × ${sug.qty} 份工单草案",
                        payload = buildJsonObject {
                            put("sku_id", sug.skuId)
                            put("qty", sug.qty)
                            put("status", "待开始")
                            put("note", "外卖模块转工单")
                        },
                        baseRev = kitchenState.rev ?: t?.rev?.toString(),
                        onSuccess = {
                            kitchenVm.dispatch(
                                KitchenViewModel.KitchenIntent.AfterWorkorderQueued(sug.skuId, sug.qty)
                            )
                        }
                    )
                }
                if (t == null) return@ModuleScaffold
                if (t.platforms.isNotEmpty()) {
                    ModuleCard("平台汇总") {
                        t.platforms.forEach { p ->
                            KvRow(
                                p.name ?: "-",
                                listOfNotNull(
                                    p.orders?.let { "${it}单" },
                                    p.amount?.let { "¥$it" },
                                    p.rating?.let { "评分$it" }
                                ).joinToString(" · ")
                            )
                        }
                    }
                }
                if (t.orders.isNotEmpty()) {
                    ModuleCard("近期订单（${t.orders.size}）") {
                        t.orders.take(20).forEach { o ->
                            KvRow(
                                "${o.platform ?: "-"} ${o.platformNo ?: ""}",
                                listOfNotNull(o.amount?.let { "¥$it" }, o.status, o.ts).joinToString(" · ")
                            )
                            val oid = o.id
                            val st = o.status.orEmpty()
                            val open = oid != null && AppModule.canWrite() &&
                                !Regex("完成|已送达|已取消|closed|done|cancel|已确认|制作", RegexOption.IGNORE_CASE)
                                    .containsMatchIn(st)
                            if (open) {
                                WriteActionButton(
                                    label = "接单",
                                    type = "takeout.ack",
                                    summary = "外卖单 #${oid} ${o.platformNo ?: ""} → 已确认",
                                    payload = buildJsonObject {
                                        put("id", oid!!)
                                        put("order_id", oid)
                                        put("status", "已确认")
                                        put("platform", o.platform ?: "美团")
                                        o.amount?.let { put("amount", it) }
                                        put("note", "App 接单")
                                    },
                                    baseRev = t.rev?.toString(),
                                    onSuccess = { viewModel.dispatch(ModulesViewModel.Intent.LoadTakeout) }
                                )
                                WriteActionButton(
                                    label = "拒单",
                                    type = "takeout.ack",
                                    summary = "外卖单 #${oid} → 已取消",
                                    payload = buildJsonObject {
                                        put("id", oid!!)
                                        put("order_id", oid)
                                        put("status", "已取消")
                                        put("platform", o.platform ?: "美团")
                                        put("note", "App 拒单")
                                    },
                                    baseRev = t.rev?.toString(),
                                    onSuccess = { viewModel.dispatch(ModulesViewModel.Intent.LoadTakeout) }
                                )
                            }
                        }
                    }
                }
            }
            1 -> {
                WriteActionButton(
                    label = "对账确认",
                    type = "takeout.ack",
                    summary = "确认今日外卖平台对账",
                    payload = buildJsonObject {
                        put("platform", t?.platforms?.firstOrNull()?.name ?: "美团")
                        put("status", "已对账")
                    },
                    baseRev = t?.rev?.toString(),
                    onSuccess = { viewModel.dispatch(ModulesViewModel.Intent.LoadTakeout) }
                )
                ModuleCard("对账") {
                    val list = t?.reconcile.orEmpty()
                    if (list.isEmpty()) Text("暂无对账记录", style = MaterialTheme.typography.bodySmall)
                    list.forEach { r ->
                        KvRow(
                            "${r.platform} ${r.period}",
                            "应${r.expectAmt} / 实${r.actualAmt} · ${r.status}"
                        )
                    }
                }
            }
            else -> {
                val bad = t?.reviews.orEmpty().filter { (it.rating ?: 5.0) <= 3.0 || it.handled != 1 }
                ModuleCard("差评待回复（${bad.size}）") {
                    if (bad.isEmpty()) Text("暂无差评", style = MaterialTheme.typography.bodySmall)
                    bad.take(20).forEach { r ->
                        KvRow(
                            "${r.platform ?: "-"} ★${r.rating ?: "-"}",
                            "${if (r.handled == 1) "已处理" else "待回复"} · ${r.content?.take(28) ?: ""}"
                        )
                        if (r.handled != 1 && AppModule.canWrite()) {
                            WriteActionButton(
                                label = "回复差评",
                                type = "review.followup",
                                summary = "回复外卖差评：${r.content?.take(20) ?: r.id}",
                                payload = buildJsonObject {
                                    put("action", "外卖差评致歉回复")
                                    put("owner", AppModule.role ?: "老板")
                                    put("status", "已回复")
                                    put("platform", r.platform ?: "美团")
                                    r.id?.let { put("review_id", it) }
                                    put("reply", "非常抱歉给您带来不好体验，已安排店长跟进，诚邀到店赠五福饺一份。")
                                },
                                baseRev = t?.rev?.toString(),
                                onSuccess = { viewModel.dispatch(ModulesViewModel.Intent.LoadTakeout) }
                            )
                        }
                    }
                }
            }
        }
        Text("rev ${t?.rev ?: "-"}", style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
fun VipScreen() {
    val viewModel = remember { ModulesViewModel(AppModule.modulesRepository) }
    val state by viewModel.state.collectAsState()
    var tab by remember { mutableIntStateOf(ModuleEntry.consumePill(0)) }
    val pills = listOf("会员", "储值", "券", "生日", "到店")
    LaunchedEffect(Unit) {
        AppModule.ensureSession()
        viewModel.dispatch(ModulesViewModel.Intent.LoadVip)
    }
    val vip = state.vip
    val members = vip?.members.orEmpty()
    val coupons = vip?.coupons.orEmpty()
    val visits = vip?.visits.orEmpty()
    val birthday = members.filter { it.birthdaySoon == true }
    val stored = members.filter { (it.balance ?: 0.0) > 0 || (it.level?.contains("储") == true) }
    val inStore = members.filter { (it.status ?: "").contains("在店") }
    val totalBal = members.sumOf { it.balance ?: 0.0 }
    ModuleScaffold(
        title = "会员",
        subtitle = when (tab) {
            0 -> "人数与余额总览 · 在店 ${inStore.size}"
            1 -> "储值会员"
            2 -> "优惠券核销"
            3 -> "生日临近发券"
            else -> "到店识别 ${visits.size}"
        },
        loading = state.loading && vip == null,
        error = state.error,
        hint = state.emptyHint,
        onRetry = { viewModel.dispatch(ModulesViewModel.Intent.LoadVip) },
        empty = false,
        pills = pills,
        selectedPill = tab,
        onPill = { tab = it }
    ) {
        when (tab) {
            0 -> {
                ModuleCard("会员资产") {
                    KvRow("会员资产总额", "¥${"%.0f".format(totalBal)}")
                    KvRow("会员数", "${members.size} · 储值 ${stored.size}")
                    KvRow("本周生日待发券", "${birthday.size} 人")
                }
                ModuleCard("会员列表（${members.size}）") {
                    if (members.isEmpty()) Text("暂无会员推送", style = MaterialTheme.typography.bodySmall)
                    members.take(30).forEach { m ->
                        KvRow(
                            "${m.name ?: m.memberId} · ${m.level ?: ""}",
                            "余额 ¥${m.balance ?: 0} · ${m.status ?: ""}"
                        )
                    }
                }
            }
            1 -> ModuleCard("储值余额（${stored.size}）") {
                if (stored.isEmpty()) Text("暂无储值会员", style = MaterialTheme.typography.bodySmall)
                stored.take(30).forEach { m ->
                    KvRow(
                        "${m.name ?: m.memberId}",
                        "¥${m.balance ?: 0} · ${m.level ?: "储值卡"}"
                    )
                }
            }
            2 -> {
                DraftWriteButton(
                    label = "创建活动草案",
                    type = "vip.campaign",
                    fields = mapOf(
                        "类型" to "满减",
                        "面额" to "20",
                        "券码" to "APP${System.currentTimeMillis() % 100000}"
                    ),
                    summaryOf = { d -> "${d["类型"]}券 ¥${d["面额"]} · ${d["券码"]}" },
                    buildPayload = { d ->
                        buildJsonObject {
                            put("campaign_type", d["类型"] ?: "满减")
                            put("value", d["面额"]?.toIntOrNull() ?: 20)
                            put("code", d["券码"] ?: "APP")
                        }
                    },
                    baseRev = vip?.rev?.toString(),
                    onSuccess = { viewModel.dispatch(ModulesViewModel.Intent.LoadVip) }
                )
                val redeem = coupons.firstOrNull { (it.status ?: "").contains("未") || (it.status ?: "") == "unused" }
                    ?: coupons.firstOrNull()
                if (redeem != null) {
                    WriteActionButton(
                        label = "核销券 ${redeem.code ?: ""}",
                        type = "vip.coupon_redeem",
                        summary = "核销 ${redeem.code} · ${redeem.type} ¥${redeem.value}",
                        payload = buildJsonObject {
                            put("code", redeem.code ?: "")
                            put("type", redeem.type)
                            put("value", redeem.value ?: 0)
                        },
                        baseRev = vip?.rev?.toString(),
                        onSuccess = { viewModel.dispatch(ModulesViewModel.Intent.LoadVip) }
                    )
                }
                ModuleCard("券/活动（${coupons.size}）") {
                    if (coupons.isEmpty()) Text("暂无券活动", style = MaterialTheme.typography.bodySmall)
                    coupons.take(20).forEach { c ->
                        KvRow(c.code ?: "-", "${c.type} ¥${c.value} · ${c.status}")
                    }
                }
            }
            3 -> {
                ModuleCard("本周生日会员（${birthday.size}）") {
                    if (birthday.isEmpty()) Text("本周暂无生日会员", style = MaterialTheme.typography.bodySmall)
                    birthday.take(20).forEach { m ->
                        KvRow(
                            "${m.name ?: m.memberId} · ${m.level ?: "会员"}",
                            listOfNotNull(m.birthday, m.phone?.let { "电话 $it" }).joinToString(" · ").ifBlank { "待发券" }
                        )
                        DraftWriteButton(
                            label = "发券",
                            type = "vip.campaign",
                            fields = mapOf(
                                "类型" to "生日赠",
                                "面额" to if ((m.balance ?: 0.0) > 0) "长寿红饺+8折" else "8折",
                                "券码" to "BD${(m.memberId ?: "X").takeLast(4)}${System.currentTimeMillis() % 10000}",
                                "会员" to (m.name ?: m.memberId ?: "")
                            ),
                            summaryOf = { d -> "生日发券 ${d["会员"]} · ${d["面额"]} · ${d["券码"]}" },
                            buildPayload = { d ->
                                buildJsonObject {
                                    put("campaign_type", "生日赠")
                                    put("type", "生日赠")
                                    val gift = d["面额"] ?: "8折券"
                                    put("gift", gift)
                                    put("value", gift.filter { it.isDigit() }.toIntOrNull() ?: 0)
                                    put("code", d["券码"] ?: "BD")
                                    put("member_id", m.memberId ?: "")
                                    put("member_name", m.name ?: "")
                                    put("note", "生日发券·$gift")
                                }
                            },
                            baseRev = vip?.rev?.toString(),
                            onSuccess = { viewModel.dispatch(ModulesViewModel.Intent.LoadVip) }
                        )
                    }
                }
                Text("建议：储值会员赠「长寿红饺一份」+ 8 折券；普通会员赠 8 折券。", style = MaterialTheme.typography.bodySmall)
            }
            else -> {
                DraftWriteButton(
                    label = "登记到店",
                    type = "vip.checkin",
                    fields = mapOf(
                        "姓名" to (members.firstOrNull()?.name ?: "散客会员"),
                        "电话" to (members.firstOrNull()?.phone ?: ""),
                        "会员号" to (members.firstOrNull()?.memberId ?: ""),
                        "桌台" to "",
                        "备注" to "前台到店识别"
                    ),
                    summaryOf = { d ->
                        "到店 ${d["姓名"]} · ${d["桌台"].orEmpty().ifBlank { "未挂桌" }}"
                    },
                    buildPayload = { d ->
                        buildJsonObject {
                            put("name", d["姓名"] ?: "散客会员")
                            val phone = d["电话"].orEmpty().trim()
                            if (phone.isNotBlank()) put("phone", phone)
                            val mid = d["会员号"].orEmpty().trim()
                            if (mid.isNotBlank()) put("member_id", mid)
                            val tid = d["桌台"].orEmpty().trim()
                            if (tid.isNotBlank()) put("table_id", tid)
                            put("note", d["备注"] ?: "到店识别")
                        }
                    },
                    baseRev = vip?.rev?.toString(),
                    onSuccess = { viewModel.dispatch(ModulesViewModel.Intent.LoadVip) }
                )
                ModuleCard("在店会员（${inStore.size}）") {
                    if (inStore.isEmpty()) Text("当前无「在店」状态 · 点上方登记", color = Sub, fontSize = 12.sp)
                    inStore.take(15).forEach { m ->
                        KvRow(
                            "${m.name ?: m.memberId}",
                            listOfNotNull(m.level, m.phone, m.status).joinToString(" · ")
                        )
                        WriteActionButton(
                            label = "再记一笔到店",
                            type = "vip.checkin",
                            summary = "到店 ${m.name ?: m.memberId}",
                            payload = buildJsonObject {
                                put("member_id", m.memberId ?: "")
                                put("name", m.name ?: "")
                                put("phone", m.phone ?: "")
                                put("note", "再次到店")
                            },
                            baseRev = vip?.rev?.toString(),
                            onSuccess = { viewModel.dispatch(ModulesViewModel.Intent.LoadVip) }
                        )
                    }
                }
                ModuleCard("到店台账（${visits.size}）") {
                    if (visits.isEmpty()) Text("尚无到店记录", color = Sub, fontSize = 12.sp)
                    visits.asReversed().take(20).forEach { v ->
                        KvRow(
                            "${v.name ?: v.memberId ?: "-"}" +
                                (v.tableId?.let { " · 桌$it" } ?: ""),
                            listOfNotNull(v.ts?.takeLast(8), v.note).joinToString(" · ").ifBlank { "-" }
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun FinanceScreen() {
    val viewModel = remember { ModulesViewModel(AppModule.modulesRepository) }
    val homeVm = remember {
        HomeViewModel(AppModule.healthRepository, AppModule.reportRepository)
    }
    val state by viewModel.state.collectAsState()
    val home by homeVm.state.collectAsState()
    var tab by remember { mutableIntStateOf(0) }
    val pills = listOf("对账", "发票", "税务", "现金流", "分账")
    LaunchedEffect(Unit) {
        AppModule.ensureSession()
        viewModel.dispatch(ModulesViewModel.Intent.LoadFinance)
        homeVm.dispatch(HomeViewModel.HomeIntent.Refresh)
    }
    val fin = state.finance
    val recon = fin?.recon
    ModuleScaffold(
        title = "财务",
        subtitle = when (tab) {
            0 -> "堂食/外卖收银 vs 采购入库"
            1 -> "发票台账"
            2 -> "税务周期"
            3 -> "现金流水"
            else -> "分账冻结与结算"
        },
        loading = state.loading && fin == null && home.report == null,
        error = state.error,
        hint = state.emptyHint,
        onRetry = { viewModel.dispatch(ModulesViewModel.Intent.LoadFinance) },
        empty = false,
        pills = pills,
        selectedPill = tab,
        onPill = { tab = it }
    ) {
        when (tab) {
            0 -> {
                ModuleCard("今日三方勾兑 · ${recon?.date ?: "-"}") {
                    val dine = recon?.dineIn
                    val take = recon?.takeout
                    val pur = recon?.purchase
                    KvRow(
                        "堂食收银",
                        "¥${"%.2f".format(dine?.amount ?: 0.0)} · ${dine?.count ?: 0} 笔"
                    )
                    KvRow(
                        "外卖收银",
                        "¥${"%.2f".format(take?.amount ?: 0.0)} · ${take?.count ?: 0} 笔"
                    )
                    KvRow(
                        "采购入库",
                        "¥${"%.2f".format(pur?.amount ?: 0.0)} · ${pur?.count ?: 0} 单"
                    )
                    val gap = recon?.gap ?: 0.0
                    KvRow(
                        "收银−采购",
                        "¥${"%.2f".format(gap)}" + if (recon?.confirmed == true) " · 已确认" else " · 待确认"
                    )
                }
                // 今日无数据时，展示最近一次已结算，避免空屏、让老板有参照
                val last = recon?.last
                val todayEmpty = (recon?.dineIn?.amount ?: 0.0) == 0.0 &&
                    (recon?.takeout?.amount ?: 0.0) == 0.0 &&
                    (recon?.purchase?.amount ?: 0.0) == 0.0
                if (last != null && todayEmpty) {
                    ModuleCard("最近一次结算 · ${last.date ?: "-"}") {
                        KvRow("堂食收银", "¥${"%.2f".format(last.dineIn?.amount ?: 0.0)} · ${last.dineIn?.count ?: 0} 笔")
                        KvRow("外卖收银", "¥${"%.2f".format(last.takeout?.amount ?: 0.0)} · ${last.takeout?.count ?: 0} 笔")
                        KvRow("采购入库", "¥${"%.2f".format(last.purchase?.amount ?: 0.0)} · ${last.purchase?.count ?: 0} 单")
                        KvRow("收银−采购", "¥${"%.2f".format(last.gap ?: 0.0)}")
                        if (!last.note.isNullOrBlank()) {
                            Text("备注：${last.note}", fontSize = 11.sp, color = Sub)
                        }
                    }
                }
                DraftWriteButton(
                    label = if (recon?.confirmed == true) "再次确认勾兑" else "确认三方勾兑落账",
                    type = "finance.recon",
                    fields = mapOf(
                        "日期" to (recon?.date ?: ""),
                        "堂食" to (recon?.dineIn?.amount?.toString() ?: "0"),
                        "外卖" to (recon?.takeout?.amount?.toString() ?: "0"),
                        "采购" to (recon?.purchase?.amount?.toString() ?: "0"),
                        "备注" to "老板确认三方勾兑"
                    ),
                    summaryOf = { d ->
                        "勾兑 ${d["日期"]} 堂食¥${d["堂食"]} 外卖¥${d["外卖"]} 采购¥${d["采购"]}"
                    },
                    buildPayload = { d ->
                        buildJsonObject {
                            put("date", d["日期"] ?: (recon?.date ?: ""))
                            put("dine_in", d["堂食"]?.toDoubleOrNull() ?: (recon?.dineIn?.amount ?: 0.0))
                            put("takeout", d["外卖"]?.toDoubleOrNull() ?: (recon?.takeout?.amount ?: 0.0))
                            put("purchase", d["采购"]?.toDoubleOrNull() ?: (recon?.purchase?.amount ?: 0.0))
                            put("note", d["备注"] ?: "老板确认三方勾兑")
                        }
                    },
                    baseRev = fin?.rev?.toString(),
                    onSuccess = { viewModel.dispatch(ModulesViewModel.Intent.LoadFinance) }
                )
            }
            1 -> ModuleCard("发票（${fin?.invoices?.size ?: 0}）") {
                val list = fin?.invoices.orEmpty()
                if (list.isEmpty()) Text("暂无发票", style = MaterialTheme.typography.bodySmall)
                list.take(20).forEach { i ->
                    KvRow(i.kind ?: "发票", "¥${i.amount} · ${i.status}")
                }
            }
            2 -> ModuleCard("税务（${fin?.tax?.size ?: 0}）") {
                val list = fin?.tax.orEmpty()
                if (list.isEmpty()) {
                    home.report?.let { report ->
                        Text(report.banner ?: "经营日报参考", style = MaterialTheme.typography.bodySmall)
                        report.kpi.take(4).forEach { k ->
                            KvRow(k.label, listOfNotNull(k.value, k.delta).joinToString(" "))
                        }
                    } ?: Text("暂无税务记录", style = MaterialTheme.typography.bodySmall)
                } else {
                    list.take(20).forEach { i ->
                        KvRow(i.kind ?: "税", "¥${i.amount} · ${i.status} · ${i.period ?: ""}")
                    }
                }
            }
            3 -> ModuleCard("现金流（${fin?.cash?.size ?: 0}）") {
                val list = fin?.cash.orEmpty()
                if (list.isEmpty()) Text("暂无现金流水", style = MaterialTheme.typography.bodySmall)
                list.take(20).forEach { c ->
                    KvRow(c.kind ?: "-", "¥${c.amount} · ${c.ts ?: c.note ?: ""}")
                }
            }
            else -> {
                DraftWriteButton(
                    label = "冻结分账",
                    type = "finance.freeze",
                    fields = mapOf(
                        "分账方" to (fin?.split?.firstOrNull()?.party ?: "合伙人"),
                        "金额" to (fin?.split?.firstOrNull()?.amount?.toString() ?: "5000"),
                        "比例" to (fin?.split?.firstOrNull()?.ratio?.toString() ?: "0.3"),
                        "冻结至" to (fin?.split?.firstOrNull()?.frozenUntil ?: "2099-12-31")
                    ),
                    summaryOf = { d -> "冻结 ${d["分账方"]} ¥${d["金额"]} 至 ${d["冻结至"]}" },
                    buildPayload = { d ->
                        buildJsonObject {
                            put("party", d["分账方"] ?: "合伙人")
                            put("amount", d["金额"]?.toDoubleOrNull() ?: 5000.0)
                            put("ratio", d["比例"]?.toDoubleOrNull() ?: 0.3)
                            put("frozen_until", d["冻结至"] ?: "2099-12-31")
                        }
                    },
                    baseRev = fin?.rev?.toString(),
                    onSuccess = { viewModel.dispatch(ModulesViewModel.Intent.LoadFinance) }
                )
                DraftWriteButton(
                    label = "批准解冻结算",
                    type = "finance.approve",
                    fields = mapOf(
                        "分账方" to (fin?.split?.firstOrNull()?.party ?: "合伙人"),
                        "金额" to (fin?.split?.firstOrNull()?.amount?.toString() ?: "5000"),
                        "状态" to "已结算"
                    ),
                    summaryOf = { d -> "批准 ${d["分账方"]} ¥${d["金额"]} → ${d["状态"]}" },
                    buildPayload = { d ->
                        buildJsonObject {
                            put("party", d["分账方"] ?: "合伙人")
                            put("amount", d["金额"]?.toDoubleOrNull() ?: 5000.0)
                            put("status", d["状态"] ?: "已结算")
                            fin?.split?.firstOrNull()?.id?.let { put("id", it) }
                        }
                    },
                    baseRev = fin?.rev?.toString(),
                    onSuccess = { viewModel.dispatch(ModulesViewModel.Intent.LoadFinance) }
                )
                ModuleCard("分账（${fin?.split?.size ?: 0}）") {
                    val list = fin?.split.orEmpty()
                    if (list.isEmpty()) Text("暂无分账", style = MaterialTheme.typography.bodySmall)
                    list.forEach { s ->
                        KvRow(
                            "${s.party} ${s.period}",
                            "¥${s.amount} · ${s.status} · 冻至${s.frozenUntil ?: "-"}"
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun LossScreen() {
    val viewModel = remember { ModulesViewModel(AppModule.modulesRepository) }
    val invVm = remember { InventoryViewModel(AppModule.inventoryRepository) }
    val state by viewModel.state.collectAsState()
    val inv by invVm.state.collectAsState()
    var tab by remember { mutableIntStateOf(0) }
    val pills = listOf("分析", "报损", "盘点差")
    LaunchedEffect(Unit) {
        AppModule.ensureSession()
        viewModel.dispatch(ModulesViewModel.Intent.LoadLoss)
        invVm.dispatch(InventoryViewModel.InventoryIntent.Refresh)
    }
    val loss = state.loss
    val reports = loss?.reports.orEmpty()
    val first = inv.restock.firstOrNull()
    val reasonGroups = reports.groupBy { it.reason?.ifBlank { null } ?: "未分类" }
        .map { (k, v) -> k to v.sumOf { it.qty ?: 0.0 } }
        .sortedByDescending { it.second }
    ModuleScaffold(
        title = "损耗",
        subtitle = when (tab) {
            0 -> "按原因汇总"
            1 -> "报损单 · 确认台落库"
            else -> "盘点与账面差异"
        },
        loading = state.loading && loss == null,
        error = state.error,
        hint = state.emptyHint,
        onRetry = { viewModel.dispatch(ModulesViewModel.Intent.LoadLoss) },
        empty = false,
        pills = pills,
        selectedPill = tab,
        onPill = { tab = it }
    ) {
        when (tab) {
            0 -> {
                ModuleCard("损耗分析 · 按原因汇总") {
                    val nonZero = reasonGroups.filter { it.second > 0.0 }
                    if (nonZero.isEmpty()) Text("暂无报损记录可分析", color = Sub, fontSize = 12.sp)
                    else nonZero.take(12).forEach { (reason, qty) ->
                        KvRow(reason, "合计 ${"%.1f".format(qty)}")
                    }
                }
                ModuleCard("近期报损趋势") {
                    reports.take(10).forEach { r ->
                        KvRow("${r.date ?: "-"} ${r.ingName ?: "-"}", "${r.qty ?: "-"} · ${r.reason ?: ""}")
                    }
                    if (reports.isEmpty()) Text("推送 loss_reports 后可见", color = Sub, fontSize = 12.sp)
                }
            }
            1 -> {
                DraftWriteButton(
                    label = "提交报损单",
                    type = "loss.report",
                    fields = mapOf(
                        "原料" to (first?.name ?: "原料损耗"),
                        "数量" to (first?.suggestQty?.toString() ?: "1"),
                        "金额" to "100",
                        "原因" to "操作失误"
                    ),
                    summaryOf = { d -> "报损 ${d["原料"]} × ${d["数量"]} · ¥${d["金额"]}" },
                    buildPayload = { d ->
                        buildJsonObject {
                            put("name", d["原料"] ?: "原料损耗")
                            put("ing_name", d["原料"] ?: "原料损耗")
                            put("qty", d["数量"]?.toDoubleOrNull() ?: 1.0)
                            put("amount", d["金额"]?.toDoubleOrNull() ?: 100.0)
                            put("reason", d["原因"] ?: "操作失误")
                            put("reporter", AppModule.account ?: AppModule.role ?: "老板")
                        }
                    },
                    baseRev = loss?.rev?.toString() ?: inv.rev,
                    onSuccess = {
                        viewModel.dispatch(ModulesViewModel.Intent.LoadLoss)
                        invVm.dispatch(InventoryViewModel.InventoryIntent.Refresh)
                    }
                )
                ModuleCard("报损单（${reports.size}）") {
                    if (reports.isEmpty()) Text("暂无报损单", color = Sub, fontSize = 12.sp)
                    reports.take(30).forEach { r ->
                        KvRow(
                            "${r.date ?: "-"} ${r.ingName ?: "-"}",
                            "${r.qty ?: "-"} · ${r.reason ?: ""} · ${r.status ?: ""}"
                        )
                    }
                }
            }
            else -> {
                ModuleCard("盘点差异 · 低于安全线") {
                    if (inv.restock.isEmpty()) KvRow("状态", "暂无低于安全线原料")
                    else inv.restock.take(20).forEach { r ->
                        KvRow(r.name, "账面偏低 · 建议补 ${r.suggestQty}${r.unit}")
                    }
                }
                Text(
                    "差异确认后请走补货或报损，勿直改库存。",
                    color = Sub,
                    fontSize = 12.sp
                )
            }
        }
    }
}

@Composable
fun EquipmentScreen() {
    val viewModel = remember { ModulesViewModel(AppModule.modulesRepository) }
    val state by viewModel.state.collectAsState()
    var tab by remember { mutableIntStateOf(ModuleEntry.consumePill(0)) }
    val pills = listOf("温度", "能耗", "维保")
    LaunchedEffect(Unit) {
        AppModule.ensureSession()
        viewModel.dispatch(ModulesViewModel.Intent.LoadEquipment)
    }
    val eq = state.equipment
    val temps = eq?.temps.orEmpty()
    val over = temps.filter { it.status == "over" }
    ModuleScaffold(
        title = "设备",
        subtitle = when {
            eq?.mockTemps == true -> "演示温度 · 可接真 IoT"
            tab == 0 -> if (over.isNotEmpty()) "超温 ${over.size} 台 · 立即核查" else "冷柜温度"
            tab == 1 -> "用电能耗"
            else -> "维保计划"
        },
        loading = state.loading && eq == null,
        error = state.error,
        hint = state.emptyHint,
        onRetry = { viewModel.dispatch(ModulesViewModel.Intent.LoadEquipment) },
        empty = false,
        pills = pills,
        selectedPill = tab,
        onPill = { tab = it }
    ) {
        when (tab) {
            0 -> {
                ModuleCard("冷柜温度 · 实时") {
                    if (temps.isEmpty()) Text("暂无温度传感器", style = MaterialTheme.typography.bodySmall)
                    temps.forEach { t ->
                        val overFlag = t.status == "over"
                        KvRow(
                            "${t.device ?: "-"} (${t.kind ?: "-"})",
                            if (overFlag) "${t.temp}℃ · 超温" else "${t.temp}℃"
                        )
                    }
                }
                over.forEach { t ->
                    ModuleCard("${t.device} 温度曲线") {
                        val series = t.history.map { it.toFloat() }.ifEmpty {
                            listOf(4f, 4.2f, 4.5f, 5.1f, 5.8f, 6.4f, 6.9f, 7.1f, (t.temp ?: 7.2).toFloat())
                        }
                        DualSparkline(series, color = FiveRed)
                        Text(
                            "超温上升 · 已 ${t.minutes ?: 0} 分钟 · 应 ≤${t.max}℃",
                            color = FiveRed,
                            fontSize = 12.sp
                        )
                        DraftWriteButton(
                            label = "登记超温核查",
                            type = "equipment.maintain",
                            fields = mapOf(
                                "设备" to (t.device ?: "冷柜 B"),
                                "类型" to "超温核查",
                                "备注" to "当前 ${t.temp}℃ · 限 ${t.max}℃"
                            ),
                            summaryOf = { d -> "${d["设备"]} · ${d["类型"]}" },
                            buildPayload = { d ->
                                buildJsonObject {
                                    put("device", d["设备"] ?: "冷柜 B")
                                    put("kind", d["类型"] ?: "超温核查")
                                    put("operator", AppModule.account ?: "老板")
                                    put("note", d["备注"] ?: "")
                                }
                            },
                            baseRev = eq?.rev?.toString(),
                            onSuccess = { viewModel.dispatch(ModulesViewModel.Intent.LoadEquipment) }
                        )
                    }
                }
            }
            1 -> {
                val sum = eq?.energySummary
                ModuleCard(if (sum?.mock == true) "本月能耗费用（演示）" else "本月能耗费用") {
                    if (sum == null || sum.items.isEmpty()) {
                        Text("暂无能耗汇总", style = MaterialTheme.typography.bodySmall)
                    } else {
                        sum.items.forEach { row ->
                            EnergyBarRow(row.kind ?: "-", row.amount ?: 0.0, (row.pct ?: 50).coerceIn(8, 100) / 100f)
                        }
                        KvRow("合计", "¥${sum.total?.toInt() ?: "-"}")
                        sum.yoy?.let { KvRow("能耗费用同比", it) }
                        sum.mom?.let { KvRow("能耗费用环比", it) }
                        sum.ratio?.let { KvRow("营收能耗比", "$it · 行业 5.5%") }
                    }
                }
                ModuleCard("能耗明细（${eq?.energy?.size ?: 0}）") {
                    val list = eq?.energy.orEmpty()
                    if (list.isEmpty()) Text("暂无能耗明细", style = MaterialTheme.typography.bodySmall)
                    list.take(20).forEach { e ->
                        KvRow("${e.device} ${e.kind}", "${e.usageText()} · ${e.date}")
                    }
                }
            }
            else -> {
                DraftWriteButton(
                    label = "登记维保 / 报修",
                    type = "equipment.maintain",
                    fields = mapOf(
                        "设备" to (over.firstOrNull()?.device
                            ?: eq?.maintain?.firstOrNull()?.device
                            ?: eq?.energy?.firstOrNull()?.device
                            ?: "冷藏柜-1"),
                        "类型" to if (over.isNotEmpty()) "超温核查" else "巡检",
                        "备注" to "App 维保登记"
                    ),
                    summaryOf = { d -> "${d["设备"]} · ${d["类型"]}" },
                    buildPayload = { d ->
                        buildJsonObject {
                            put("device", d["设备"] ?: "冷藏柜-1")
                            put("kind", d["类型"] ?: "巡检")
                            put("operator", d["操作人"] ?: (AppModule.account ?: "老板"))
                            put("note", d["备注"] ?: "")
                        }
                    },
                    baseRev = eq?.rev?.toString(),
                    onSuccess = { viewModel.dispatch(ModulesViewModel.Intent.LoadEquipment) }
                )
                ModuleCard("设备维保到期") {
                    val list = eq?.maintain.orEmpty()
                    if (list.isEmpty()) {
                        Text("中央空调 · 滤网建议 30 天周期（演示提示）", color = Sub, fontSize = 12.sp)
                        Text("推送 eq_maintain 后显示真实维保台账。", color = Sub, fontSize = 11.sp)
                    } else {
                        list.take(20).forEach { m ->
                            KvRow("${m.device} · ${m.kind}", "${m.operator} · ${m.ts}")
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun EnergyBarRow(label: String, amount: Double, pct: Float) {
    Column(Modifier.padding(vertical = 4.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(label, fontSize = 12.sp, color = Sub)
            Text("¥${amount.toInt()}", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = Ink)
        }
        Box(
            Modifier
                .fillMaxWidth()
                .height(8.dp)
                .clip(RoundedCornerShape(4.dp))
                .background(Color(0xFFF1F2F5))
        ) {
            Box(
                Modifier
                    .fillMaxWidth(pct.coerceIn(0.08f, 1f))
                    .height(8.dp)
                    .clip(RoundedCornerShape(4.dp))
                    .background(
                        when (label) {
                            "燃气" -> Color(0xFFF2B233)
                            "水" -> Color(0xFF87CEEB)
                            else -> Color(0xFFF48FB1)
                        }
                    )
            )
        }
    }
}

@Composable
fun ReviewScreen() {
    val viewModel = remember { ModulesViewModel(AppModule.modulesRepository) }
    val state by viewModel.state.collectAsState()
    var tab by remember { mutableIntStateOf(ModuleEntry.consumePill(0).coerceIn(0, 2)) }
    val pills = listOf("评分", "差评", "好评")
    LaunchedEffect(Unit) {
        AppModule.ensureSession()
        viewModel.dispatch(ModulesViewModel.Intent.LoadReview)
    }
    val rev = state.review
    val reviews = rev?.reviews.orEmpty()
    val bad = reviews.filter { (it.rating ?: 5.0) <= 3.0 || it.handled != 1 }
    val good = reviews.filter { (it.rating ?: 0.0) >= 4.5 }
    val avg = if (reviews.isEmpty()) null else reviews.mapNotNull { it.rating }.average()
    ModuleScaffold(
        title = "口碑",
        subtitle = when (tab) {
            0 -> avg?.let { "均分 ${"%.1f".format(it)} · ${reviews.size} 条" } ?: "评分总览"
            1 -> "差评 ${bad.size} · 待跟进"
            else -> "好评语录可转发"
        },
        loading = state.loading && rev == null,
        error = state.error,
        hint = state.emptyHint,
        onRetry = { viewModel.dispatch(ModulesViewModel.Intent.LoadReview) },
        empty = false,
        pills = pills,
        selectedPill = tab,
        onPill = { tab = it }
    ) {
        when (tab) {
            0 -> {
                ModuleCard("评分概览") {
                    KvRow("评价条数", "${reviews.size}")
                    KvRow("均分", avg?.let { "%.1f".format(it) } ?: "-")
                    KvRow("待跟进", "${bad.count { it.handled != 1 }}")
                }
                if (reviews.isNotEmpty()) {
                    ModuleCard("最近评价") {
                        reviews.take(20).forEach { r ->
                            KvRow(
                                "${r.source} ★${r.rating}",
                                "${if (r.handled == 1) "已处理" else "待跟进"} · ${r.content?.take(28) ?: ""}"
                            )
                        }
                    }
                } else {
                    Text("暂无评价推送", style = MaterialTheme.typography.bodySmall)
                }
            }
            1 -> {
                DraftWriteButton(
                    label = "当场客诉登记",
                    type = "review.followup",
                    fields = mapOf(
                        "桌台" to "",
                        "内容" to "口味/服务/出餐慢",
                        "处理" to "店长当场致歉",
                        "来源" to "堂食当场"
                    ),
                    summaryOf = { d ->
                        "客诉 ${d["桌台"].orEmpty().ifBlank { "未挂桌" }} · ${d["内容"]}"
                    },
                    buildPayload = { d ->
                        buildJsonObject {
                            put("source", d["来源"] ?: "堂食当场")
                            put("content", d["内容"] ?: "堂食客诉")
                            put("action", d["处理"] ?: "店长当场致歉")
                            put("owner", AppModule.role ?: "老板")
                            put("status", "待处理")
                            put("rating", 2.0)
                            val tid = d["桌台"].orEmpty().trim()
                            if (tid.isNotBlank()) put("table_id", tid)
                            put("note", "当场客诉")
                        }
                    },
                    baseRev = rev?.rev?.toString(),
                    onSuccess = { viewModel.dispatch(ModulesViewModel.Intent.LoadReview) }
                )
                WriteActionButton(
                    label = "差评跟进",
                    type = "review.followup",
                    summary = "创建差评跟进单",
                    payload = buildJsonObject {
                        put("action", "电话回访致歉")
                        put("owner", AppModule.role ?: "老板")
                        put("status", "进行中")
                        bad.firstOrNull()?.id?.let { put("review_id", it) }
                    },
                    baseRev = rev?.rev?.toString(),
                    onSuccess = { viewModel.dispatch(ModulesViewModel.Intent.LoadReview) }
                )
                ModuleCard("差评待改进（${bad.size}）") {
                    if (bad.isEmpty()) Text("暂无差评", color = Sub, fontSize = 12.sp)
                    bad.take(20).forEach { r ->
                        KvRow("★${r.rating} ${r.source}", r.content?.take(36) ?: "-")
                    }
                }
                if (rev?.improve?.isNotEmpty() == true) {
                    ModuleCard("改进单") {
                        rev.improve.take(20).forEach { i ->
                            KvRow(i.action ?: "-", "${i.owner} · ${i.status}")
                        }
                    }
                }
            }
            else -> {
                ModuleCard("好评语录") {
                    if (good.isEmpty()) Text("暂无高分好评", color = Sub, fontSize = 12.sp)
                    good.take(20).forEach { r ->
                        KvRow("★${r.rating}", r.content?.take(48) ?: "(无正文)")
                    }
                }
            }
        }
    }
}
