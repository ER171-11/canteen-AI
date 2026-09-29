package com.pandawufu.shared.viewmodel

import com.pandawufu.shared.AppDispatchers
import com.pandawufu.shared.model.MIN_CONF
import com.pandawufu.shared.model.QcRecordDto
import com.pandawufu.shared.model.QcVerdictDto
import com.pandawufu.shared.model.QcVerdictLevel
import com.pandawufu.shared.model.parseConf
import com.pandawufu.shared.model.toQcVerdict
import com.pandawufu.shared.repository.KimiRepository
import com.pandawufu.shared.repository.KitchenRepository
import com.pandawufu.shared.repository.QcMediaRepository
import com.pandawufu.shared.repository.QcUploadResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * A 块「AI 品控识别」ViewModel（MVI）。
 *
 * 数据流：拍照 → 客户端合成水印 → base64 交 [KimiRepository] 识别（图片仅内存传递）
 * → 得判定 → 图片直传对象存储拿 photoKey/photoUrl → 由 UI 经 ConfirmGateway 入队 qc.record。
 *
 * 本 ViewModel **不做业务写**：判定只是状态，落库与「强制放行」必须走 redline.ConfirmGateway。
 * 对象存储未配置时 [QcMediaState.mediaConfigured] 为 false，UI 需明确标注「图片不可用」，
 * 但判定与落库照常进行——绝不能因为图床没配就让品控功能停摆。
 */
