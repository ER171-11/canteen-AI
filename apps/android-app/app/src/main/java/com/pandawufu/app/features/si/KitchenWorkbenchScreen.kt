package com.pandawufu.app.features.si

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.AppModule
import com.pandawufu.app.confirm.ConfirmBus
import com.pandawufu.app.confirm.ConfirmRequest
import com.pandawufu.app.features.modules.KvRow
import com.pandawufu.app.features.modules.ModuleCard
import com.pandawufu.app.features.modules.ModuleScaffold
import com.pandawufu.app.ui.Routes
import com.pandawufu.app.ui.designsystem.AiPink
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.model.KitchenWorkbenchDto
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * 厨师工作台：今日工单 + 每单菜谱标准（工序/关键参数）+ 品控进度；按标准制作与品控。
 */
@Composable
fun KitchenWorkbenchScreen(onOpen: (String) -> Unit = {}) {
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<KitchenWorkbenchDto?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    suspend fun load() {
        loading = true
        error = null
        try {
            AppModule.ensureSession()
            data = AppModule.siRepository.kitchenWorkbench()
        } catch (e: Exception) {
            val fail = com.pandawufu.shared.util.LoadFailure.from(e)
            error = fail.error ?: fail.hint ?: "加载失败"
        } finally {
            loading = false
        }
    }

    LaunchedEffect(Unit) { load() }

    ModuleScaffold(
        title = "厨师工作台",
        subtitle = "按菜谱标准制作 · 按标准品控",
        loading = loading && data == null,
        error = error,
        onRetry = { scope.launch { load() } },
        siSpecialist = "kitchen"
    ) {
        val d = data ?: return@ModuleScaffold

        ModuleCard("今日出品") {
            KvRow("计划份数", "${d.planned.toInt()} 份")
            KvRow("工单数", "${d.workorders.size} 单")
            KvRow("待品控", "${d.qcPending} 单")
            KvRow("菜谱/SOP", "${d.standards?.recipes ?: 0} 道 · ${d.standards?.sopSteps ?: 0} 工序")
            Text(
                "去后厨推进工单/品控 ›",
                color = AiPink, fontWeight = FontWeight.Bold, fontSize = 12.sp,
                modifier = Modifier.padding(top = 4.dp)
            )
        }

        if (d.workorders.isEmpty()) {
            ModuleCard("暂无工单") {
                Text("按本餐缺口建单后，此处显示每单的制作标准（醒发/剂子/成品/点凉水）与品控进度。", color = Sub, fontSize = 12.sp)
            }
        }

        d.workorders.forEach { w ->
            ModuleCard("${w.name ?: w.skuId} × ${w.qty.toInt()} 份 · ${w.status}") {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("工序 ${w.steps} 步", color = Ink, fontWeight = FontWeight.SemiBold)
                    Text(
                        if (w.qcRate != null) "品控 ${w.qcRate}%（${w.qcPass}/${w.qcTotal}）" else "未抽检",
                        color = if (w.qcRate != null && w.qcRate!! < 90) FiveRed else FiveGreen,
                        fontWeight = FontWeight.Bold,
                        fontSize = 12.sp
                    )
                }
                w.params?.let { p ->
                    KvRow("醒发", p.ferment ?: "约30分钟")
                    KvRow("剂子", p.dough ?: "10-11g")
                    KvRow("成品", p.finished ?: "25-27g")
                    KvRow("点凉水", p.water ?: "分三次")
                }
                val canWrite = AppModule.canWrite()
                val next = nextWoStatus(w.status)
                if (canWrite) {
                    Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (next != null) {
                            Button(
                                onClick = {
                                    ConfirmBus.ask(
                                        ConfirmRequest(
                                            title = "推进工单 ${w.id}",
                                            summary = "${w.name ?: w.skuId} ${w.status} → $next",
                                            type = "workorder.advance",
                                            payload = buildJsonObject {
                                                put("id", w.id ?: "")
                                                put("status", next)
                                            },
                                            baseRev = d.rev?.toString(),
                                            onResult = { scope.launch { load() } }
                                        )
                                    )
                                },
                                shape = RoundedCornerShape(10.dp),
                                modifier = Modifier.weight(1f)
                            ) { Text("推进 → $next", fontSize = 12.sp) }
                        }
                        OutlinedButton(
                            onClick = {
                                ConfirmBus.ask(
                                    ConfirmRequest(
                                        title = "品控抽检",
                                        summary = "${w.name ?: w.skuId} · 重量合格（26g 标准 25-27g）",
                                        type = "qc.pass",
                                        payload = buildJsonObject {
                                            put("workorder_id", w.id ?: "")
                                            put("sku_id", w.skuId ?: "")
                                            put("sample_weight", 26)
                                            put("pass", "合格")
                                        },
                                        baseRev = d.rev?.toString(),
                                        onResult = { scope.launch { load() } }
                                    )
                                )
                            },
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.weight(1f)
                        ) { Text("品控合格", fontSize = 12.sp) }
                    }
                }
                Text("对照菜谱标准操作，关键工艺点由 SI 抽查", color = Sub, fontSize = 10.5.sp)
            }
        }

        d.advice.forEach { Text("· $it", color = Sub, fontSize = 11.sp) }
        Text("写操作（推进/扣料/品控）仍走确认台，核心计价零改动。", color = Sub, fontSize = 10.sp)
    }
}

private fun nextWoStatus(status: String): String? = when (status) {
    "待开始" -> "制作中"
    "制作中" -> "待传"
    "待传" -> "已完成"
    else -> null
}
