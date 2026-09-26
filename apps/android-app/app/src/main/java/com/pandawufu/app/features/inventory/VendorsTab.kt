package com.pandawufu.app.features.inventory

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.AppModule
import com.pandawufu.app.confirm.ConfirmBus
import com.pandawufu.app.confirm.ConfirmRequest
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FiveYellow
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.Line
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.shared.model.VendorDto
import com.pandawufu.shared.viewmodel.InventoryViewModel
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private val PERIOD_OPTS = listOf("月结30天", "月结15天", "周结", "现结", "货到付款")
private val CAT_OPTS = listOf("蔬果", "肉类", "干调", "冷链", "包材", "综合", "其他")
private val STATUS_OPTS = listOf("合作中", "暂停", "黑名单")

/**
 * 进销存 · 供应商库：档案是智能进货/对账/结算的主数据。
 * 写走 vendor.upsert → 确认台 → 店内 sup_vendors + data.vendors。
 */
@Composable
fun VendorsTab(
    state: InventoryViewModel.InventoryState,
    onRefresh: () -> Unit = {}
) {
    val context = LocalContext.current
    if (state.loading && state.vendors.isEmpty() && state.suppliers.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        return
    }

    var query by remember { mutableStateOf("") }
    var showEditor by remember { mutableStateOf(false) }
    var editTarget by remember { mutableStateOf<VendorDto?>(null) }

    val list = remember(state.vendors, state.suppliers) {
        state.vendors.ifEmpty {
            state.suppliers.map { VendorDto(id = it, name = it, status = "合作中", period = "月结30天") }
        }
    }
    val filtered = remember(list, query) {
        val q = query.trim()
        list.filter {
            q.isEmpty() ||
                it.name.contains(q, ignoreCase = true) ||
                (it.contact?.contains(q) == true) ||
                (it.phone?.contains(q) == true) ||
                (it.category?.contains(q) == true)
        }.sortedBy { it.name }
    }

    if (showEditor) {
        VendorEditDialog(
            initial = editTarget,
            baseRev = state.rev,
            onDismiss = { showEditor = false; editTarget = null },
            onSubmitted = {
                showEditor = false
                editTarget = null
                onRefresh()
            }
        )
    }

    LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Card(
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text("供应商库", fontWeight = FontWeight.ExtraBold, fontSize = 16.sp, color = Ink)
                            Text(
                                "共 ${list.size} 家 · 筛选 ${filtered.size} · 支撑下单/对账",
                                fontSize = 12.sp,
                                color = Sub
                            )
                        }
                        if (AppModule.canWrite()) {
                            Box(
                                Modifier
                                    .clip(RoundedCornerShape(12.dp))
                                    .background(Ink)
                                    .clickable {
                                        editTarget = null
                                        showEditor = true
                                    }
                                    .padding(horizontal = 14.dp, vertical = 10.dp)
                            ) {
                                Text("+ 新增供应商", color = CardBg, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                            }
                        }
                    }
                    Text(
                        "原料挂供应商 → 采购带往来账 → 后期可对账结算。产品库里的「供应商」字段建议从这里选。",
                        fontSize = 12.sp,
                        color = Sub
                    )
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        label = { Text("搜索名称 / 联系人 / 电话 / 品类") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    if (!AppModule.canWrite()) {
                        Text("只读账号可浏览，不可新增/编辑。", color = FiveYellow, fontSize = 12.sp)
                    }
                }
            }
        }

        if (filtered.isEmpty()) {
            item {
                Card(
                    shape = RoundedCornerShape(14.dp),
                    colors = CardDefaults.cardColors(containerColor = CardBg),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            if (list.isEmpty()) "暂无供应商 · 先建档，再挂原料默认供应商"
                            else "无匹配",
                            color = Sub
                        )
                    }
                }
            }
        }

        items(filtered, key = { it.resolvedId() }) { v ->
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg),
                modifier = Modifier
                    .fillMaxWidth()
                    .then(
                        if (AppModule.canWrite()) Modifier.clickable {
                            editTarget = v
                            showEditor = true
                        } else Modifier
                    )
            ) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(v.name, fontWeight = FontWeight.Bold, fontSize = 15.sp, color = Ink, modifier = Modifier.weight(1f))
                        Text(v.status ?: "合作中", color = FiveGreen, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                    }
                    Text(
                        listOfNotNull(
                            v.category,
                            v.period,
                            v.contact?.let { "联系人 $it" },
                            v.phone
                        ).joinToString(" · ").ifBlank { "未完善档案" },
                        fontSize = 12.sp,
                        color = Sub
                    )
                    if (!v.note.isNullOrBlank()) {
                        Text(v.note!!, fontSize = 11.sp, color = Sub)
                    }
                    if (AppModule.canWrite()) {
                        Text("点按编辑 ›", color = FiveGreen, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}

@Composable
private fun VendorEditDialog(
    initial: VendorDto?,
    baseRev: String?,
    onDismiss: () -> Unit,
    onSubmitted: () -> Unit
) {
    val context = LocalContext.current
    var name by remember { mutableStateOf(initial?.name ?: "") }
    var category by remember { mutableStateOf(initial?.category ?: "综合") }
    var contact by remember { mutableStateOf(initial?.contact ?: "") }
    var phone by remember { mutableStateOf(initial?.phone ?: "") }
    var period by remember { mutableStateOf(initial?.period ?: "月结30天") }
    var status by remember { mutableStateOf(initial?.status ?: "合作中") }
    var note by remember { mutableStateOf(initial?.note ?: "") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(if (initial == null) "新增供应商" else "编辑 · ${initial.name}", fontWeight = FontWeight.Bold)
        },
        text = {
            Column(
                Modifier
                    .fillMaxWidth()
                    .heightIn(max = 460.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text("档案供采购挂靠、往来账对账与结算使用。", color = Sub, fontSize = 12.sp)
                OutlinedTextField(
                    value = name, onValueChange = { name = it },
                    label = { Text("供应商名称") }, singleLine = true, modifier = Modifier.fillMaxWidth()
                )
                ChipRow("品类", CAT_OPTS, category) { category = it }
                ChipRow("账期", PERIOD_OPTS, period) { period = it }
                ChipRow("状态", STATUS_OPTS, status) { status = it }
                OutlinedTextField(
                    value = contact, onValueChange = { contact = it },
                    label = { Text("联系人") }, singleLine = true, modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = phone, onValueChange = { phone = it },
                    label = { Text("电话") }, singleLine = true, modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = note, onValueChange = { note = it },
                    label = { Text("备注（配送要求/资质等）") }, singleLine = true, modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            TextButton(onClick = {
                if (!AppModule.canWrite()) {
                    Toast.makeText(context, "只读账号不可改供应商库", Toast.LENGTH_SHORT).show()
                    return@TextButton
                }
                val n = name.trim()
                if (n.isEmpty()) {
                    Toast.makeText(context, "请填写供应商名称", Toast.LENGTH_SHORT).show()
                    return@TextButton
                }
                ConfirmBus.ask(
                    ConfirmRequest(
                        title = if (initial == null) "新增供应商" else "更新供应商",
                        summary = "$n · $category · $period · $status",
                        type = "vendor.upsert",
                        payload = buildJsonObject {
                            initial?.resolvedId()?.takeIf { it.isNotBlank() && it != n }?.let {
                                put("vendor_id", it)
                                put("id", it)
                            }
                            put("name", n)
                            put("category", category)
                            put("period", period)
                            put("status", status)
                            if (contact.isNotBlank()) put("contact", contact.trim())
                            if (phone.isNotBlank()) put("phone", phone.trim())
                            if (note.isNotBlank()) put("note", note.trim())
                        },
                        baseRev = baseRev,
                        onResult = { r ->
                            Toast.makeText(
                                context,
                                if (r.isSuccess) "已入队：供应商 $n" else r.exceptionOrNull()?.message ?: "失败",
                                Toast.LENGTH_SHORT
                            ).show()
                            if (r.isSuccess) onSubmitted()
                        }
                    )
                )
            }) { Text("确认台提交", fontWeight = FontWeight.Bold, color = FiveGreen) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}

@Composable
private fun ChipRow(label: String, opts: List<String>, selected: String, onSelect: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, fontSize = 12.sp, color = Sub)
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            opts.forEach { c ->
                val on = selected == c
                Box(
                    Modifier
                        .clip(RoundedCornerShape(12.dp))
                        .background(if (on) Ink else CardBg)
                        .then(if (!on) Modifier.border(1.dp, Line, RoundedCornerShape(12.dp)) else Modifier)
                        .clickable { onSelect(c) }
                        .padding(horizontal = 10.dp, vertical = 6.dp)
                ) {
                    Text(c, color = if (on) CardBg else Ink, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}