class QcMediaViewModel(
    private val kitchenRepository: KitchenRepository,
    private val kimiRepository: KimiRepository,
    private val mediaRepository: QcMediaRepository,
    private val today: String? = null,
    private val defaultStation: String? = null,
    /**
     * 端侧挂钟毫秒。commonMain 无平台时间 API，故由装配层注入
     * （Android 侧传 `System::currentTimeMillis`，测试可传固定值）。
     */
    private val nowMs: () -> Long = { 0L },
    dispatcher: kotlinx.coroutines.CoroutineDispatcher = AppDispatchers.main
) {
    data class QcMediaState(
        val loading: Boolean = false,
        val refreshing: Boolean = false,
        /** 对象存储是否可用；false 时照片无法回溯，界面必须标注 */
        val mediaConfigured: Boolean = false,
        val mediaMissingEnv: List<String> = emptyList(),
        /** 当前判定（刚拍完那张） */
        val verdict: QcVerdictDto? = null,
        val analyzing: Boolean = false,
        val uploading: Boolean = false,
        /** 图片不可用时的原因，直接展示给厨师长 */
        val photoNotice: String? = null,
        /** 今日品控台账 */
        val records: List<QcRecordDto> = emptyList(),
        val rev: String? = null,
        /** 台账里点开的那条 + 换来的带签名大图 URL */
        val detail: QcRecordDto? = null,
        val detailImageUrl: String? = null,
        val detailLoading: Boolean = false,
        /** 已强制放行的工单号（乐观标记，等后台确认后由刷新校正） */
        val forcePassedWorkorders: Set<String> = emptySet(),
        val error: String? = null,
        val emptyHint: String? = null
    ) {
        /** 不合格台账：决定是否显示「不合格大图」入口角标 */
        fun failed(): List<QcRecordDto> = records.filter { it.level() == QcVerdictLevel.FAIL }

        /** 待人工复核（临界/置信度不足） */
        fun review(): List<QcRecordDto> = records.filter { it.level() == QcVerdictLevel.REVIEW }

        fun passRate(): Int {
            if (records.isEmpty()) return 0
            val pass = records.count { it.level() == QcVerdictLevel.PASS }
            return (pass * 100) / records.size
        }

        /** 该工单是否已被强制放行（放行后 UI 不再显示锁标） */
        fun isForcePassed(workorderId: String?): Boolean =
            !workorderId.isNullOrBlank() && workorderId in forcePassedWorkorders

        /** 当前判定是否锁定工单（阻止标记完成 / 传菜） */
        fun locksWorkorder(): Boolean =
            verdict != null && verdict.locksWorkorder() && !isForcePassed(verdict.workorderId)
    }

    sealed interface QcMediaIntent {
        data object Refresh : QcMediaIntent
        data object LoadMediaStatus : QcMediaIntent
        /** base64 由端侧编码后传入（commonMain 不依赖平台编码 API） */
        data class Recognize(
            val imageBase64: String,
            val workorderId: String,
            val skuId: String? = null,
            val operator: String? = null,
            val station: String? = null,
            val stage: String? = null,
            val photoKey: String? = null,
            val photoUrl: String? = null
        ) : QcMediaIntent
        /** 识别完成后把水印照片直传图床，回填引用 */
        data class AttachPhoto(val workorderId: String, val bytes: ByteArray) : QcMediaIntent
        data object ClearVerdict : QcMediaIntent
        data class OpenDetail(val recordId: String?) : QcMediaIntent
        data object CloseDetail : QcMediaIntent
        /** 强制放行成功（由 UI 在 ConfirmGateway 完成后回执），带原因与操作人留痕 */
        data class NoteForcePassed(val workorderId: String, val reason: String, val operator: String) : QcMediaIntent
    }

    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val _state = MutableStateFlow(QcMediaState())
    val state: StateFlow<QcMediaState> = _state.asStateFlow()

    /** 强制放行留痕（工单 → 原因/操作人/时刻），供台账与追溯展示 */
    private val forcePassLog = mutableMapOf<String, ForcePassNote>()

    data class ForcePassNote(val reason: String, val operator: String, val ts: Long)

    fun dispatch(intent: QcMediaIntent) {
        when (intent) {
            QcMediaIntent.Refresh -> load(force = true)
            QcMediaIntent.LoadMediaStatus -> loadMediaStatus()
            is QcMediaIntent.Recognize -> recognize(intent)
            is QcMediaIntent.AttachPhoto -> attachPhoto(intent)
            QcMediaIntent.ClearVerdict -> _state.update { it.copy(verdict = null, photoNotice = null) }
            is QcMediaIntent.OpenDetail -> openDetail(intent.recordId)
            QcMediaIntent.CloseDetail -> _state.update { it.copy(detail = null, detailImageUrl = null) }
            is QcMediaIntent.NoteForcePassed -> noteForcePassed(intent)
        }
    }

    fun forcePassNoteOf(workorderId: String?): ForcePassNote? =
        workorderId?.let { forcePassLog[it] }

    /* ---------- 台账 ---------- */

    fun load(force: Boolean = false) {
        val s = _state.value
        if (s.loading || (s.refreshing && !force)) return
        _state.update { it.copy(loading = it.records.isEmpty(), refreshing = it.records.isNotEmpty(), error = null) }
        scope.launch {
            val resp = runCatching { kitchenRepository.qc(today) }.getOrNull()
            _state.update { prev ->
                if (resp == null) {
                    prev.copy(
                        loading = false,
                        refreshing = false,
                        error = "网络异常，品控台账未能刷新",
                        emptyHint = prev.emptyHint ?: "已展示上次结果，请稍后重试"
                    )
                } else {
                    prev.copy(
                        loading = false,
                        refreshing = false,
                        records = resp.items,
                        rev = resp.revText().ifBlank { prev.rev },
                        error = null
                    )
                }
            }
        }
    }

    fun loadMediaStatus() {
        scope.launch {
            val st = runCatching { mediaRepository.status() }.getOrNull() ?: return@launch
            _state.update {
                it.copy(
                    mediaConfigured = st.configured,
                    mediaMissingEnv = st.missing
                )
            }
        }
    }

    /* ---------- 识别 ---------- */

    private fun recognize(intent: QcMediaIntent.Recognize) {
        if (intent.imageBase64.isBlank()) {
            _state.update { it.copy(error = "照片数据为空，请重拍") }
            return
        }
        _state.update { it.copy(analyzing = true, error = null, photoNotice = null) }
        scope.launch {
            val resp = runCatching {
                kimiRepository.callVision(
                    type = QC_VISION_TYPE,
                    imageBase64 = intent.imageBase64,
                    // ctx 只带文字元数据：环节/工位/工单用于让模型按该菜标准判定
                    ctx = buildMap {
                        intent.skuId?.takeIf { it.isNotBlank() }?.let { put("sku_id", it) }
                        put("workorder_id", intent.workorderId)
                        (intent.stage ?: "").takeIf { it.isNotBlank() }?.let { put("stage", it) }
                        (intent.station ?: defaultStation ?: "").takeIf { it.isNotBlank() }?.let { put("station", it) }
                    }
                )
            }.getOrNull()

            val result = resp?.result
            if (resp == null || !resp.ok || result == null) {
                _state.update {
                    it.copy(
                        analyzing = false,
                        error = resp?.error ?: "识别失败，请重拍或人工判定",
                        photoNotice = "本次未产生判定结论，照片仍可留档"
                    )
                }
                return@launch
            }
            val verdict = result.toQcVerdict(
                workorderId = intent.workorderId,
                skuId = intent.skuId,
                operator = intent.operator,
                station = intent.station ?: defaultStation,
                stage = intent.stage,
                photoKey = intent.photoKey,
                photoUrl = intent.photoUrl
            )
            _state.update {
                it.copy(
                    analyzing = false,
                    verdict = verdict,
                    error = null,
                    photoNotice = if (it.mediaConfigured) null else NOT_CONFIGURED_NOTICE
                )
            }
        }
    }

    /* ---------- 照片直传 ---------- */

    private fun attachPhoto(intent: QcMediaIntent.AttachPhoto) {
        if (intent.bytes.isEmpty()) return
        _state.update { it.copy(uploading = true) }
        scope.launch {
            val result = runCatching {
                mediaRepository.uploadQcPhoto(
                    workorderId = intent.workorderId,
                    skuId = _state.value.verdict?.skuId,
                    bytes = intent.bytes
                )
            }.getOrNull() ?: QcUploadResult.failed("图片上传异常，品控结论仍已记录")

            _state.update { prev ->
                val v = prev.verdict
                prev.copy(
                    uploading = false,
                    photoNotice = uploadNotice(result),
                    verdict = if (v != null && v.workorderId == intent.workorderId) {
                        v.copy(
                            photoKey = result.photoKey ?: v.photoKey,
                            photoUrl = result.photoUrl ?: v.photoUrl
                        )
                    } else {
                        v
                    }
                )
            }
        }
    }

    private fun uploadNotice(result: QcUploadResult): String? = when {
        result.uploaded -> null
        !result.configured -> NOT_CONFIGURED_NOTICE
        else -> result.skippedReason
    }

    /* ---------- 大图 ---------- */

    private fun openDetail(recordId: String?) {
        val record = _state.value.records.firstOrNull { it.id == recordId }
            ?: _state.value.records.firstOrNull { it.level() == QcVerdictLevel.FAIL }
        if (record == null) {
            _state.update { it.copy(error = "未找到该品控记录") }
            return
        }
        _state.update { it.copy(detail = record, detailLoading = true, detailImageUrl = null) }
        val key = record.photoKey
        if (key.isNullOrBlank()) {
            _state.update { it.copy(detailLoading = false) }
            return
        }
        scope.launch {
            val url = runCatching { mediaRepository.signUrl(key) }.getOrNull()
            _state.update { it.copy(detailLoading = false, detailImageUrl = url) }
        }
    }

    private fun noteForcePassed(intent: QcMediaIntent.NoteForcePassed) {
        val reason = intent.reason.trim()
        if (reason.isEmpty()) {
            _state.update { it.copy(error = "强制放行必须填写原因") }
            return
        }
        forcePassLog[intent.workorderId] = ForcePassNote(
            reason = reason,
            operator = intent.operator,
            ts = nowMs()
        )
        _state.update {
            it.copy(forcePassedWorkorders = it.forcePassedWorkorders + intent.workorderId, error = null)
        }
    }

    fun close() {
        scope.cancel()
    }

    /** 端侧时间戳；用 expect 会更干净但会给所有 target 增加负担，这里用 commonMain 的 clock */
    companion object {
        /** BFF `routes/kimi.js` 的品控用例标识 */
        const val QC_VISION_TYPE = "qc"

        val NOT_CONFIGURED_NOTICE =
            "图片暂不可用：服务器未配置对象存储，判定结论已记录，请看板或现场复核"

        /** 供 UI 判断置信度是否达标（与 toQcVerdict 同一阈值） */
        val MIN_CONFIDENCE = MIN_CONF

        /** 便于 UI 直接复用「95%」这类展示格式 */
        fun confText(raw: String?): String =
            parseConf(raw)?.let { "${it.toInt()}%" } ?: "未提供"
    }
}
