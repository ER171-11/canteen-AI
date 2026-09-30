package com.pandawufu.app.features.kitchen

import android.content.Intent
import android.net.Uri
import android.util.Base64
import android.widget.Toast
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.AppModule
import com.pandawufu.app.media.WatermarkSpec
import com.pandawufu.app.media.rememberWatermarkCapture
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.app.ui.designsystem.Txt
import com.pandawufu.shared.model.QcRecordDto
import com.pandawufu.shared.model.QcVerdictDto
import com.pandawufu.shared.model.QcVerdictLevel
import com.pandawufu.shared.model.QcForcePassRequest
import com.pandawufu.shared.model.QcRecordRequest
import com.pandawufu.shared.model.SopVideoDto
import com.pandawufu.shared.model.toPayload
import com.pandawufu.shared.redline.ConfirmGateway
import com.pandawufu.shared.viewmodel.KitchenViewModel
import com.pandawufu.shared.viewmodel.QcMediaViewModel
import kotlinx.coroutines.launch

/**
 * A 块「AI 品控拍照判定」主体。
 *
 * 数据流：选工单 → 水印相机拍照 → base64 交 kimi(qc) 识别 → 预览判定卡
 * → （不合格锁定工单 / 可强制放行填原因）→ 直传 OSS 拿引用 → ConfirmGateway 入队 qc.record。
 *
 * 复用同包 [StatusTag] 与判定三色（FiveGreenC / FiveRedC / FiveYellowC）。
 */
