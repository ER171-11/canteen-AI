package com.pandawufu.app.features.modules

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import android.widget.Toast
import com.pandawufu.app.AppModule
import com.pandawufu.app.confirm.ConfirmBus
import com.pandawufu.app.confirm.ConfirmRequest
import com.pandawufu.app.ui.designsystem.CardHeader
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.PageBg
import com.pandawufu.app.ui.designsystem.AppBgBrush
import com.pandawufu.app.ui.designsystem.PandaCard
import com.pandawufu.app.ui.designsystem.ProtoKv
import com.pandawufu.app.ui.designsystem.SmoothPane
import com.pandawufu.app.ui.designsystem.SoftRefreshBar
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.app.ui.designsystem.Txt
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** 子页返回：由 AppNav 注入，主 Tab 为 null */
val LocalModuleBack = staticCompositionLocalOf<(() -> Unit)?> { null }

@Composable
fun ModuleScaffold(
    title: String,
    loading: Boolean,
    error: String?,
    empty: Boolean = false,
    emptyText: String = "暂无本店数据 · 写操作仍可提交草案",
    subtitle: String = "数据来自店内快照 · 改数经确认台",
    pills: List<String> = emptyList(),
    selectedPill: Int = 0,
    onPill: ((Int) -> Unit)? = null,
    hint: String? = null,
    onRetry: (() -> Unit)? = null,
    /** 显式声明已有缓存；默认在首次成功加载后自动开启轻刷新 */
    hasCachedBody: Boolean = false,
    /** SI 专家结论卡：显式指定专家域；null=按标题自动匹配；""=不显示 */
    siSpecialist: String? = null,
    content: @Composable ColumnScope.() -> Unit
) {
    val onBack = LocalModuleBack.current
    var warmed by remember { mutableStateOf(false) }
    LaunchedEffect(loading, error) {
        if (!loading && error == null) warmed = true
    }
    val softLoading = loading && (hasCachedBody || warmed)
    val coldLoading = loading && !softLoading && error == null && hint == null
    Column(
        Modifier
            .fillMaxSize()
            .background(AppBgBrush)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = com.pandawufu.app.ui.designsystem.PagePadH, vertical = com.pandawufu.app.ui.designsystem.PagePadTop)
            .padding(bottom = com.pandawufu.app.ui.designsystem.PageBottomInset),
        verticalArrangement = Arrangement.spacedBy(com.pandawufu.app.ui.designsystem.SectionGap)
    ) {
        com.pandawufu.app.ui.designsystem.BrandBar(
            title = title,
            subtitle = subtitle,
            onBack = onBack
        )
        if (pills.isNotEmpty() && onPill != null) {
            com.pandawufu.app.features.kitchen.PillTabRow(
                tabs = pills,
                selected = selectedPill,
                onSelect = onPill
            )
        }
        SoftRefreshBar(active = softLoading)
        val verdict = siSpecialist ?: siSpecialistFor(title)
        if (verdict != null && verdict.isNotEmpty()) {
            SiVerdictCard(verdict)
        }
        when {
            error != null || hint != null ->
                com.pandawufu.app.ui.designsystem.LoadStatusBanner(
                    error = error,
                    hint = hint ?: if (error != null) "可点重试；无快照时模块会空开，推送后刷新" else null,
                    onRetry = onRetry
                )
            coldLoading -> com.pandawufu.app.ui.designsystem.ModuleSkeleton()
        }
        // 有硬错仍尽量展示内容（空态/缓存），避免整页死门
        if (empty && !loading) {
            com.pandawufu.app.ui.designsystem.EmptyState(
                title = "暂无本店数据",
                hint = emptyText,
                actionLabel = if (onRetry != null) "刷新" else null,
                onAction = onRetry
            )
        }
        SmoothPane(key = selectedPill, modifier = Modifier.fillMaxWidth()) {
            Column(
                verticalArrangement = Arrangement.spacedBy(12.dp),
                content = content
            )
        }
    }
}

