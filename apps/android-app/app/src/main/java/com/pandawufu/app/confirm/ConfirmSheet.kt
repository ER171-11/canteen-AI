package com.pandawufu.app.confirm

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.pandawufu.app.AppModule
import com.pandawufu.app.ui.BossIa
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConfirmSheetHost() {
    val req = ConfirmBus.request ?: return
    val scope = rememberCoroutineScope()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var busy by mutableStateOf(false)
    var phase by mutableStateOf("确认")
    var error by mutableStateOf<String?>(null)

    ModalBottomSheet(
        onDismissRequest = { if (!busy) ConfirmBus.clear() },
        sheetState = sheetState
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 12.dp)
                .padding(bottom = 72.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text("确认台", style = MaterialTheme.typography.titleMedium)
            Text(req.title, style = MaterialTheme.typography.titleSmall)
            Text(req.summary, style = MaterialTheme.typography.bodyMedium)
            Text(
                "类型 ${req.type} · rev ${req.baseRev ?: "-"}",
                style = MaterialTheme.typography.bodySmall
            )
            Text(
                if (!AppModule.isOnline()) "确认后写入离线队列，联网自动同步到确认台"
                else "⚠ 确认后由店内消费器改库并推快照；AI 不会直接写库。",
                style = MaterialTheme.typography.bodySmall
            )
            error?.let { Text(it, color = Color(0xFFE8584A), style = MaterialTheme.typography.bodySmall) }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(
                    onClick = { ConfirmBus.clear() },
                    enabled = !busy,
                    shape = RoundedCornerShape(12.dp)
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
                                    OpsSignal.afterConfirm(
                                        req.type,
                                        executed = true,
                                        detail = statusDesc
                                    )
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
                    shape = RoundedCornerShape(12.dp)
                ) { Text(if (busy) phase else "确认并等待执行") }
            }
        }
    }
}
