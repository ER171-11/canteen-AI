package com.pandawufu.app.confirm

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.AppModule
import com.pandawufu.app.ui.BossIa
import com.pandawufu.app.ui.designsystem.CardHairline
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.Line
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.app.ui.designsystem.Txt
import com.pandawufu.shared.model.ActionDto
import com.pandawufu.shared.model.ActionStatus
import com.pandawufu.shared.redline.ConfirmGateway
import com.pandawufu.shared.redline.RedlineGuard
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject

data class ConfirmRequest(
    val title: String,
    val summary: String,
    val type: String,
    val payload: JsonObject,
    val baseRev: String?,
    val onResult: (Result<ActionDto>) -> Unit = {}
)

/** 全局确认台：propose → 用户确认 → confirm → 等到店内消费器执行（或超时说明）。 */
object ConfirmBus {
    var request by mutableStateOf<ConfirmRequest?>(null)
        private set

    fun ask(req: ConfirmRequest) {
        request = req
    }

    fun clear() {
        request = null
    }
}

/** 高风险动作：影响价格/配方/账目/人事，需强提醒。 */
private val HIGH_RISK_TYPES = setOf(
    "dish.price", "dish.upsert", "dish.set_active", "recipe.upsert", "recipe.substitute",
    "config.update", "staff.shift_upsert", "vip.campaign", "finance.approve", "finance.freeze",
    "loss.approve", "pos.void", "pos.merge", "pos.split"
)

private fun riskLabel(type: String): Pair<String, Color> =
    if (type in HIGH_RISK_TYPES) "高风险 · 请复核" to Color(0xFFE4871A)
    else "常规操作" to FiveGreen

