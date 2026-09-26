package com.pandawufu.app.features.kitchen

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pandawufu.app.AppModule
import com.pandawufu.app.confirm.ConfirmBus
import com.pandawufu.app.confirm.ConfirmRequest
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.shared.model.WorkorderDto
import com.pandawufu.shared.viewmodel.KitchenViewModel
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** 工单 = 后厨第1步：本餐需求 → 建单 → 三态推进（完成扣 BOM） */
@Composable
fun WorkordersTab(
    state: KitchenViewModel.KitchenState,
    viewModel: KitchenViewModel,
    onGoRecipes: () -> Unit = {},
    onGoBoard: () -> Unit = {}
) {
    val context = LocalContext.current
    if (state.loading && state.workorders.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        return
    }
    val mealClock = resolveMealClock(state.workorders)
    val demand = state.demand
    LazyColumn(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        "${mealClock.format(DateTimeFormatter.ofPattern("HH:mm"))} 开餐 · 工单推进",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.ExtraBold
                    )
                    Text(
                        if (state.workorders.isEmpty()) "今日暂无工单 · 按菜谱标准建单，或去「菜谱」看标准后转工单"
                        else "今日 ${state.workorders.size} SKU · 按菜谱 SOP 推进：待开始→制作中→待传→已完成",
                        style = MaterialTheme.typography.bodySmall,
                        color = SubC
                    )
                    if (demand != null) {
                        Text(
                            "本餐建议 ${demand.suggestPortions} 个（预订 ${demand.bookingHeads}人 / 外卖待做 ${demand.takeoutOpen}）· 已建 ${demand.workorderPlanned} · 缺口 ${demand.gap}",
                            style = MaterialTheme.typography.bodySmall,
                            color = if (demand.gap > 0) FiveRedC else FiveGreenC
                        )
                        val sug = demand.suggestWorkorders.firstOrNull()
                        if (sug != null && demand.gap > 0 && AppModule.canWrite()) {
                            val hang = state.posTables.firstOrNull { it.state == "busy" || it.state == "就餐" }
                            Button(
                                onClick = {
                                    ConfirmBus.ask(
                                        ConfirmRequest(
                                            title = "按本餐缺口建工单",
                                            summary = buildString {
                                                append("${sug.name ?: sug.skuId} · ${sug.qty} 个")
                                                hang?.let { append(" · 挂桌 ${it.no ?: it.id}") }
                                                append("\n${sug.reason ?: ""}")
                                            },
                                            type = "workorder.create",
                                            payload = buildJsonObject {
                                                put("sku_id", sug.skuId)
                                                put("qty", sug.qty)
                                                put("status", "待开始")
                                                put("note", "本餐需求缺口")
                                                if (hang != null) {
                                                    put("table_id", hang.id)
                                                    put("table_no", hang.no ?: hang.id)
                                                }
                                            },
                                            baseRev = state.rev,
                                            onResult = { r ->
                                                r.fold(
                                                    onSuccess = {
                                                        Toast.makeText(context, "已入队", Toast.LENGTH_SHORT).show()
                                                        viewModel.dispatch(
                                                            KitchenViewModel.KitchenIntent.AfterWorkorderQueued(
                                                                sug.skuId,
                                                                sug.qty
                                                            )
                                                        )
                                                    },
                                                    onFailure = {
                                                        Toast.makeText(context, it.message ?: "失败", Toast.LENGTH_SHORT).show()
                                                    }
                                                )
                                            }
                                        )
                                    )
                                },
                                modifier = Modifier.fillMaxWidth(),
                                shape = RoundedCornerShape(10.dp)
                            ) { Text("按缺口建工单 ${sug.qty} 个" + (hang?.let { " · 桌${it.no ?: it.id}" } ?: "")) }
                        }
                    }
                    if (state.workorders.isEmpty()) {
                        Text(
                            "去菜谱算料转工单 ›",
                            color = Ink,
                            fontWeight = FontWeight.Bold,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier
                                .padding(top = 4.dp)
                                .clickable(onClick = onGoRecipes)
                        )
                    } else {
                        Text(
                            "看出品进度 ›",
                            color = Ink,
                            fontWeight = FontWeight.Bold,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier
                                .padding(top = 4.dp)
                                .clickable(onClick = onGoBoard)
                        )
                    }
                }
            }
        }
        if (state.workorders.isEmpty() && !state.loading) {
            item {
                Card(
                    shape = RoundedCornerShape(14.dp),
                    colors = CardDefaults.cardColors(containerColor = CardBg),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        "按菜谱出品标准建工单：选菜谱看工序 → 转工单；或按本餐缺口一键生成",
                        modifier = Modifier.padding(16.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        color = SubC
                    )
                }
            }
        }
        items(state.workorders, key = { it.id }) { wo ->
            val highlight = wo.skuId == state.highlightSkuId
            WorkorderCard(
                wo = wo,
                mealClock = mealClock,
                highlight = highlight,
                canWrite = AppModule.canWrite(),
                rev = state.rev,
                onOpenRecipe = {
                    viewModel.dispatch(
                        KitchenViewModel.KitchenIntent.OpenRecipeFromWorkorder(wo.skuId, wo.qty)
                    )
                },
                onAdvanced = {
                    viewModel.dispatch(KitchenViewModel.KitchenIntent.SelectTab(KitchenViewModel.KitchenTab.WORKORDERS))
                    viewModel.dispatch(KitchenViewModel.KitchenIntent.Refresh)
                }
            )
        }
    }
}