/** 按模块标题自动匹配 SI 专家域；未识别返回 null（不显示结论卡） */
internal fun siSpecialistFor(title: String): String? = when {
    title.contains("设备") -> "equipment"
    title.contains("食安") -> "foodsafe"
    title.contains("供应链") -> "procurement"
    title.contains("库存") || title.contains("缺货") || title.contains("补货") || title.contains("入库") -> "procurement"
    title.contains("外卖") || title.contains("预订") || title.contains("排队") || title.contains("口碑") -> "traffic"
    title.contains("会员") -> "marketing"
    title.contains("财务") || title.contains("损耗") -> "finance"
    title.contains("经营分析") || title.contains("排班") || title.contains("堂食") -> "all"
    title.contains("后厨") || title.contains("菜谱") -> "kitchen"
    else -> null
}

@Composable
fun ModuleCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    PandaCard {
        CardHeader(title)
        content()
    }
}

@Composable
fun KvRow(label: String, value: String) {
    ProtoKv(label, value)
}

/**
 * 统一写入口：老板/店长可点 → ConfirmSheet → actions 队列。
 * 无写权限时显示只读提示按钮。
 */
@Composable
fun WriteActionButton(
    label: String,
    type: String,
    summary: String,
    payload: JsonObject = buildJsonObject {},
    baseRev: String? = null,
    enabled: Boolean = true,
    onSuccess: (() -> Unit)? = null
) {
    val context = LocalContext.current
    val can = AppModule.canWrite() && enabled
    if (can) {
        Button(
            onClick = {
                ConfirmBus.ask(
                    ConfirmRequest(
                        title = label,
                        summary = summary,
                        type = type,
                        payload = payload,
                        baseRev = baseRev,
                        onResult = { r ->
                            Toast.makeText(
                                context,
                                r.fold({ "已确认 · ${it.id}" }, { it.message ?: "失败" }),
                                Toast.LENGTH_SHORT
                            ).show()
                            if (r.isSuccess) onSuccess?.invoke()
                        }
                    )
                )
            },
            shape = RoundedCornerShape(20.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Ink, contentColor = Color.White),
            modifier = Modifier.fillMaxWidth()
        ) { Text(label, fontWeight = FontWeight.Bold) }
    } else {
        OutlinedButton(
            onClick = {
                Toast.makeText(context, "当前角色无写权限（需老板/店长）", Toast.LENGTH_SHORT).show()
            },
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.fillMaxWidth()
        ) { Text("$label（只读）") }
    }
}

fun jsonStr(key: String, value: String) = buildJsonObject { put(key, value) }

/**
 * 先弹草稿对话框再进确认台，避免硬编码金额/设备名。
 * fields: label → 初始值；确认后回调 build(payloadMap)
 */
@Composable
fun DraftWriteButton(
    label: String,
    type: String,
    fields: Map<String, String>,
    summaryOf: (Map<String, String>) -> String,
    buildPayload: (Map<String, String>) -> JsonObject,
    baseRev: String? = null,
    onSuccess: (() -> Unit)? = null
) {
    val context = LocalContext.current
    var open by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf(fields) }
    val can = AppModule.canWrite()

    if (can) {
        Button(
            onClick = {
                draft = fields
                open = true
            },
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.fillMaxWidth()
        ) { Text(label) }
    } else {
        OutlinedButton(
            onClick = {
                Toast.makeText(context, "当前角色无写权限（需老板/店长）", Toast.LENGTH_SHORT).show()
            },
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.fillMaxWidth()
        ) { Text("$label（只读）") }
    }

    if (open) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { open = false },
            title = { Text(label) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    fields.keys.forEach { key ->
                        androidx.compose.material3.OutlinedTextField(
                            value = draft[key] ?: "",
                            onValueChange = { v -> draft = draft + (key to v) },
                            label = { Text(key) },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        open = false
                        ConfirmBus.ask(
                            ConfirmRequest(
                                title = label,
                                summary = summaryOf(draft),
                                type = type,
                                payload = buildPayload(draft),
                                baseRev = baseRev,
                                onResult = { r ->
                                    Toast.makeText(
                                        context,
                                        r.fold({ "已确认 · ${it.id}" }, { it.message ?: "失败" }),
                                        Toast.LENGTH_SHORT
                                    ).show()
                                    if (r.isSuccess) onSuccess?.invoke()
                                }
                            )
                        )
                    }
                ) { Text("下一步确认") }
            },
            dismissButton = {
                OutlinedButton(onClick = { open = false }) { Text("取消") }
            }
        )
    }
}
