package com.pandawufu.app.features.modules

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pandawufu.app.AppModule
import com.pandawufu.app.confirm.ConfirmBus
import com.pandawufu.app.confirm.ConfirmRequest
import com.pandawufu.app.confirm.OpsSignal
import com.pandawufu.app.ui.BossIa
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.PandaCard
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.app.ui.designsystem.Txt
import com.pandawufu.shared.model.ActionListItemDto
import com.pandawufu.shared.redline.ConfirmGateway
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** 审批/动作队列：草稿可确认或驳回 */
@Composable
fun ActionsScreen() {
    var filter by remember { mutableStateOf<String?>("queued") }
    var items by remember { mutableStateOf<List<ActionListItemDto>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var busyId by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val canWrite = AppModule.canWrite()

    fun reload(status: String?) {
        scope.launch {
            loading = true
            error = null
            try {
                AppModule.ensureSession()
                val resp = AppModule.bffClient.listActions(status)
                if (!resp.ok) {
                    val fail = com.pandawufu.shared.util.LoadFailure.fromMessage(resp.error)
                    error = fail.error ?: fail.hint ?: (resp.error ?: "加载失败")
                    items = emptyList()
                } else {
                    items = resp.items
                }
            } catch (e: Exception) {
                val fail = com.pandawufu.shared.util.LoadFailure.from(e)
                error = fail.error ?: fail.hint
                items = emptyList()
            } finally {
                loading = false
            }
        }
    }

    fun revOf(a: ActionListItemDto): String? =
        when (val r = a.rev) {
            is JsonPrimitive -> r.contentOrNull
            null -> null
            else -> r.toString().trim('"')
        }

    fun actionTitle(type: String?): String = when (type) {
        "stock.replenish", "restock.create" -> "补货申请"
        "workorder.create" -> "厨房备料工单"
        "pos.checkout", "pos.pay" -> "桌台结账"
        "pos.table_state" -> "桌台状态变更"
        "takeout.ack" -> "外卖接单/拒单"
        "booking.confirm", "booking.seat" -> "预订/排队处理"
        "day.close" -> "打烊日清"
        "price.update" -> "菜品价格调整"
        else -> "门店操作"
    }

    fun actionHint(type: String?): String = when (type) {
        "stock.replenish", "restock.create" -> "确认后进入采购执行，不会自动付款"
        "workorder.create" -> "确认后交给厨房工单队列"
        "pos.checkout", "pos.pay" -> "确认后登记为待执行结账"
        "takeout.ack" -> "确认后同步外卖处理结果"
        "day.close" -> "确认后登记本日售出、入库与报损"
        else -> "确认后由店内执行器落地"
    }

    fun statusLabel(status: String?): String = when (status) {
        "queued" -> "等你拍板"
        "待执行" -> "店内执行中"
        "已执行" -> "已完成"
        "已驳回" -> "已退回"
        "已过期" -> "超时未执行·已过期"
        else -> status ?: "未知"
    }

    LaunchedEffect(filter) { reload(filter) }
    LaunchedEffect(OpsSignal.refreshHomeTick) {
        if (OpsSignal.refreshHomeTick > 0) reload(filter)
    }
    // 有在途动作（待执行）时持续轮询：店内执行器落地后自动从「执行中」翻到「已完成」，
    // 老板无需手动切筛选。key 为「是否存在待执行」，一旦全部落地即停止，避免无谓请求。
    val hasInflight = items.any { it.status == "待执行" }
    LaunchedEffect(hasInflight) {
        if (!hasInflight) return@LaunchedEffect
        while (true) {
            delay(5000)
            reload(filter)
        }
    }

    ModuleScaffold(
        title = BossIa.Mine.CONFIRM_DESK,
        subtitle = if (canWrite) BossIa.Mine.CONFIRM_DESK_SUB else "只读查看队列",
        loading = loading && items.isEmpty(),
        error = error,
        onRetry = { reload(filter) },
        empty = !loading && items.isEmpty(),
        emptyText = "暂无动作（各模块提交写操作后会出现在此）"
    ) {
        PandaCard {
            Text("这里不是流水账，是老板的拍板台", fontWeight = FontWeight.Bold, color = Ink)
            Text(
                if (canWrite) "系统先把补货、备料、结账等动作列出来；你确认后，店内人员再执行。"
                else "当前岗位只能查看，老板或店长确认后才会进入店内执行。",
                color = Sub
            )
            Text("先看清楚要做什么，再点“批准执行”；不合适就退回。", color = Sub)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(null to "全部", "queued" to "待我拍板", "待执行" to "执行中", "已执行" to "已完成", "已驳回" to "已退回", "已过期" to "已过期")
                .let { tabs ->
                    Row(
                        Modifier.horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        tabs.forEach { (st, label) ->
                            FilterChip(
                                selected = filter == st,
                                onClick = { filter = st },
                                label = { Text(label) }
                            )
                        }
                    }
                }
        }
        if (items.isNotEmpty()) {
            ModuleCard(if (filter == "queued") "等你拍板（${items.size}）" else "操作记录（${items.size}）") {
                items.take(40).forEach { a ->
                    val id = a.id
                    val title = actionTitle(a.type)
                    Text(title, fontWeight = FontWeight.Bold, color = Txt, modifier = Modifier.padding(top = 8.dp))
                    Text(statusLabel(a.status), color = if (a.status == "queued") Color(0xFFE4871A) else Sub)
                    Text(actionHint(a.type), color = Sub)
                    Text(
                        listOfNotNull(a.operator?.let { "发起人：$it" }, a.createdAt?.take(16)).joinToString(" · "),
                        color = Sub
                    )
                    a.error?.let {
                        Text("退回原因：$it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    }
                    if (canWrite && id != null && (a.status == "queued" || a.status == "待执行")) {
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            if (a.status == "queued") {
                                Button(
                                    onClick = {
                                        busyId = id
                                        scope.launch {
                                            try {
                                                AppModule.ensureSession()
                                                val op = AppModule.account ?: AppModule.role ?: "老板"
                                                val remoteRev = runCatching {
                                                    AppModule.bffClient.snapshotLatest().revText().ifBlank { null }
                                                }.getOrNull()
                                                // 始终以最新快照 rev 拍板；入队时的旧 rev 必然 409（与 ConfirmSheet 单发口径一致）
                                                val localRev = remoteRev ?: revOf(a)
                                                val confirmed = ConfirmGateway.shared.confirm(
                                                    com.pandawufu.shared.model.ActionDto(
                                                        id = id,
                                                        type = a.type ?: "",
                                                        payload = JsonObject(emptyMap()),
                                                        operator = op,
                                                        rev = localRev,
                                                        baseRev = localRev
                                                    ),
                                                    operator = op,
                                                    rev = localRev
                                                )
                                                Toast.makeText(
                                                    context,
                                                    "已确认 · ${confirmed.id}",
                                                    Toast.LENGTH_SHORT
                                                ).show()
                                                OpsSignal.afterConfirm(a.type ?: "action")
                                                reload(filter)
                                            } catch (e: Exception) {
                                                Toast.makeText(
                                                    context,
                                                    e.message ?: "确认失败",
                                                    Toast.LENGTH_SHORT
                                                ).show()
                                            } finally {
                                                busyId = null
                                            }
                                        }
                                    },
                                    enabled = busyId != id,
                                    shape = RoundedCornerShape(10.dp),
                                    modifier = Modifier.weight(1f)
                                ) { Text(if (busyId == id) "处理中…" else "批准执行") }
                            }
                            OutlinedButton(
                                onClick = {
                                    busyId = id
                                    scope.launch {
                                        try {
                                            AppModule.ensureSession()
                                            val resp = AppModule.bffClient.rejectAction(id, "老板驳回")
                                            Toast.makeText(
                                                context,
                                                if (resp.ok) "已驳回" else (resp.error ?: "驳回失败"),
                                                Toast.LENGTH_SHORT
                                            ).show()
                                            if (resp.ok) reload(filter)
                                        } catch (e: Exception) {
                                            Toast.makeText(context, e.message ?: "失败", Toast.LENGTH_SHORT).show()
                                        } finally {
                                            busyId = null
                                        }
                                    }
                                },
                                enabled = busyId != id,
                                shape = RoundedCornerShape(10.dp),
                                modifier = Modifier.weight(1f)
                            ) { Text("退回") }
                        }
                    } else if (a.status == "待执行") {
                        Text("已确认，等待店内执行器处理", color = Color(0xFF9A6B19), modifier = Modifier.padding(vertical = 6.dp))
                    }
                    val expiredType = a.type
                    if (canWrite && expiredType != null && a.status == "已过期") {
                        OutlinedButton(
                            onClick = {
                                ConfirmBus.ask(
                                    ConfirmRequest(
                                        title = "重新提交 · ${actionTitle(expiredType)}",
                                        summary = "原单超时未执行已过期，将以相同内容重新入队等你拍板。" +
                                            (a.error?.takeIf { it.isNotBlank() }?.let { "\n原单备注：$it" } ?: ""),
                                        type = expiredType,
                                        payload = a.payload ?: JsonObject(emptyMap()),
                                        baseRev = null,
                                        onResult = { r ->
                                            Toast.makeText(
                                                context,
                                                r.fold({ "已重新入队 · ${it.id}" }, { it.message ?: "重新提交失败" }),
                                                Toast.LENGTH_SHORT
                                            ).show()
                                            if (r.isSuccess) reload(filter)
                                        }
                                    )
                                )
                            },
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.fillMaxWidth()
                        ) { Text("重新提交") }
                    }
                }
            }
        }
        Text(
            "状态说明：等你拍板 → 店内执行中 → 已完成。若长时间停在“执行中”，请联系店内执行器或刷新重试。" +
                "超过 24 小时未执行的单会自动标记「已过期」，可点「重新提交」再次入队。",
            style = MaterialTheme.typography.bodySmall
        )
    }
}