@Composable
fun QcMediaSection(
    qcVm: QcMediaViewModel,
    kitchenState: KitchenViewModel.KitchenState
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val state by qcVm.state.collectAsState()

    val workorders = kitchenState.workorders
    var selectedWoId by remember { mutableStateOf<String?>(null) }
    val selectedWo = workorders.firstOrNull { it.id == selectedWoId }
        ?: workorders.firstOrNull()

    val pendingBytes = remember { mutableStateOf<ByteArray?>(null) }

    val shooter = rememberWatermarkCapture(
        onCaptured = { photo, _ ->
            val wo = selectedWo
            val op = AppModule.displayName ?: AppModule.account ?: "厨师"
            scope.launch {
                val bytes = runCatching { photo.file.readBytes() }.getOrNull() ?: return@launch
                pendingBytes.value = bytes
                val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                qcVm.dispatch(
                    QcMediaViewModel.QcMediaIntent.Recognize(
                        imageBase64 = b64,
                        workorderId = wo?.id ?: "manual",
                        skuId = wo?.skuId,
                        operator = op,
                        station = AppModule.storeName,
                        stage = "出品",
                        photoKey = null,
                        photoUrl = null
                    )
                )
            }
        },
        onFailed = { msg -> Toast.makeText(context, msg, Toast.LENGTH_SHORT).show() }
    )

    // 识别完成且本地还有原图字节时，把水印照片直传 OSS，回填引用
    LaunchedEffect(state.verdict) {
        val v = state.verdict
        val bytes = pendingBytes.value
        if (v != null && bytes != null) {
            qcVm.dispatch(
                QcMediaViewModel.QcMediaIntent.AttachPhoto(
                    workorderId = v.workorderId ?: "manual",
                    bytes = bytes
                )
            )
            pendingBytes.value = null
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        // 1) 选工单
        if (workorders.isNotEmpty()) {
            Text("判定工单", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(workorders, key = { it.id }) { wo ->
                    val sel = wo.id == (selectedWo?.id ?: workorders.first().id)
                    Box(
                        Modifier
                            .clip(RoundedCornerShape(10.dp))
                            .background(if (sel) FiveGreenC else CardBg)
                            .clickable { selectedWoId = wo.id }
                            .padding(horizontal = 12.dp, vertical = 8.dp)
                    ) {
                        Text(
                            wo.name.ifBlank { wo.skuId },
                            color = if (sel) Color.White else Txt,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }
            }
        } else {
            Text(
                "未读取到今日工单，可先到工单页刷新；暂时将以「手动出品」记录。",
                fontSize = 12.sp,
                color = Sub
            )
        }

        // 2) 拍照判定入口
        Button(
            onClick = {
                shooter.capture(
                    WatermarkSpec(
                        storeName = AppModule.storeName ?: "本店",
                        pointName = "品控·${selectedWo?.name ?: "出品"}",
                        operator = AppModule.displayName ?: "厨师",
                        kind = "品控"
                    )
                )
            },
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(12.dp)
        ) {
            Text("拍照判定（水印相机）")
        }

        state.photoNotice?.let { notice ->
            Text(notice, fontSize = 12.sp, color = FiveYellowC)
        }

        // 3) 识别中：扫描动效
        if (state.analyzing) {
            ScanningCard()
        }

        // 4) 判定卡 + 处置
        state.verdict?.let { verdict ->
            VerdictCard(
                verdict = verdict,
                configured = state.mediaConfigured,
                uploading = state.uploading,
                onRecord = { pass ->
                    scope.launch {
                        enqueueQcRecord(qcVm, verdict, pass, context)
                    }
                },
                onForcePass = { reason ->
                    scope.launch {
                        forcePass(qcVm, verdict, reason, context)
                    }
                },
                onClear = { qcVm.dispatch(QcMediaViewModel.QcMediaIntent.ClearVerdict) }
            )
        }

        // 5) 今日品控台账（带判定三色与图片可用性标注）
        QcRecordsList(records = kitchenState.qc, onViewImage = { url ->
            runCatching {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            }.onFailure {
                Toast.makeText(context, "无法打开图片：${it.message}", Toast.LENGTH_SHORT).show()
            }
        })

        // 6) SOP 视频教材入口（后台上传绑定后可直接播放）
        SopVideoEntry(skuId = selectedWo?.skuId)
    }
}

/** 菜品 SOP 视频教材：后台绑定后展示并可直接播放（无视频库，走系统浏览器/播放器打开 URL） */
@Composable
private fun SopVideoEntry(skuId: String?) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var videos by remember { mutableStateOf<List<SopVideoDto>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }

    LaunchedEffect(skuId) {
        if (skuId.isNullOrBlank()) {
            videos = emptyList()
            return@LaunchedEffect
        }
        loading = true
        videos = runCatching {
            AppModule.bffClient.sopVideos(skuId).items
        }.getOrDefault(emptyList())
        loading = false
    }

    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = CardBg),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("SOP 视频教材", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
            if (loading) {
                CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.height(14.dp))
            } else if (videos.isEmpty()) {
                Text("暂无视频教材（后台可上传并与菜品绑定）", fontSize = 12.sp, color = Sub)
            } else {
                videos.forEach { v ->
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(v.title ?: "教学视频", fontSize = 13.sp, color = Txt)
                        TextButton(onClick = {
                            val url = v.videoUrl ?: v.videoKey
                            if (!url.isNullOrBlank()) {
                                runCatching {
                                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                                }.onFailure {
                                    Toast.makeText(context, "无法播放：${it.message}", Toast.LENGTH_SHORT).show()
                                }
                            } else {
                                Toast.makeText(context, "视频地址未就绪", Toast.LENGTH_SHORT).show()
                            }
                        }) { Text("播放") }
                    }
                }
            }
        }
    }
}

/** 识别中的扫描动效：一条自上而下循环的粉紫高光 */
@Composable
private fun ScanningCard() {
    val transition = rememberInfiniteTransition(label = "qc-scan")
    val y by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1200), RepeatMode.Reverse),
        label = "scan-y"
    )
    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = CardBg),
        modifier = Modifier.fillMaxWidth()
    ) {
        Box(Modifier.fillMaxWidth().height(120.dp).padding(14.dp)) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(3.dp)
                    .align(Alignment.TopStart)
                    .padding(top = (y * 92).dp)
                    .background(
                        Brush.horizontalGradient(
                            listOf(Color.Transparent, Color(0xFFB78BE8), Color.Transparent)
                        )
                    )
            )
            Text(
                "AI 正在识别饺子缺陷…",
                Modifier.align(Alignment.Center),
                color = Sub,
                fontSize = 13.sp
            )
        }
    }
}

