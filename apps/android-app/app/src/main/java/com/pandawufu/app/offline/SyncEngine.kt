package com.pandawufu.app.offline

import android.util.Log
import com.pandawufu.shared.network.BffClient
import com.pandawufu.shared.redline.ConfirmGateway
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * 联网同步引擎：
 * 1) 冲刷离线发件箱 → ConfirmGateway（入队+确认）
 * 2) 鉴权失败的条目直接丢弃并提示重新登录，避免「待同步」死循环
 */
class SyncEngine(
    private val network: NetworkMonitor,
    private val outbox: OfflineOutbox,
    private val cache: OfflineCache,
    private val bff: BffClient,
    private val scope: CoroutineScope,
    private val ensureAuth: suspend () -> Boolean = { true }
) {
    private val mutex = Mutex()
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    private val _pending = MutableStateFlow(outbox.count())
    val pendingCount: StateFlow<Int> = _pending.asStateFlow()

    private val _syncing = MutableStateFlow(false)
    val syncing: StateFlow<Boolean> = _syncing.asStateFlow()

    private val _lastMessage = MutableStateFlow<String?>(null)
    val lastMessage: StateFlow<String?> = _lastMessage.asStateFlow()

    private var watchJob: Job? = null

    fun start() {
        if (watchJob != null) return
        watchJob = scope.launch {
            var wasOnline = network.isOnline()
            network.online.collect { on ->
                if (on && !wasOnline) {
                    flush()
                }
                wasOnline = on
            }
        }
        refreshPending()
    }

    fun refreshPending() {
        _pending.value = outbox.count()
    }

    /** 清空发件箱（鉴权死循环或用户主动丢弃） */
    fun clearPending(reason: String? = null) {
        outbox.clear()
        _pending.value = 0
        _lastMessage.value = reason ?: "已清空待同步"
    }

    suspend fun flush(): Int = mutex.withLock {
        if (!network.isOnline()) {
            _lastMessage.value = "离线中 · 待同步 ${_pending.value} 条"
            return 0
        }
        if (!ensureAuth()) {
            _lastMessage.value = "登录已失效 · 请重新登录后再同步"
            return 0
        }
        val items = outbox.list()
        if (items.isEmpty()) {
            _pending.value = 0
            return 0
        }
        _syncing.value = true
        var ok = 0
        try {
            val rev = runCatching { bff.snapshotLatest().revText().ifBlank { null } }.getOrNull()
            for (item in items) {
                try {
                    val payload = json.decodeFromString(JsonObject.serializer(), item.payloadJson)
                    val proposed = ConfirmGateway.shared.propose(
                        type = item.type,
                        payload = payload,
                        baseRev = item.baseRev ?: rev,
                        operator = item.operator
                    )
                    ConfirmGateway.shared.confirm(
                        proposed,
                        operator = item.operator,
                        rev = proposed.rev ?: item.baseRev ?: rev
                    )
                    outbox.remove(item.localId)
                    ok++
                    Log.i(TAG, "flushed ${item.localId} → ${proposed.id}")
                } catch (e: Exception) {
                    val msg = e.message.orEmpty()
                    Log.w(TAG, "flush fail ${item.localId}: $msg")
                    if (isAuthOrForbidden(msg)) {
                        // 鉴权/权限问题：丢掉该条，避免一直「待同步」
                        outbox.remove(item.localId)
                        _lastMessage.value = humanAuthError(msg)
                        break
                    }
                    _lastMessage.value = "同步失败：${msg.ifBlank { "网络异常" }} · 点条重试"
                    break
                }
            }
            _pending.value = outbox.count()
            if (ok > 0 && _pending.value == 0) {
                cache.put("_sync_marker", """{"ok":true,"at":${System.currentTimeMillis()}}""")
                _lastMessage.value = "已同步 $ok 条离线拍板"
            } else if (ok > 0) {
                _lastMessage.value = "已同步 $ok 条 · 仍有 ${_pending.value} 条待处理"
            }
        } finally {
            _syncing.value = false
        }
        return ok
    }

    companion object {
        private const val TAG = "SyncEngine"

        fun isAuthOrForbidden(msg: String): Boolean {
            val m = msg.lowercase()
            return m.contains("unauthorized") ||
                m.contains("forbidden") ||
                m.contains("actions.write") ||
                m.contains("bearer") ||
                m.contains("401") ||
                m.contains("403")
        }

        fun humanAuthError(msg: String): String = when {
            msg.contains("只读") || msg.contains("actions.write") ->
                "当前账号无拍板权限 · 请用老板/店长登录后重试"
            msg.contains("unauthorized", true) || msg.contains("bearer", true) ->
                "登录已失效 · 请重新登录"
            else -> msg.ifBlank { "无权限同步" }
        }
    }
}
