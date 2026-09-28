package com.pandawufu.app.features.si

import android.widget.Toast
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.AppModule
import com.pandawufu.app.confirm.ConfirmBus
import com.pandawufu.app.confirm.ConfirmRequest
import com.pandawufu.app.features.modules.KvRow
import com.pandawufu.app.features.modules.ModuleCard
import com.pandawufu.app.features.modules.ModuleScaffold
import com.pandawufu.app.ui.designsystem.AiPink
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.model.ProcurementWorkbenchDto
import com.pandawufu.shared.model.RecvWorkbenchDto
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * 采购工作台：按「今日需求 × 菜谱 BOM」算原料缺口 → 一键转采购意向；验收按标准。
 */
@Composable
fun ProcurementWorkbenchScreen(onOpen: (String) -> Unit = {}) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var data by remember { mutableStateOf<ProcurementWorkbenchDto?>(null) }
    var recv by remember { mutableStateOf<RecvWorkbenchDto?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    suspend fun load() {
        loading = true
        error = null
        try {
            AppModule.ensureSession()
            data = AppModule.siRepository.procurementWorkbench()
            recv = runCatching { AppModule.siRepository.recvWorkbench() }.getOrNull()
        } catch (e: Exception) {
            val fail = com.pandawufu.shared.util.LoadFailure.from(e)
            error = fail.error ?: fail.hint ?: "加载失败"
        } finally {
            loading = false
        }
    }

    LaunchedEffect(Unit) { load() }

    ModuleScaffold(
        title = "采购工作台",
        subtitle = "按菜谱与需求下单 · 按标准验收",
        loading = loading && data == null,
        error = error,
        onRetry = { scope.launch { load() } },
        siSpecialist = "procurement"
    ) {
        val d = data ?: return@ModuleScaffold
        val canWrite = AppModule.canWrite()

        ModuleCard("今日需求 → 采购缺口") {
            KvRow("按菜谱需求", "${d.demandTotal.toInt()} 份")
            KvRow("需采购项", "${d.toBuy.size} 项")
            KvRow("预估金额", "¥${d.estTotal.toInt()}")
            if (d.missing.isNotEmpty()) {
                Text("未匹配原料：${d.missing.take(5).joinToString("、")}", color = FiveRed, fontSize = 11.sp)
            }
            if (canWrite && d.toBuy.isNotEmpty()) {
                Button(
                    onClick = {
                        val p = d.restockPayload
                        val items = buildJsonArray {
                            (p?.items ?: emptyList()).forEach { it ->
                                add(buildJsonObject {
                                    put("name", it.name)
                                    put("qty", it.qty)
                                    put("unit", it.unit)
                                    put("price", it.price)
                                })
                            }
                        }
                        ConfirmBus.ask(
                            ConfirmRequest(
                                title = "按需求生成采购单",
                                summary = "${d.toBuy.size} 项 · 预估 ¥${d.estTotal.toInt()}（含菜谱 BOM 推算）",
                                type = "restock.create",
                                payload = buildJsonObject {
                                    put("supplier", p?.supplier ?: "按菜谱需求采购")
                                    put("note", p?.note ?: "采购工作台")
                                    put("items", items)
                                },
                                baseRev = d.rev?.toString(),
                                onResult = { r ->
                                    Toast.makeText(
                                        context,
                                        r.fold({ "已入确认台 · 采购单" }, { it.message ?: "失败" }),
                                        Toast.LENGTH_SHORT
                                    ).show()
                                    if (r.isSuccess) scope.launch { load() }
                                }
                            )
                        )
                    },
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp)
                ) { Text("一键转采购意向（经确认台）") }
            } else if (d.toBuy.isEmpty()) {
                Text("当前库存可覆盖今日需求，无需采购", color = Sub, fontSize = 12.sp)
            }
        }

        ModuleCard("采购清单（需求 / 库存 / 缺口）") {
            if (d.needLines.isEmpty()) {
                Text("暂无需求 · 建今日工单或推送预订/外卖后自动计算", color = Sub, fontSize = 12.sp)
            }
            d.needLines.take(30).forEach { x ->
                Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(x.name, color = Ink, fontWeight = FontWeight.SemiBold)
                    Text(
                        "需 ${trim(x.need)}${x.unit} · 有 ${trim(x.have)} · " +
                            if (x.gap > 0) "缺 ${trim(x.gap)}" else "够",
                        color = if (x.gap > 0) FiveRed else Sub,
                        fontSize = 12.sp
                    )
                }
            }
        }

        ModuleCard("验收标准") {
            Text("验收标准库 ${d.acceptStandards} 条 · 到货按标准验数量/规格/鲜度/批次", color = Ink, fontSize = 12.sp)
            Text(
                "去验货（拍照识别） ›",
                color = AiPink, fontWeight = FontWeight.Bold, fontSize = 12.sp,
                modifier = Modifier.padding(top = 6.dp)
            )
        }

        ModuleCard("到货验收（按标准）") {
            val rv = recv
            if (rv == null || rv.orders.isEmpty()) {
                Text(rv?.note ?: "暂无待到货单 · 采购到货后此处按标准验收", color = Sub, fontSize = 12.sp)
            } else {
                rv.orders.take(10).forEach { o ->
                    val oid = o.id
                    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                        Text("${o.supplier.ifBlank { "供应商" }} · ${o.no ?: oid} · ${o.status}", color = Ink, fontWeight = FontWeight.SemiBold, fontSize = 12.5.sp)
                        o.lines.take(8).forEach { l ->
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text(l.name, color = Ink, fontSize = 11.5.sp)
                                Text(
                                    "${trim(l.qty)}${l.unit}" + (l.specReq?.let { " · 标准 $it" } ?: ""),
                                    color = if (l.specReq != null) Sub else Color(0xFFE4871A),
                                    fontSize = 11.sp
                                )
                            }
                        }
                        if (canWrite && oid != null) {
                            com.pandawufu.app.confirm.KimiRecvCta(
                                recvId = oid,
                                supplier = o.supplier.ifBlank { "供应商" },
                                itemNames = o.lines.map { it.name },
                                baseRev = rv.rev?.toString(),
                                onDone = { scope.launch { load() } }
                            )
                            Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Button(
                                    onClick = {
                                        val items = buildJsonArray {
                                            o.lines.forEach { l ->
                                                add(buildJsonObject {
                                                    put("ing_name", l.name)
                                                    put("qty_received", l.qty)
                                                    put("verdict", "pass")
                                                    put("spec_req", l.specReq ?: "")
                                                })
                                            }
                                        }
                                        ConfirmBus.ask(
                                            ConfirmRequest(
                                                title = "记录到货验收（合格）",
                                                summary = "${o.no ?: oid} · ${o.lines.size} 项按标准合格",
                                                type = "recv.accept",
                                                payload = buildJsonObject {
                                                    put("recv_id", oid)
                                                    put("source", "workbench")
                                                    put("items", items)
                                                },
                                                baseRev = rv.rev?.toString(),
                                                onResult = { r ->
                                                    Toast.makeText(context, r.fold({ "已记录验收" }, { it.message ?: "失败" }), Toast.LENGTH_SHORT).show()
                                                    if (r.isSuccess) scope.launch { load() }
                                                }
                                            )
                                        )
                                    },
                                    shape = RoundedCornerShape(10.dp),
                                    modifier = Modifier.weight(1f)
                                ) { Text("验收合格", fontSize = 12.sp) }
                                OutlinedButton(
                                    onClick = {
                                        ConfirmBus.ask(
                                            ConfirmRequest(
                                                title = "登记入库",
                                                summary = "${o.no ?: oid} → 已入库（改账面，走三向合并）",
                                                type = "recv.inbound",
                                                payload = buildJsonObject {
                                                    put("id", oid)
                                                    put("status", "已入库")
                                                    put("note", "采购工作台·按标准验收")
                                                },
                                                baseRev = rv.rev?.toString(),
                                                onResult = { r ->
                                                    Toast.makeText(context, r.fold({ "已入队入库" }, { it.message ?: "失败" }), Toast.LENGTH_SHORT).show()
                                                    if (r.isSuccess) scope.launch { load() }
                                                }
                                            )
                                        )
                                    },
                                    shape = RoundedCornerShape(10.dp),
                                    modifier = Modifier.weight(1f)
                                ) { Text("登记入库", fontSize = 12.sp) }
                            }
                        }
                    }
                }
                Text("验收标准库 ${rv.standards} 条 · 逐项核对数量/规格/鲜度/批次", color = Sub, fontSize = 10.5.sp)
            }
        }

        Text("缺口 = 今日需求(工单/建议)×菜谱BOM − 现有库存；写操作经确认台。", color = Sub, fontSize = 10.sp)
    }
}

private fun trim(v: Double): String {
    val r = Math.round(v * 100) / 100.0
    return if (r == r.toLong().toDouble()) r.toLong().toString() else r.toString()
}
