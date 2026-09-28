package com.pandawufu.app.features.si

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pandawufu.app.AppModule
import com.pandawufu.app.features.modules.ModuleCard
import com.pandawufu.app.features.modules.ModuleScaffold
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.PandaCard
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.app.ui.designsystem.Txt
import com.pandawufu.shared.model.SimMaterialDto
import com.pandawufu.shared.model.SimRequest
import com.pandawufu.shared.model.SimResultDto
import kotlinx.coroutines.launch

/**
 * SI What-if 模拟：输入假设（份数 / 调价 / 原料涨跌），确定性测算毛利与备料影响。
 * 只读模拟，转采购/调价仍须确认台。
 */
@Composable
fun SimulateScreen() {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    var sku by remember { mutableStateOf("红") }
    var portions by remember { mutableStateOf("500") }
    var priceDelta by remember { mutableStateOf("0") }
    var material by remember { mutableStateOf("") }
    var materialDelta by remember { mutableStateOf("0") }
    var result by remember { mutableStateOf<SimResultDto?>(null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun run() {
        loading = true
        error = null
        scope.launch {
            try {
                AppModule.ensureSession()
                result = AppModule.siRepository.simulate(
                    SimRequest(
                        sku = sku.trim().ifBlank { null },
                        portions = portions.toIntOrNull() ?: 1,
                        priceDeltaPct = priceDelta.toDoubleOrNull() ?: 0.0,
                        materialName = material.trim().ifBlank { null },
                        materialDeltaPct = materialDelta.toDoubleOrNull() ?: 0.0
                    )
                )
            } catch (e: Exception) {
                val fail = com.pandawufu.shared.util.LoadFailure.from(e)
                error = fail.error ?: fail.hint ?: "模拟失败"
                Toast.makeText(context, error, Toast.LENGTH_SHORT).show()
            } finally {
                loading = false
            }
        }
    }

    LaunchedEffect(Unit) { run() }

    ModuleScaffold(
        title = "SI 模拟",
        subtitle = "数字孪生 · 先算后做 · 不落库",
        loading = loading && result == null,
        error = error,
        onRetry = { run() }
    ) {
        ModuleCard("假设") {
            OutlinedTextField(
                value = sku,
                onValueChange = { sku = it },
                label = { Text("菜品 / SKU（可填菜名关键字，如「红」）") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = portions,
                onValueChange = { portions = it },
                label = { Text("做多少份") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(top = 6.dp)
            )
            OutlinedTextField(
                value = priceDelta,
                onValueChange = { priceDelta = it },
                label = { Text("调价 %（正=涨，负=降）") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(top = 6.dp)
            )
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = material,
                    onValueChange = { material = it },
                    label = { Text("原料名（可选）") },
                    singleLine = true,
                    modifier = Modifier.weight(1f)
                )
                OutlinedTextField(
                    value = materialDelta,
                    onValueChange = { materialDelta = it },
                    label = { Text("涨跌 %") },
                    singleLine = true,
                    modifier = Modifier.weight(1f)
                )
            }
            Button(
                onClick = { run() },
                enabled = !loading,
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth().padding(top = 10.dp)
            ) { Text(if (loading) "测算中…" else "跑一次模拟") }
        }

        val r = result
        if (r != null && r.ok) {
            ModuleCard("结果 · ${r.name ?: r.sku}") {
                ResultRow("售价", r.base?.price, r.projected?.price, "元", higherBetter = true)
                ResultRow("单份成本", r.base?.portionCost, r.projected?.portionCost, "元", higherBetter = false)
                ResultRow("毛利率", r.base?.grossMargin, r.projected?.grossMargin, "%", higherBetter = true)
                val d = r.delta
                if (d != null) {
                    Text(
                        "毛利变化 ${signed(d.marginPct)}pct · 单份成本变化 ${signed(d.portionCost)}元 · " +
                            "本批利润变化 ${signed(d.profit)}元",
                        color = when {
                            (d.marginPct ?: 0.0) > 0 -> FiveGreen
                            (d.marginPct ?: 0.0) < 0 -> FiveRed
                            else -> Sub
                        },
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(top = 6.dp)
                    )
                }
            }
            if (r.materialImpact.isNotEmpty()) {
                ModuleCard("原料涨跌影响") {
                    r.materialImpact.forEach { m ->
                        Text("${m.name}：成本 ${signed(m.deltaCost)}元", color = Sub)
                    }
                }
            }
            if (r.materials.isNotEmpty()) {
                ModuleCard("备料需求") {
                    r.materials.forEach { m -> MaterialRow(m) }
                }
            }
            r.note?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = Sub)
            }
        } else if (r != null && !r.ok) {
            PandaCard {
                Text("模拟不了：${r.error ?: "未知原因"}", color = FiveRed, fontWeight = FontWeight.Bold)
                Text("先确认菜谱与采购价齐全，或换个菜品关键字。", color = Sub)
            }
        }
    }
}

@Composable
private fun ResultRow(label: String, base: Double?, proj: Double?, unit: String, higherBetter: Boolean) {
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = Sub)
        Text(
            "${fmtOrDash(base)}$unit → ${fmtOrDash(proj)}$unit",
            fontWeight = FontWeight.Bold,
            color = if (base == null || proj == null) Txt else {
                val better = if (higherBetter) proj >= base else proj <= base
                if (better) FiveGreen else FiveRed
            }
        )
    }
}

@Composable
private fun MaterialRow(m: SimMaterialDto) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(m.name, color = Txt)
        Text("${fmt(m.needKg)}kg", color = Sub)
    }
}

private fun fmtOrDash(v: Double?): String = if (v == null) "—" else fmt(v)

private fun fmt(v: Double): String {
    val r = Math.round(v * 100) / 100.0
    return if (r == r.toLong().toDouble()) r.toLong().toString() else r.toString()
}

private fun signed(v: Double?): String {
    if (v == null) return "—"
    val r = Math.round(v * 100) / 100.0
    return if (r > 0) "+$r" else r.toString()
}