/** 判定卡：合格绿 / 不合格红 / 临界橙 */
@Composable
private fun VerdictCard(
    verdict: QcVerdictDto,
    configured: Boolean,
    uploading: Boolean,
    onRecord: (Boolean) -> Unit,
    onForcePass: (String) -> Unit,
    onClear: () -> Unit
) {
    val level = verdict.level()
    val (bg, fg, title) = when (level) {
        QcVerdictLevel.PASS -> Triple(Color(0xFFEAF5EA), FiveGreenC, "合格")
        QcVerdictLevel.FAIL -> Triple(Color(0xFFFCEAEA), FiveRedC, "不合格")
        QcVerdictLevel.REVIEW -> Triple(Color(0xFFFDF3E0), FiveYellowC, "需人工复核")
    }
    var showForce by remember { mutableStateOf(false) }
    var reason by remember { mutableStateOf("") }

    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = bg),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, fontSize = 20.sp, fontWeight = FontWeight.ExtraBold, color = fg)
                verdict.conf?.let { c ->
                    Text(
                        "  置信度 ${(c).toInt()}%",
                        fontSize = 12.sp,
                        color = Sub
                    )
                }
            }
            if (verdict.defectItems.isNotEmpty()) {
                Text("缺陷项：${verdict.defectItems.joinToString("、")}", fontSize = 13.sp, color = Txt)
            }
            Text(
                "环节：${verdict.stage ?: "-"}　操作人：${verdict.operator ?: "-"}",
                fontSize = 12.sp,
                color = Sub
            )

            if (level == QcVerdictLevel.FAIL) {
                Text(
                    "已锁定该出品工单，禁止标记完成 / 传菜，直至厨师长强制放行。",
                    fontSize = 12.sp,
                    color = FiveRedC,
                    fontWeight = FontWeight.Bold
                )
            }
            if (!configured) {
                Text("图片暂不可用：服务器未配置对象存储，判定已记录。", fontSize = 12.sp, color = FiveYellowC)
            } else if (uploading) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.height(14.dp))
                    Text("图片上传中…", fontSize = 12.sp, color = Sub)
                }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = { onRecord(verdict.pass ?: false) },
                    shape = RoundedCornerShape(10.dp)
                ) {
                    Text(if (level == QcVerdictLevel.FAIL) "记录不合格并锁定" else "记录结论")
                }
                if (level == QcVerdictLevel.FAIL) {
                    OutlinedButton(onClick = { showForce = true }) {
                        Text("强制放行")
                    }
                }
            }
        }
    }

    if (showForce) {
        AlertDialog(
            onDismissRequest = { showForce = false },
            title = { Text("强制放行（须填原因）") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("不合格工单将被放行，系统留痕操作人与时刻。", fontSize = 12.sp, color = Sub)
                    OutlinedTextField(
                        value = reason,
                        onValueChange = { reason = it },
                        placeholder = { Text("例如：属正常开口造型，经复核可接受") },
                        singleLine = true
                    )
                }
            },
            confirmButton = {
                TextButton(
                    enabled = reason.isNotBlank(),
                    onClick = {
                        onForcePass(reason.trim())
                        showForce = false
                    }
                ) { Text("确认放行") }
            },
            dismissButton = { TextButton(onClick = { showForce = false }) { Text("取消") } }
        )
    }
}

