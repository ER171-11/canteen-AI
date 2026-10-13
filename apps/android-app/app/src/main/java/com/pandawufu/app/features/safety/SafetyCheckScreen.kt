package com.pandawufu.app.features.safety

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
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
import com.pandawufu.app.media.WatermarkSpec
import com.pandawufu.app.media.rememberWatermarkCapture
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FivePurple
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.FiveYellow
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.app.ui.designsystem.Txt
import com.pandawufu.shared.model.SafetyProgressDto
import com.pandawufu.shared.model.SafetyProgressPointDto
import com.pandawufu.shared.redline.ConfirmGateway
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * 员工端：食安点位拍照上报（写操作 type=safety.check）。
 *
 * 数据流（与 docs/safety-schema.md / 分端机制指南一致）：
 *   GET /api/safety/progress（只读，含内置种子点位）
 *     → 选点位 → 水印相机拍照 → 预签名直传对象存储（图片不经 BFF、不入库）
 *     → ConfirmGateway.propose/confirm('safety.check', {point_id, photo_url, taken_at, operator})
 *     → 立刻提示「已上报，待确认」。
 *
 * 三条硬约束的落地点：
 *  1. **不等待 AI**：提交后不等视觉初判，`ai_result` 由 BFF 异步回填；本页只提示「已上报，待确认」；
 *  2. 写操作**只经 ConfirmGateway**（红线：禁止直调 ActionRepository / postAction）；
 *  3. 权限与 admin-web 双轨：路由映射 `m/safety-check → foodsafe`，按钮再校验 `foodsafe.write`。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SafetyCheckScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val operator = remember { AppModule.displayName ?: AppModule.account ?: "员工" }
    val storeName = remember { AppModule.storeName ?: "熊猫五福" }

    var progress by remember { mutableStateOf<SafetyProgressDto?>(null) }
    var loading by remember { mutableStateOf(false) }
    var uploadingPointId by remember { mutableStateOf<String?>(null) }
    var pendingPoint by remember { mutableStateOf<SafetyProgressPointDto?>(null) }

    /** 上报按钮：需 `foodsafe.write`（老板/店长全开；只读岗仅能看进度） */
    val canReport = remember { AppModule.can("foodsafe", write = true) }

    suspend fun refresh() {
        loading = true
        progress = runCatching { AppModule.safetyRepository.progress() }.getOrNull() ?: progress
        loading = false
    }

    LaunchedEffect(Unit) { refresh() }

    /** UTC ISO8601：与 BFF 的「今日」口径（UTC 日期）保持一致 */
    fun utcIso(ts: Long): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
            .apply { timeZone = TimeZone.getTimeZone("UTC") }
            .format(Date(ts))

    val shooter = rememberWatermarkCapture(
        onCaptured = { photo, _ ->
            val point = pendingPoint
            if (point == null) {
                Toast.makeText(context, "未选定点位，请重试", Toast.LENGTH_SHORT).show()
            } else {
                uploadingPointId = point.pointId
                scope.launch {
                    try {
                        val bytes = runCatching { photo.file.readBytes() }.getOrNull()
                        if (bytes == null || bytes.isEmpty()) {
                            Toast.makeText(context, "照片读取失败，请重试", Toast.LENGTH_SHORT).show()
                            return@launch
                        }
                        /*
                         * 1) 图片直传对象存储：复用既有的品控媒体预签名通道
                         *    （POST /api/qc/media/presign → PUT 直传，BFF 只签发地址、不接收图片本体）。
                         *    件号位传点位 id，便于对象键按「点位」归档；图片本体不入库、不入 BFF。
                         */
                        val up = runCatching {
                            AppModule.qcMediaRepository.uploadQcPhoto(
                                workorderId = point.pointId,
                                bytes = bytes,
                                contentType = "image/jpeg"
                            )
                        }.getOrNull()

                        // 2) 组 payload（photo_url 可为空：对象存储未配置时仍允许上报，AI 初判会记 error）
                        val payload = AppModule.safetyRepository.checkPayload(
                            pointId = point.pointId,
                            photoUrl = up?.photoUrl,
                            operator = operator,
                            takenAt = utcIso(photo.capturedAt)
                        )

                        // 3) 唯一写入口：入队 + 确认（rev 校验由网关与服务端兜底）
                        val rev = progress?.rev
                            ?.takeIf { it !is JsonNull }
                            ?.toString()
                            ?.trim('"')
                        val proposed = ConfirmGateway.shared.propose(
                            type = "safety.check",
                            payload = payload,
                            baseRev = rev,
                            operator = operator
                        )
                        ConfirmGateway.shared.confirm(
                            action = proposed,
                            operator = operator,
                            rev = proposed.rev ?: rev
                        )

                        Toast.makeText(
                            context,
                            "已上报，待确认：${point.name}",
                            Toast.LENGTH_SHORT
                        ).show()
                        refresh()
                    } finally {
                        uploadingPointId = null
                        pendingPoint = null
                    }
                }
            }
        },
        onFailed = { msg -> Toast.makeText(context, msg, Toast.LENGTH_SHORT).show() }
    )

    Scaffold(
        topBar = { TopAppBar(title = { Text("食安拍照核验", fontWeight = FontWeight.Bold) }) }
    ) { padding ->
        LazyColumn(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            item {
                SummaryCard(
                    progress = progress,
                    loading = loading,
                    onRefresh = { scope.launch { refresh() } }
                )
            }
            if (!canReport) {
                item {
                    Text(
                        "当前岗位仅可查看进度，上报需「食安」写权限",
                        color = Sub,
                        fontSize = 12.sp,
                        modifier = Modifier.padding(horizontal = 4.dp)
                    )
                }
            }
            val points = progress?.points.orEmpty()
            if (points.isEmpty()) {
                item {
                    Text(
                        if (loading) "加载中…" else "暂无点位（请检查 BFF 是否在线）",
                        color = Sub,
                        fontSize = 13.sp,
                        modifier = Modifier.padding(8.dp)
                    )
                }
            }
            items(points, key = { it.pointId }) { point ->
                PointCard(
                    point = point,
                    canReport = canReport,
                    uploading = uploadingPointId == point.pointId,
                    onCapture = {
                        pendingPoint = point
                        shooter.capture(
                            WatermarkSpec(
                                storeName = storeName,
                                pointName = point.name,
                                operator = operator,
                                kind = "食安"
                            )
                        )
                    }
                )
            }
            item { Spacer(Modifier.height(16.dp)) }
        }
    }
}