/** 阶段：入队 → 确认 → 店内执行 */
private fun phaseIndex(phase: String): Int = when {
    phase.contains("店内") -> 2
    phase.contains("确认中") || phase.contains("入队") -> 1
    else -> 0
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConfirmSheetHost() {
    val req = ConfirmBus.request ?: return
    val scope = rememberCoroutineScope()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var busy by mutableStateOf(false)
    var phase by mutableStateOf("确认")
    var error by mutableStateOf<String?>(null)

    val (riskText, riskColor) = riskLabel(req.type)

    ModalBottomSheet(
        onDismissRequest = { if (!busy) ConfirmBus.clear() },
        sheetState = sheetState,
        containerColor = Color.White
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 10.dp)
                .padding(bottom = 76.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            // 头部
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("确认台", fontSize = 18.sp, fontWeight = FontWeight.ExtraBold, color = Ink)
                Box(
                    Modifier
                        .clip(CircleShape)
                        .background(riskColor.copy(alpha = 0.12f))
                        .padding(horizontal = 10.dp, vertical = 4.dp)
                ) {
                    Text(riskText, color = riskColor, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                }
            }

            // 事项
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(16.dp))
                    .background(Color(0xFFF7F8FC))
                    .border(1.dp, CardHairline, RoundedCornerShape(16.dp))
                    .padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                Text(req.title, fontSize = 15.sp, fontWeight = FontWeight.Bold, color = Txt)
                if (req.summary.isNotBlank()) {
                    Text(req.summary, fontSize = 12.5.sp, color = Sub, lineHeight = 18.sp)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Chip("类型 ${req.type}")
                    Chip("rev ${req.baseRev ?: "-"}")
                }
            }

            // 风险/写回说明
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(if (req.type in HIGH_RISK_TYPES) Color(0xFFFFF6E8) else Color(0xFFF1F6FF))
                    .padding(12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text(if (req.type in HIGH_RISK_TYPES) "⚠" else "ⓘ", fontSize = 13.sp)
                Text(
                    if (!AppModule.isOnline()) "离线：确认后写入本地发件箱，联网自动同步到确认台"
                    else "确认后由店内执行器改库并推快照；AI 不会直接写库，计价/库存核心零改动。",
                    fontSize = 11.5.sp, color = if (req.type in HIGH_RISK_TYPES) Color(0xFF9A6B19) else Color(0xFF3B5B92),
                    lineHeight = 16.sp
                )
            }

            error?.let { Text(it, color = FiveRed, fontSize = 12.sp, fontWeight = FontWeight.SemiBold) }

            // 执行进度：入队 → 确认 → 店内执行
            if (busy) {
                val idx = phaseIndex(phase)
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    StepBar(index = idx)
                    Text(phase, fontSize = 11.5.sp, color = Sub)
                    LinearProgressIndicator(
                        modifier = Modifier.fillMaxWidth().height(3.dp).clip(RoundedCornerShape(2.dp)),
                        color = Ink,
                        trackColor = Line
                    )
                }
            }

            // 按钮层级：主 CTA + 次取消
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(
                    onClick = { ConfirmBus.clear() },
                    enabled = !busy,
                    shape = RoundedCornerShape(14.dp),
                    modifier = Modifier.weight(1f).height(48.dp)
                ) { Text("取消") }
                Button(
                    onClick = {
                        busy = true
                        error = null
                        phase = if (!AppModule.isOnline()) "离线入队…" else "提交中…"
                        scope.launch {
                            try {
                                AppModule.ensureSession()
                                val op = AppModule.account?.takeIf { it.isNotBlank() }
                                    ?: AppModule.displayName
                                    ?: AppModule.role
                                    ?: BossIa.Brand.BOSS_NAME

                                // 离线：写入发件箱，联网后 SyncEngine 自动冲刷
                                if (!AppModule.isOnline()) {
                                    val localId = "offline-${System.currentTimeMillis().toString(16)}"
                                    val payloadJson = AppModule.bffClient.json.encodeToString(
                                        kotlinx.serialization.json.JsonObject.serializer(),
                                        req.payload
                                    )
                                    AppModule.offlineOutbox.enqueue(
                                        com.pandawufu.app.offline.OfflineOutbox.Item(
                                            localId = localId,
                                            type = req.type,
                                            payloadJson = payloadJson,
                                            operator = op,
                                            baseRev = req.baseRev,
                                            title = req.title,
                                            summary = req.summary
                                        )
                                    )
                                    AppModule.syncEngine.refreshPending()
                                    val local = ActionDto(
                                        id = localId,
                                        type = req.type,
                                        payload = req.payload,
                                        status = ActionStatus.PENDING,
                                        operator = op,
                                        baseRev = req.baseRev
                                    )
                                    req.onResult(Result.success(local))
                                    OpsSignal.afterConfirm(req.type, executed = false)
                                    ConfirmBus.clear()
                                    return@launch
                                }

                                val remoteRev = runCatching {
                                    AppModule.bffClient.snapshotLatest().revText().ifBlank { null }
                                }.getOrNull()
                                // 模块未带 baseRev 时，以当前快照 rev 为基准，避免「rev - → N」误拦
                                val localRev = req.baseRev?.takeIf { it.isNotBlank() } ?: remoteRev
                                if (!RedlineGuard.checkBeforeConfirm(localRev, remoteRev)) {
                                    error = "店内数据已更新（rev ${req.baseRev ?: "-"} → ${remoteRev ?: "-"}），请先刷新再确认"
                                    busy = false
                                    phase = "确认"
                                    return@launch
                                }

                                phase = "入队…"
                                val proposed = try {
                                    ConfirmGateway.shared.propose(
                                        type = req.type,
                                        payload = req.payload,
                                        baseRev = localRev,
                                        operator = op
                                    )
                                } catch (e: Exception) {
                                    val msg = e.message.orEmpty()
                                    // 鉴权/权限失败绝不能塞进离线队列，否则会一直「待同步」
                                    if (com.pandawufu.app.offline.SyncEngine.isAuthOrForbidden(msg)) {
                                        throw IllegalStateException(
                                            com.pandawufu.app.offline.SyncEngine.humanAuthError(msg),
                                            e
                                        )
                                    }
                                    // 真·网络失败 → 降级离线队列
                                    val localId = "offline-${System.currentTimeMillis().toString(16)}"
                                    val payloadJson = AppModule.bffClient.json.encodeToString(
                                        kotlinx.serialization.json.JsonObject.serializer(),
                                        req.payload
                                    )
                                    val queued = runCatching {
                                        AppModule.offlineOutbox.enqueue(
                                            com.pandawufu.app.offline.OfflineOutbox.Item(
                                                localId = localId,
                                                type = req.type,
                                                payloadJson = payloadJson,
                                                operator = op,
                                                baseRev = localRev,
                                                title = req.title,
                                                summary = req.summary
                                            )
                                        )
                                        AppModule.syncEngine.refreshPending()
                                    }
                                    if (queued.isFailure) {
                                        throw IllegalStateException(
                                            e.message?.takeIf { it.isNotBlank() }
                                                ?: "入队失败，请检查网络后重试",
                                            e
                                        )
                                    }
                                    req.onResult(
                                        Result.success(
                                            ActionDto(
                                                id = localId,
                                                type = req.type,
                                                payload = req.payload,
                                                status = ActionStatus.PENDING,
                                                operator = op,
                                                baseRev = localRev
                                            )
                                        )
                                    )
                                    OpsSignal.afterConfirm(req.type, executed = false)
                                    ConfirmBus.clear()
                                    return@launch
                                }
                                val afterRev = runCatching {
                                    AppModule.bffClient.snapshotLatest().revText().ifBlank { null }
                                }.getOrNull()
                                val confirmRev = proposed.rev ?: req.baseRev ?: remoteRev
                                if (!RedlineGuard.checkBeforeConfirm(confirmRev, afterRev)) {
                                    error = "确认瞬间数据又更新了，请取消后刷新重试"
                                    busy = false
                                    phase = "确认"
                                    return@launch
                                }
                                phase = "确认中…"
                                var confirmed = ConfirmGateway.shared.confirm(
                                    proposed,
                                    operator = op,
                                    rev = confirmRev
                                )

                                // 等到店内消费器真正改库（最多约 25s）
                                phase = "店内执行中…"
                                var terminal: ActionDto? = null
                                var statusDesc: String? = null
                                wait@ for (i in 0 until 50) {
                                    delay(500)
                                    val st = runCatching {
                                        AppModule.bffClient.actionStatus(confirmed.id)
                                    }.getOrNull() ?: continue@wait
                                    when (ActionStatus.fromWire(st.status)) {
                                        ActionStatus.EXECUTED -> {
                                            statusDesc = st.desc?.takeIf { it.isNotBlank() }
                                            terminal = confirmed.copy(
                                                status = ActionStatus.EXECUTED,
                                                error = st.error
                                            )
                                            break@wait
                                        }
                                        ActionStatus.REJECTED -> {
                                            error = st.error ?: "店内已驳回"
                                            req.onResult(Result.failure(IllegalStateException(error)))
                                            busy = false
                                            phase = "确认"
                                            return@launch
                                        }
                                        else -> Unit
                                    }
                                }
                                if (terminal != null) {
                                    req.onResult(Result.success(terminal!!))
                                    OpsSignal.afterConfirm(req.type, executed = true, detail = statusDesc)
                                    ConfirmBus.clear()
                                } else {
                                    req.onResult(Result.success(confirmed))
                                    OpsSignal.afterConfirm(req.type, executed = false)
                                    ConfirmBus.clear()
                                }
                            } catch (e: Exception) {
                                error = e.message ?: "确认失败"
                                req.onResult(Result.failure(e))
                                busy = false
                                phase = "确认"
                            }
                        }
                    },
                    enabled = !busy,
                    shape = RoundedCornerShape(14.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Ink, contentColor = Color.White),
                    modifier = Modifier.weight(1.6f).height(48.dp)
                ) { Text(if (busy) phase else "确认并等待执行", fontWeight = FontWeight.Bold) }
            }
        }
    }
}

@Composable
private fun Chip(text: String) {
    Box(
        Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(Color.White)
            .border(1.dp, CardHairline, RoundedCornerShape(8.dp))
            .padding(horizontal = 8.dp, vertical = 2.dp)
    ) {
        Text(text, fontSize = 10.sp, color = Sub)
    }
}

@Composable
private fun StepBar(index: Int) {
    val labels = listOf("入队", "确认", "店内执行")
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        labels.forEachIndexed { i, label ->
            val on = i <= index
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Box(
                    Modifier
                        .size(16.dp)
                        .clip(CircleShape)
                        .background(if (on) Ink else Line),
                    contentAlignment = Alignment.Center
                ) {
                    Text("${i + 1}", fontSize = 9.sp, color = if (on) Color.White else Sub, fontWeight = FontWeight.Bold)
                }
                Text(label, fontSize = 10.5.sp, color = if (on) Ink else Sub, fontWeight = if (on) FontWeight.Bold else FontWeight.Normal)
            }
            if (i < labels.size - 1) {
                Box(Modifier.weight(1f).height(1.dp).background(Line))
            }
        }
    }
}
