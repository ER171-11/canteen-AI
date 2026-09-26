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
import com.pandawufu.app.ui.designsystem.AiPink
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.model.VendorDto
import com.pandawufu.shared.viewmodel.InventoryViewModel
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** 供应链：供应商 / 比价 / 账期（原型 p-m-supply） */
@Composable
fun SupplyScreen() {
    val viewModel = remember { InventoryViewModel(AppModule.inventoryRepository) }
    val state by viewModel.state.collectAsState()
    var tab by remember { mutableIntStateOf(0) }
    val pills = listOf("供应商", "报价", "账期")
    LaunchedEffect(Unit) {
        AppModule.ensureSession()
        viewModel.dispatch(InventoryViewModel.InventoryIntent.Refresh)
    }

    fun reload() = viewModel.dispatch(InventoryViewModel.InventoryIntent.Refresh)

    val quotes = state.quotes
    val vendors = state.vendors.ifEmpty {
        state.suppliers.map {
            VendorDto(id = it, name = it, status = "合作中", period = "月结30天")
        }
    }
    val compare = quotes.groupBy { it.name ?: it.ing ?: it.id ?: "-" }
        .map { (name, list) ->
            val best = list.minByOrNull { it.price ?: Double.MAX_VALUE }
            Triple(name, best, list.size)
        }
        .sortedBy { it.second?.price ?: Double.MAX_VALUE }

    ModuleScaffold(
        title = "供应链",
        subtitle = "报价比价 · 供应商档案在「货品」",
        loading = state.loading && state.rev == null,
        error = state.error,
        hint = state.emptyHint,
        onRetry = { reload() },
        empty = false,
        pills = pills,
        selectedPill = tab,
        onPill = { tab = it }
    ) {
        val q = compare.firstOrNull()?.second ?: quotes.firstOrNull()
        WriteActionButton(
            label = "报价转采购",
            type = "supply.po",
            summary = "将 ${q?.name ?: "首选原料"} 最低报价转为采购草稿",
            payload = buildJsonObject {
                put("supplier", q?.src ?: q?.supplier ?: "未指定")
                put("vendor_id", q?.src ?: q?.supplier ?: "")
                put("amount", q?.price ?: 0)
                put("note", "供应链比价转采购")
                put(
                    "items",
                    JsonArray(
                        listOf(
                            buildJsonObject {
                                put("name", q?.name ?: q?.ing ?: "原料")
                                put("ing_id", q?.ing)
                                put("qty", 1)
                                put("price", q?.price ?: 0)
                            }
                        )
                    )
                )
            },
            baseRev = state.rev,
            onSuccess = { reload() }
        )
        when (tab) {
            0 -> {
                if (AppModule.canWrite()) {
                    DraftWriteButton(
                        label = "新增供应商档案",
                        type = "vendor.upsert",
                        fields = mapOf(
                            "名称" to "",
                            "品类" to "综合",
                            "账期" to "月结30天",
                            "联系人" to "",
                            "电话" to ""
                        ),
                        summaryOf = { d -> "${d["名称"]} · ${d["品类"]} · ${d["账期"]}" },
                        buildPayload = { d ->
                            buildJsonObject {
                                put("name", d["名称"] ?: "新供应商")
                                put("category", d["品类"] ?: "综合")
                                put("period", d["账期"] ?: "月结30天")
                                put("contact", d["联系人"] ?: "")
                                put("phone", d["电话"] ?: "")
                                put("status", "合作中")
                            }
                        },
                        baseRev = state.rev,
                        onSuccess = { reload() }
                    )
                }
                if (vendors.isNotEmpty()) {
                    ModuleCard("供应商（${vendors.size}）") {
                        vendors.take(30).forEach { v ->
                            KvRow(
                                v.name,
                                listOfNotNull(v.category, v.period, v.status, v.contact).joinToString(" · ")
                            )
                            if (AppModule.canWrite()) {
                                DraftWriteButton(
                                    label = "改账期 ${v.name}",
                                    type = "vendor.upsert",
                                    fields = mapOf(
                                        "名称" to v.name,
                                        "账期" to (v.period ?: "月结30天"),
                                        "品类" to (v.category ?: "综合"),
                                        "联系人" to (v.contact ?: ""),
                                        "电话" to (v.phone ?: "")
                                    ),
                                    summaryOf = { d -> "${d["名称"]} 账期 → ${d["账期"]}" },
                                    buildPayload = { d ->
                                        buildJsonObject {
                                            put("id", v.resolvedId())
                                            put("vendor_id", v.resolvedId())
                                            put("name", d["名称"] ?: v.name)
                                            put("period", d["账期"] ?: "月结30天")
                                            put("category", d["品类"] ?: v.category ?: "")
                                            put("contact", d["联系人"] ?: "")
                                            put("phone", d["电话"] ?: "")
                                            put("status", v.status ?: "合作中")
                                        }
                                    },
                                    baseRev = state.rev,
                                    onSuccess = { reload() }
                                )
                            }
                        }
                    }
                } else {
                    ModuleCard("供应商") {
                        Text("暂无供应商 · 请新增档案或到「进销存→供应商」", color = Sub, fontSize = 12.sp)
                    }
                }
            }
            1 -> {
                if (AppModule.canWrite()) {
                    DraftWriteButton(
                        label = "录入报价",
                        type = "quote.upsert",
                        fields = mapOf(
                            "原料" to (state.stock.firstOrNull()?.ingredient?.name ?: "面粉"),
                            "原料ID" to (state.stock.firstOrNull()?.ingredient?.id ?: ""),
                            "供应商" to (vendors.firstOrNull()?.name ?: "未指定"),
                            "单价" to "10",
                            "单位" to "斤"
                        ),
                        summaryOf = { d -> "${d["原料"]} @ ${d["供应商"]} ¥${d["单价"]}/${d["单位"]}" },
                        buildPayload = { d ->
                            buildJsonObject {
                                val ingId = d["原料ID"].orEmpty().ifBlank { d["原料"] ?: "" }
                                put("ing", ingId)
                                put("ing_id", ingId)
                                put("name", d["原料"] ?: "")
                                put("src", d["供应商"] ?: "")
                                put("supplier", d["供应商"] ?: "")
                                put("price", d["单价"]?.toDoubleOrNull() ?: 0.0)
                                put("per", d["单位"] ?: "buy")
                                put("unit", d["单位"] ?: "")
                                put("set_default_sup", true)
                            }
                        },
                        baseRev = state.rev,
                        onSuccess = { reload() }
                    )
                }
                ModuleCard("比价（${compare.size} 项）") {
                    if (compare.isEmpty()) Text("暂无报价 · 点上方录入", color = Sub, fontSize = 12.sp)
                    compare.take(30).forEach { (name, best, n) ->
                        KvRow(
                            name,
                            listOfNotNull(
                                best?.src ?: best?.supplier,
                                best?.price?.let { "最低 ¥$it" },
                                best?.per ?: best?.unit,
                                if (n > 1) "${n}家" else null
                            ).joinToString(" · ")
                        )
                        if (n > 1) {
                            Text("已选最低价源", color = AiPink, fontSize = 11.sp)
                        }
                    }
                }
            }
            else -> ModuleCard("账期（真字段）") {
                if (vendors.isEmpty()) {
                    Text("暂无供应商账期，请先建档", color = Sub, fontSize = 12.sp)
                }
                vendors.take(30).forEach { v ->
                    val period = v.period?.ifBlank { null } ?: "月结30天"
                    val hint = when {
                        period.contains("现") || period.contains("7") -> "现结优先"
                        period.contains("周") || period.contains("15") -> "周结"
                        else -> "月结"
                    }
                    KvRow(v.name, "$period · $hint")
                }
                Text("改账期请到「供应商」Tab 点对应供应商。", color = Sub, fontSize = 11.sp)
            }
        }
    }
}