/** 今日品控台账：判定三色 + 图片可用性 + 不合格大图入口 */
@Composable
private fun QcRecordsList(
    records: List<QcRecordDto>,
    onViewImage: (String) -> Unit
) {
    Text(
        "品控台账${if (records.isNotEmpty()) " · ${records.size}" else ""}",
        style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.Bold
    )
    if (records.isEmpty()) {
        Text("暂无品控记录 · 拍一张成品开始", color = Sub, fontSize = 12.sp)
        return
    }
    records.forEach { rec ->
        val level = rec.level()
        val color = when (level) {
            QcVerdictLevel.PASS -> FiveGreenC
            QcVerdictLevel.FAIL -> FiveRedC
            QcVerdictLevel.REVIEW -> FiveYellowC
        }
        Card(
            shape = RoundedCornerShape(12.dp),
            colors = CardDefaults.cardColors(containerColor = CardBg),
            modifier = Modifier.fillMaxWidth()
        ) {
            Row(
                Modifier.padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        rec.name ?: rec.checkType ?: "品控记录",
                        fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.bodyMedium
                    )
                    val meta = listOfNotNull(
                        rec.checkType,
                        rec.ts,
                        rec.inspector,
                        "环节:${rec.stage ?: "-"}"
                    ).joinToString(" · ")
                    Text(meta, fontSize = 12.sp, color = Sub)
                    if (!rec.photoUrl.isNullOrBlank()) {
                        Text("含留档照片（点击可看）", fontSize = 11.sp, color = FiveGreenC)
                    } else {
                        Text("图片不可用（未配置对象存储）", fontSize = 11.sp, color = Sub)
                    }
                    if (rec.manualReview) {
                        Text("已标注人工复核", fontSize = 11.sp, color = FiveYellowC)
                    }
                }
                StatusTag(rec.result ?: level.label, color)
                if (!rec.photoUrl.isNullOrBlank()) {
                    TextButton(onClick = { onViewImage(rec.photoUrl!!) }) { Text("看大图") }
                }
            }
        }
    }
}

/** 入队 qc.record（经 ConfirmGateway，不得直调 ActionRepository） */
private suspend fun enqueueQcRecord(
    qcVm: QcMediaViewModel,
    v: QcVerdictDto,
    pass: Boolean,
    context: android.content.Context
) {
    runCatching {
        AppModule.ensureSession()
        val op = AppModule.displayName ?: AppModule.account ?: "厨师"
        val rev = runCatching {
            AppModule.bffClient.snapshotLatest().revText().ifBlank { null }
        }.getOrNull()
        val payload = toPayload(
            QcRecordRequest(
                workorderId = v.workorderId ?: "manual",
                skuId = v.skuId,
                pass = pass,
                conf = v.conf,
                manualReview = v.manualReview,
                defectItems = v.defectItems,
                stage = v.stage,
                operator = op,
                station = v.station,
                photoKey = v.photoKey,
                photoUrl = v.photoUrl
            )
        )
        val proposed = ConfirmGateway.shared.propose("qc.record", payload, baseRev = rev, operator = op)
        ConfirmGateway.shared.confirm(proposed, operator = op, rev = proposed.rev ?: rev)
    }.onSuccess {
        qcVm.dispatch(QcMediaViewModel.QcMediaIntent.ClearVerdict)
        qcVm.dispatch(QcMediaViewModel.QcMediaIntent.Refresh)
        Toast.makeText(context, "品控结论已记录", Toast.LENGTH_SHORT).show()
    }.onFailure {
        Toast.makeText(context, "记录失败：${it.message}", Toast.LENGTH_SHORT).show()
    }
}

/** 强制放行：qc.force_pass 必须带原因与操作人 */
private suspend fun forcePass(
    qcVm: QcMediaViewModel,
    v: QcVerdictDto,
    reason: String,
    context: android.content.Context
) {
    runCatching {
        AppModule.ensureSession()
        val op = AppModule.displayName ?: AppModule.account ?: "厨师长"
        val rev = runCatching {
            AppModule.bffClient.snapshotLatest().revText().ifBlank { null }
        }.getOrNull()
        val payload = toPayload(
            QcForcePassRequest(
                workorderId = v.workorderId ?: "manual",
                reason = reason,
                operator = op,
                skuId = v.skuId
            )
        )
        val proposed = ConfirmGateway.shared.propose("qc.force_pass", payload, baseRev = rev, operator = op)
        ConfirmGateway.shared.confirm(proposed, operator = op, rev = proposed.rev ?: rev)
    }.onSuccess {
        qcVm.dispatch(
            QcMediaViewModel.QcMediaIntent.NoteForcePassed(
                workorderId = v.workorderId ?: "manual",
                reason = reason,
                operator = AppModule.displayName ?: AppModule.account ?: "厨师长"
            )
        )
        qcVm.dispatch(QcMediaViewModel.QcMediaIntent.Refresh)
        Toast.makeText(context, "已强制放行并留痕", Toast.LENGTH_SHORT).show()
    }.onFailure {
        Toast.makeText(context, "放行失败：${it.message}", Toast.LENGTH_SHORT).show()
    }
}
