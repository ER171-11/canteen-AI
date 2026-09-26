package com.pandawufu.app.features.modules

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.sp
import com.pandawufu.app.AppModule
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.viewmodel.ModulesViewModel
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** 食安：日常留样/消毒优先，证照/溯源垫后 */
@Composable
fun FoodsafeScreen() {
    val viewModel = remember { ModulesViewModel(AppModule.modulesRepository) }
    val state by viewModel.state.collectAsState()
    var tab by remember { mutableIntStateOf(ModuleEntry.consumePill(0)) }
    val pills = listOf("留样", "消毒", "证照", "溯源")

    LaunchedEffect(Unit) {
        AppModule.ensureSession()
        viewModel.dispatch(ModulesViewModel.Intent.LoadFoodsafe)
    }

    fun reload() = viewModel.dispatch(ModulesViewModel.Intent.LoadFoodsafe)

    val fs = state.foodsafe
    ModuleScaffold(
        title = "食安",
        subtitle = when (tab) {
            0 -> "留样 48h · 每餐登记"
            1 -> "区域消毒 · 日常台账"
            2 -> "证照有效期 · 可续期"
            else -> "批次/供应商/检验"
        },
        loading = state.loading && fs == null,
        error = state.error,
        hint = state.emptyHint,
        onRetry = { reload() },
        pills = pills,
        selectedPill = tab,
        onPill = { tab = it }
    ) {
        when (tab) {
            0 -> {
                DraftWriteButton(
                    label = "登记留样",
                    type = "sample.log",
                    fields = mapOf(
                        "餐次" to "午餐",
                        "菜品" to (fs?.samples?.firstOrNull()?.dish ?: "五福饺"),
                        "克重" to "125",
                        "保管人" to (AppModule.displayName ?: AppModule.account ?: "老板")
                    ),
                    summaryOf = { d -> "${d["餐次"]}留样 ${d["菜品"]} ${d["克重"]}g" },
                    buildPayload = { d ->
                        buildJsonObject {
                            put("meal", d["餐次"] ?: "午餐")
                            put("dish", d["菜品"] ?: "五福饺")
                            put("weight_g", d["克重"]?.toIntOrNull() ?: 125)
                            put("keeper", d["保管人"] ?: (AppModule.account ?: "老板"))
                        }
                    },
                    baseRev = fs?.rev?.toString(),
                    onSuccess = { reload() }
                )
                ModuleCard("留样 48h（${fs?.samples?.size ?: 0}）") {
                    val list = fs?.samples.orEmpty()
                    if (list.isEmpty()) Text("暂无留样 · 点上方登记", color = Sub, fontSize = 12.sp)
                    list.take(12).forEach { s ->
                        val left = s.hoursLeft?.let { "${it}h" } ?: "-"
                        KvRow("${s.date ?: "-"} ${s.dish ?: "-"}", "余 $left · ${s.keeper ?: ""}")
                    }
                }
            }
            1 -> {
                DraftWriteButton(
                    label = "登记消毒",
                    type = "fs.disinfect",
                    fields = mapOf(
                        "区域" to "餐具区",
                        "方式" to "高温",
                        "操作人" to (AppModule.displayName ?: AppModule.account ?: "老板")
                    ),
                    summaryOf = { d -> "${d["区域"]} · ${d["方式"]}消毒" },
                    buildPayload = { d ->
                        buildJsonObject {
                            put("area", d["区域"] ?: "餐具区")
                            put("method", d["方式"] ?: "高温")
                            put("operator", d["操作人"] ?: (AppModule.account ?: "老板"))
                        }
                    },
                    baseRev = fs?.rev?.toString(),
                    onSuccess = { reload() }
                )
                ModuleCard("消毒（${fs?.disinfect?.size ?: 0}）") {
                    val list = fs?.disinfect.orEmpty()
                    if (list.isEmpty()) Text("暂无消毒记录 · 点上方登记", color = Sub, fontSize = 12.sp)
                    list.take(12).forEach { d ->
                        KvRow(d.area ?: "-", "${d.method ?: ""} · ${d.result ?: ""} · ${d.ts ?: d.date ?: ""}")
                    }
                }
            }
            2 -> {
                DraftWriteButton(
                    label = "登记/续期证照",
                    type = "fs.cert.upsert",
                    fields = mapOf(
                        "类型" to (fs?.certs?.firstOrNull()?.certType ?: "食品经营许可"),
                        "持证人" to (fs?.certs?.firstOrNull()?.holder ?: "本店"),
                        "证号" to (fs?.certs?.firstOrNull()?.certNo ?: ""),
                        "到期日" to (fs?.certs?.firstOrNull()?.expireAt ?: "2027-12-31"),
                        "状态" to "有效"
                    ),
                    summaryOf = { d -> "${d["类型"]} · ${d["持证人"]} · 至 ${d["到期日"]}" },
                    buildPayload = { d ->
                        buildJsonObject {
                            put("cert_type", d["类型"] ?: "食品经营许可")
                            put("holder", d["持证人"] ?: "本店")
                            put("cert_no", d["证号"] ?: "")
                            put("expire_at", d["到期日"] ?: "")
                            put("status", d["状态"] ?: "有效")
                        }
                    },
                    baseRev = fs?.rev?.toString(),
                    onSuccess = { reload() }
                )
                ModuleCard("证照（${fs?.certs?.size ?: 0}）") {
                    val list = fs?.certs.orEmpty()
                    if (list.isEmpty()) Text("暂无证照 · 点上方登记", color = Sub, fontSize = 12.sp)
                    list.take(15).forEach { c ->
                        KvRow(
                            "${c.certType ?: "-"} · ${c.holder ?: "-"}",
                            listOfNotNull(c.status, c.expireAt?.let { "至 $it" }, c.certNo).joinToString(" · ")
                        )
                        val cid = c.id
                        if (cid != null && AppModule.canWrite()) {
                            DraftWriteButton(
                                label = "续期 ${c.certType ?: ""}",
                                type = "fs.cert.upsert",
                                fields = mapOf(
                                    "类型" to (c.certType ?: "证照"),
                                    "持证人" to (c.holder ?: "本店"),
                                    "证号" to (c.certNo ?: ""),
                                    "到期日" to (c.expireAt ?: "2027-12-31"),
                                    "状态" to "有效"
                                ),
                                summaryOf = { d -> "续期 ${d["类型"]} → ${d["到期日"]}" },
                                buildPayload = { d ->
                                    buildJsonObject {
                                        put("id", cid)
                                        put("cert_type", d["类型"] ?: c.certType ?: "")
                                        put("holder", d["持证人"] ?: c.holder ?: "")
                                        put("cert_no", d["证号"] ?: c.certNo ?: "")
                                        put("expire_at", d["到期日"] ?: "")
                                        put("status", d["状态"] ?: "有效")
                                    }
                                },
                                baseRev = fs?.rev?.toString(),
                                onSuccess = { reload() }
                            )
                        }
                    }
                }
            }
            else -> {
                ModuleCard("扫码溯源") {
                    Text("对准食材包装 · 查询进货批次 / 供应商 / 检验报告", color = Sub, fontSize = 12.sp)
                    DraftWriteButton(
                        label = "模拟扫码查批次",
                        type = "fs.trace_scan",
                        fields = mapOf(
                            "批次" to (fs?.trace?.firstOrNull()?.batch
                                ?: fs?.trace?.firstOrNull()?.batchNo
                                ?: "LOT${System.currentTimeMillis() % 100000}"),
                            "原料" to (fs?.trace?.firstOrNull()?.name
                                ?: fs?.trace?.firstOrNull()?.ingName
                                ?: "猪前肩肉"),
                            "供应商" to (fs?.trace?.firstOrNull()?.supplier ?: "张记食材")
                        ),
                        summaryOf = { d -> "扫码溯源 ${d["原料"]} · ${d["批次"]}" },
                        buildPayload = { d ->
                            buildJsonObject {
                                put("batch", d["批次"] ?: "")
                                put("name", d["原料"] ?: "")
                                put("supplier", d["供应商"] ?: "")
                                put("check_result", "合格")
                                put("note", "App 扫码溯源")
                            }
                        },
                        baseRev = fs?.rev?.toString(),
                        onSuccess = { reload() }
                    )
                }
                ModuleCard("溯源（${fs?.trace?.size ?: 0}）") {
                    val list = fs?.trace.orEmpty()
                    if (list.isEmpty()) Text("暂无溯源", color = Sub, fontSize = 12.sp)
                    list.take(12).forEach { t ->
                        KvRow(
                            t.name ?: t.ingName ?: "-",
                            listOfNotNull(
                                t.supplier,
                                t.batch ?: t.batchNo,
                                t.checkResult
                            ).joinToString(" · ")
                        )
                    }
                }
            }
        }
    }
}