@Composable
private fun WorkorderCard(
    wo: WorkorderDto,
    mealClock: LocalTime,
    highlight: Boolean,
    canWrite: Boolean,
    rev: String?,
    onOpenRecipe: () -> Unit,
    onAdvanced: () -> Unit
) {
    val context = LocalContext.current
    val timeline = buildSopTimeline(wo.steps, mealClock = mealClock)
    val next = nextWorkorderStatus(wo.status)
    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (highlight) FiveYellowC.copy(alpha = 0.12f) else CardBg
        ),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.clickable(onClick = onOpenRecipe)
            ) {
                Box(Modifier.size(12.dp).clip(CircleShape).background(colorOfFive(wo.color)))
                Column(Modifier.weight(1f)) {
                    Text(
                        "${wo.name.ifBlank { wo.skuId }} · 按标准执行",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        buildString {
                            append("计划 ${wo.qty} 个")
                            wo.tableLabel()?.let { append(" · 桌 $it") }
                            append(" · 点标题看菜谱标准（须遵照）")
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = SubC
                    )
                }
                StatusTag(wo.status, statusColor(wo.status))
            }
            if (next != null && canWrite) {
                Button(
                    onClick = {
                        ConfirmBus.ask(
                            ConfirmRequest(
                                title = "推进工单 → $next",
                                summary = buildString {
                                    append("${wo.name.ifBlank { wo.skuId }} · ${wo.qty} 个\n${wo.status} → $next")
                                    if (next == "制作中") append("\n将按菜谱标准 BOM 备料扣一次；结账同桌同菜不再叠扣")
                                    if (next == "待传") append("\n标齐：出品完成，等候前厅传菜上桌")
                                    if (next == "已完成" || next == "完成") append("\n已传上桌 / 本工单收口")
                                },
                                type = "workorder.advance",
                                payload = buildJsonObject {
                                    put("id", wo.id)
                                    put("status", next)
                                    // 推进到制作中时消费器按菜谱 BOM 扣料
                                    put("deduct", next == "制作中")
                                },
                                baseRev = rev,
                                onResult = { r ->
                                    r.fold(
                                        onSuccess = {
                                            Toast.makeText(context, "已推进至 $next", Toast.LENGTH_SHORT).show()
                                            onAdvanced()
                                        },
                                        onFailure = {
                                            Toast.makeText(context, it.message ?: "失败", Toast.LENGTH_SHORT).show()
                                        }
                                    )
                                }
                            )
                        )
                    },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(10.dp)
                ) { Text("推进到$next") }
            }
            if (timeline.isEmpty()) {
                Text("暂无关联工序标准（菜谱 SOP 推送后须按步骤执行）", color = SubC, style = MaterialTheme.typography.bodySmall)
            } else {
                Box(Modifier.fillMaxWidth().padding(start = 3.dp)) {
                    Box(
                        Modifier
                            .padding(start = 3.dp, top = 8.dp, bottom = 8.dp)
                            .width(2.dp)
                            .height((timeline.size * 48).dp.coerceAtMost(280.dp))
                            .background(LineC)
                    )
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        timeline.forEach { tl ->
                            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
                                Box(
                                    Modifier
                                        .padding(top = 4.dp)
                                        .size(8.dp)
                                        .clip(CircleShape)
                                        .background(
                                            when (tl.state) {
                                                "done" -> FiveGreenC
                                                "now" -> FiveRedC
                                                else -> SubC
                                            }
                                        )
                                )
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        "${tl.timeLabel}  ${tl.step.stepNo}. ${tl.step.stage}",
                                        style = MaterialTheme.typography.bodyMedium,
                                        fontWeight = if (tl.state == "now") FontWeight.Bold else FontWeight.Normal
                                    )
                                    tl.step.keyPoints.firstOrNull()?.let {
                                        Text(it, style = MaterialTheme.typography.bodySmall, color = SubC)
                                    }
                                }
                                Text(
                                    when (tl.state) {
                                        "done" -> "✓ 已完成"
                                        "now" -> "● 进行中"
                                        else -> ""
                                    },
                                    style = MaterialTheme.typography.labelSmall,
                                    color = if (tl.state == "now") FiveRedC else FiveGreenC
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

internal fun nextWorkorderStatus(status: String): String? = when (status.trim()) {
    "待开始", "pending", "todo", "待备", "" -> "制作中"
    "制作中", "进行中", "doing", "in_progress" -> "待传"
    "待传", "ready", "pass_ready", "齐" -> "已完成"
    else -> null
}

internal fun statusColor(status: String) = when {
    status.contains("完成") || status == "done" || status.contains("已传") -> FiveGreenC
    status.contains("待传") || status == "ready" || status.contains("齐") -> FiveYellowC
    status.contains("制作") || status.contains("进行") -> FiveRedC
    else -> FiveYellowC
}

private fun resolveMealClock(workorders: List<WorkorderDto>): LocalTime {
    val raw = workorders.mapNotNull { it.plannedStart }.minOrNull()
    if (raw != null) {
        val t = raw.substringAfter('T', raw).take(5)
        runCatching { return LocalTime.parse(t) }
    }
    return LocalTime.of(11, 30)
}
