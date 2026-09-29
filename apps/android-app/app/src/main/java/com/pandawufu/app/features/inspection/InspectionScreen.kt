package com.pandawufu.app.features.inspection

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
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
import com.pandawufu.app.media.PhotoStore
import com.pandawufu.app.media.WatermarkCamera
import com.pandawufu.app.media.WatermarkSpec
import com.pandawufu.app.media.rememberWatermarkCapture
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.app.ui.designsystem.Txt
import com.pandawufu.shared.model.InspectionNodeDto
import com.pandawufu.shared.model.InspectionRecordRequest
import com.pandawufu.shared.model.toPayload
import com.pandawufu.shared.redline.ConfirmGateway
import com.pandawufu.shared.viewmodel.InspectionViewModel
import kotlinx.coroutines.launch

// 判定三色（与品控页同源，局部声明避免跨包 internal 限制）
private val FiveGreenC = Color(0xFF5BA85B)
private val FiveRedC = Color(0xFFE8584A)
private val FiveYellowC = Color(0xFFF2B233)

@Composable
fun InspectionScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val todayKey = remember { WatermarkCamera.dayKey(System.currentTimeMillis()) }
    val photoStore = remember { PhotoStore(context) }

    val inspVm = remember {
        InspectionViewModel(
            repository = AppModule.inspectionRepository,
            today = null,
            defaultStation = AppModule.storeName,
            nowMs = { System.currentTimeMillis() }
        )
    }
    val state by inspVm.state

    var pendingNodeId by remember { mutableStateOf<String?>(null) }

    val capture = rememberWatermarkCapture(
        onCaptured = { photo, spec ->
            val nodeId = pendingNodeId
            val op = AppModule.displayName ?: AppModule.account ?: "巡检员"
            val node = state.nodes.firstOrNull { it.id == nodeId }
            scope.launch {
                // 1) 本地台账（照片只存手机，服务器不收图）
                val entry = photoStore.record(
                    photo,
                    spec.copy(kind = "巡检", nodeId = nodeId),
                    nodeId = nodeId
                )
                if (entry != null) inspVm.dispatch(InspectionViewModel.InspectionIntent.NoteLocalPhoto(nodeId ?: ""))
                // 2) 上报完成状态（无图片）
                node?.let { enqueueInspectionRecord(it, op, context) }
                inspVm.dispatch(InspectionViewModel.InspectionIntent.Refresh)
                Toast.makeText(
                    context,
                    if (node != null) "已拍照记录：${node.name}" else "已拍照",
                    Toast.LENGTH_SHORT
                ).show()
            }
        },
        onFailed = { msg -> Toast.makeText(context, msg, Toast.LENGTH_SHORT).show() }
    )

    LaunchedEffect(Unit) {
        inspVm.load()
        // 用本地台账把「今天已拍过的点位」合并进完成态
        val done = photoStore.all()
            .filter { it.kind == "巡检" && it.day == todayKey }
            .mapNotNull { it.nodeId }
            .toSet()
        inspVm.dispatch(
            InspectionViewModel.InspectionIntent.SyncLocalPhotos(done, done.size)
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(title = { Text("闭店巡检", fontWeight = FontWeight.Bold) })
        }
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding).padding(horizontal = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            item {
                SummaryCard(
                    updatedAt = state.updatedAt,
                    done = state.overallDone(),
                    total = state.nodes.size,
                    rate = state.overallRate(),
                    photoCount = photoStore.stats().count,
                    localHint = state.emptyHint
                )
            }

            // 板块切换（全店 / 后厨 / 前厅 / 仓库）
            item {
                val boards = listOf<String?>(null) + state.boards.map { it.board }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    boards.forEach { b ->
                        val sel = (b ?: "") == (state.selectedBoard ?: "")
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(10.dp))
                                .background(if (sel) FiveGreenC else CardBg)
                                .clickable {
                                    inspVm.dispatch(InspectionViewModel.InspectionIntent.SelectBoard(b))
                                }
                                .padding(horizontal = 14.dp, vertical = 8.dp)
                        ) {
                            Text(
                                b ?: "全店",
                                color = if (sel) Color.White else Txt,
                                fontWeight = FontWeight.Bold,
                                fontSize = 13.sp
                            )
                        }
                    }
                }
            }

            // 各板块：进度环 + 节点卡
            val boards = state.visibleBoards()
            items(boards) { board ->
                BoardSection(
                    board = board,
                    rate = state.rate(board),
                    missing = state.missingNodes(board).size,
                    nodes = state.nodesOf(board),
                    doneSet = state.doneNodeIds(),
                    onShoot = { node ->
                        pendingNodeId = node.id
                        capture(
                            WatermarkSpec(
                                storeName = AppModule.storeName ?: "本店",
                                pointName = "巡检·${node.name}",
                                operator = AppModule.displayName ?: "巡检员",
                                kind = "巡检"
                            )
                        )
                    }
                )
            }

            item {
                Text(
                    "卫生间类（每 30 分钟一次）替代纸质签到；未按时拍照会在漏项清单中标红。",
                    fontSize = 12.sp,
                    color = Sub
                )
            }
        }
    }
}