@Composable
private fun SummaryCard(
    progress: SafetyProgressDto?,
    loading: Boolean,
    onRefresh: () -> Unit
) {
    Card(
        Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = CardBg)
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("今日进度", fontWeight = FontWeight.Bold, color = Txt, fontSize = 15.sp)
                Spacer(Modifier.width(8.dp))
                Text(
                    progress?.date?.takeIf { it.isNotBlank() } ?: "—",
                    color = Sub,
                    fontSize = 12.sp
                )
                Spacer(Modifier.weight(1f))
                if (loading) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                Button(onClick = onRefresh) { Text("刷新") }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                StatItem("应检", progress?.totalPoints ?: 0, Txt)
                StatItem("已上报", progress?.completedPoints ?: 0, FivePurple)
                StatItem("合格", progress?.passCount ?: 0, FiveGreen)
                StatItem("不合格", progress?.failCount ?: 0, FiveRed)
                StatItem("待复核", progress?.reviewCount ?: 0, FiveYellow)
            }
            if (progress?.usingDefaults == true) {
                Text(
                    "当前为内置默认点位；上报记录仍按点位 id 归档",
                    color = Sub,
                    fontSize = 11.sp
                )
            }
        }
    }
}

@Composable
private fun StatItem(label: String, value: Int, color: Color) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text("$value", color = color, fontWeight = FontWeight.Bold, fontSize = 18.sp)
        Text(label, color = Sub, fontSize = 11.sp)
    }
}

@Composable
private fun PointCard(
    point: SafetyProgressPointDto,
    canReport: Boolean,
    uploading: Boolean,
    onCapture: () -> Unit
) {
    Card(
        Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = CardBg)
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(point.name, fontWeight = FontWeight.Bold, color = Txt, fontSize = 15.sp)
                    Text(
                        "${point.zone.ifBlank { "未分区" }} · ${point.pointId}",
                        color = Sub,
                        fontSize = 11.sp
                    )
                }
                StatusChip(point)
            }
            Text(point.hint(), color = Sub, fontSize = 12.sp)
            if (canReport) {
                Button(
                    onClick = onCapture,
                    enabled = !uploading,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        when {
                            uploading -> "上报中…"
                            point.reported() -> "重新上报"
                            else -> "拍照上报"
                        }
                    )
                }
            }
        }
    }
}

@Composable
private fun StatusChip(point: SafetyProgressPointDto) {
    val color = when (point.status) {
        "pass" -> FiveGreen
        "fail" -> FiveRed
        "review", "pending" -> FiveYellow
        "error" -> FivePurple
        else -> Sub
    }
    Text(
        point.statusLabel(),
        color = color,
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surface)
            .padding(horizontal = 8.dp, vertical = 3.dp)
    )
}