@Composable
private fun SummaryCard(
    updatedAt: String?,
    done: Int,
    total: Int,
    rate: Int,
    photoCount: Int,
    localHint: String?
) {
    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = CardBg),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("今日巡检进度", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.ExtraBold)
                updatedAt?.let {
                    Text("　数据更新 $it", fontSize = 11.sp, color = Sub)
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Stat("已完成", "$done/$total")
                Stat("完成率", "$rate%")
                Stat("本地留证", "${photoCount}张")
            }
            if (!localHint.isNullOrBlank()) {
                Text(localHint, fontSize = 12.sp, color = FiveYellowC)
            }
        }
    }
}

@Composable
private fun Stat(label: String, value: String) {
    Column {
        Text(value, fontSize = 18.sp, fontWeight = FontWeight.Bold, color = Txt)
        Text(label, fontSize = 11.sp, color = Sub)
    }
}

@Composable
private fun BoardSection(
    board: String,
    rate: Int,
    missing: Int,
    nodes: List<InspectionNodeDto>,
    doneSet: Set<String>,
    onShoot: (InspectionNodeDto) -> Unit
) {
    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = CardBg),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(contentAlignment = Alignment.Center, modifier = Modifier.size(56.dp)) {
                    CircularProgressIndicator(
                        progress = { rate / 100f },
                        strokeWidth = 5.dp,
                        color = if (rate >= 100) FiveGreenC else FiveYellowC,
                        modifier = Modifier.fillMaxSize()
                    )
                    Text("$rate%", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = Txt)
                }
                Column(Modifier.padding(start = 12.dp)) {
                    Text(board, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                    Text(
                        "漏项 $missing 项",
                        fontSize = 12.sp,
                        color = if (missing > 0) FiveRedC else Sub
                    )
                }
            }
            nodes.forEach { node ->
                NodeCard(node = node, done = node.id in doneSet, onShoot = onShoot)
            }
        }
    }
}

@Composable
private fun NodeCard(
    node: InspectionNodeDto,
    done: Boolean,
    onShoot: (InspectionNodeDto) -> Unit
) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(node.name, fontWeight = FontWeight.Bold, fontSize = 14.sp, color = Txt)
                if (node.every30) {
                    Box(
                        Modifier.padding(start = 6.dp)
                            .clip(RoundedCornerShape(6.dp))
                            .background(Color(0xFFFDF3E0))
                            .padding(horizontal = 6.dp, vertical = 2.dp)
                    ) {
                        Text("每30分钟", fontSize = 10.sp, color = FiveYellowC)
                    }
                }
            }
            Text(node.nodeGroup, fontSize = 11.sp, color = Sub)
        }
        if (done) {
            Text("✓ 已拍照", color = FiveGreenC, fontSize = 12.sp, fontWeight = FontWeight.Bold)
        } else {
            Button(
                onClick = { onShoot(node) },
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier.height(34.dp)
            ) {
                Text(if (node.every30) "立即拍照" else "拍照", fontSize = 12.sp)
            }
        }
    }
}

/** 入队 inspection.record（经 ConfirmGateway；图片不外传，只传完成状态） */
private suspend fun enqueueInspectionRecord(
    node: InspectionNodeDto,
    op: String,
    context: android.content.Context
) {
    runCatching {
        AppModule.ensureSession()
        val rev = runCatching {
            AppModule.bffClient.snapshotLatest().revText().ifBlank { null }
        }.getOrNull()
        val payload = toPayload(
            InspectionRecordRequest(
                nodeId = node.id,
                operator = op,
                photoTaken = true,
                station = AppModule.storeName,
                round = null
            )
        )
        val proposed = ConfirmGateway.shared.propose("inspection.record", payload, baseRev = rev, operator = op)
        ConfirmGateway.shared.confirm(proposed, operator = op, rev = proposed.rev ?: rev)
    }.onFailure {
        Toast.makeText(context, "上报失败：${it.message}", Toast.LENGTH_SHORT).show()
    }
}
