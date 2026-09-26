package com.pandawufu.app.confirm

import android.graphics.Bitmap
import android.util.Base64
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pandawufu.app.AppModule
import com.pandawufu.app.ui.designsystem.AiPurple
import com.pandawufu.app.ui.designsystem.Sub
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream

/**
 * Kimi 六用例 CTA：优先调起相机拍照；用户取消/失败则走空图文字降级，并明示「无照片降级」。
 * type 映射：recv / stock / qc / plate / sample / uniform
 */
data class KimiCtaSpec(
    val label: String,
    val subtitle: String,
    val kimiType: String,
    val actionType: String,
    val defaultSummary: String,
    val buildPayload: (conclusion: String) -> kotlinx.serialization.json.JsonObject
)

val KIMI_SPECS = listOf(
    KimiCtaSpec(
        label = "📷 拍照验货",
        subtitle = "送货单/实物 · 核对数量·鲜度·规格",
        kimiType = "recv",
        actionType = "recv.inbound",
        defaultSummary = "确认验货入库",
        buildPayload = { c ->
            buildJsonObject {
                put("note", c)
                put("status", "待核对")
                put("supplier", "Kimi验货")
                put("source", "kimi")
                put("kimi_draft", true)
            }
        }
    ),
    KimiCtaSpec(
        label = "📷 库存盘点",
        subtitle = "货架拍照 · 确认盘点差异",
        kimiType = "stock",
        actionType = "stock.count",
        defaultSummary = "确认盘点差异入账",
        buildPayload = { c ->
            buildJsonObject {
                put("name", "Kimi盘点")
                put("note", c)
                put("source", "kimi_stock")
                put("kimi_draft", true)
            }
        }
    ),
    KimiCtaSpec(
        label = "📷 拍成品照",
        subtitle = "褶纹/色泽/形态/重量估值",
        kimiType = "qc",
        actionType = "qc.pass",
        defaultSummary = "成品品控合格登记",
        buildPayload = { c ->
            buildJsonObject {
                put("pass", true)
                put("sku_id", "kimi")
                put("note", c)
            }
        }
    ),
    KimiCtaSpec(
        label = "📷 装盘核查",
        subtitle = "出餐装盘标准核对",
        kimiType = "plate",
        actionType = "plate.pass",
        defaultSummary = "装盘合格登记",
        buildPayload = { c ->
            buildJsonObject {
                put("pass", true)
                put("sku_id", "plate")
                put("note", c)
            }
        }
    ),
    KimiCtaSpec(
        label = "📷 留样拍照",
        subtitle = "125g/48h 留样登记",
        kimiType = "sample",
        actionType = "sample.log",
        defaultSummary = "留样登记",
        buildPayload = { c ->
            buildJsonObject {
                put("meal", "午餐")
                put("dish", "Kimi留样")
                put("weight_g", 125)
                put("keeper", "Kimi")
                put("note", c)
            }
        }
    ),
    KimiCtaSpec(
        label = "📷 工服检查",
        subtitle = "工服/帽/口罩合规",
        kimiType = "uniform",
        actionType = "uniform.log",
        defaultSummary = "工服合规登记",
        buildPayload = { c ->
            buildJsonObject {
                put("pass", true)
                put("course", "工服合规")
                put("note", c)
            }
        }
    )
)

private fun bitmapToBase64(bitmap: Bitmap): String {
    val stream = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.JPEG, 70, stream)
    return Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
}

@Composable
fun KimiCtaCard(spec: KimiCtaSpec, baseRev: String? = null) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var pendingAfterCapture by remember { mutableStateOf(false) }

    fun runVision(imageBase64: String, degraded: Boolean) {
        busy = true
        scope.launch {
            val conclusion = try {
                AppModule.ensureSession()
                val resp = AppModule.kimiRepository.callVision(
                    type = spec.kimiType,
                    imageBase64 = imageBase64,
                    ctx = mapOf(
                        "source" to "android-cta",
                        "degraded" to if (degraded) "1" else "0"
                    )
                )
                val r = resp.result
                val body = listOfNotNull(r?.title, r?.note, r?.cta, r?.conf.takeIf { !it.isNullOrBlank() })
                    .filter { it.isNotBlank() }
                    .joinToString(" · ")
                    .ifBlank { resp.error ?: spec.defaultSummary }
                if (degraded) "【无照片·文字降级】$body" else body
            } catch (e: Exception) {
                val msg = "${spec.defaultSummary}（离线降级：${e.message ?: "无 Key"}）"
                if (degraded) "【无照片·文字降级】$msg" else msg
            }
            // 验货/盘点：识别结论进确认台；无实盘数/无进货单时消费器仅审计登记（不空改账面）
            ConfirmBus.ask(
                ConfirmRequest(
                    title = spec.label,
                    summary = conclusion + when (spec.actionType) {
                        "stock.count" -> "\n\n无实盘数时仅登记审计，不改账面；补数量请到「库存→录入实盘」。"
                        "recv.inbound" -> "\n\n无进货明细时仅登记验货审计；真入库请到「进销→入库」选单确认。"
                        else -> ""
                    },
                    type = spec.actionType,
                    payload = spec.buildPayload(conclusion),
                    baseRev = baseRev,
                    onResult = { r ->
                        Toast.makeText(
                            context,
                            r.fold({
                                when (it.status) {
                                    com.pandawufu.shared.model.ActionStatus.EXECUTED -> "店内已执行 · ${it.id}"
                                    else -> "已提交 · ${it.id}"
                                }
                            }, { it.message ?: "失败" }),
                            Toast.LENGTH_SHORT
                        ).show()
                    }
                )
            )
            busy = false
        }
    }

    val cameraLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicturePreview()
    ) { bitmap ->
        if (!pendingAfterCapture) return@rememberLauncherForActivityResult
        pendingAfterCapture = false
        if (bitmap != null) {
            runVision(bitmapToBase64(bitmap), degraded = false)
        } else {
            Toast.makeText(context, "未拍到照片，改用文字降级结论", Toast.LENGTH_SHORT).show()
            runVision("", degraded = true)
        }
    }

    val cameraPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            pendingAfterCapture = true
            try {
                cameraLauncher.launch(null)
            } catch (e: Exception) {
                pendingAfterCapture = false
                Toast.makeText(context, "相机不可用：${e.message ?: "改用降级"}", Toast.LENGTH_SHORT).show()
                runVision("", degraded = true)
            }
        } else {
            Toast.makeText(context, "未授权相机，改用无照片文字降级", Toast.LENGTH_SHORT).show()
            runVision("", degraded = true)
        }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .border(1.dp, AiPurple, RoundedCornerShape(14.dp))
            .clickable(enabled = !busy && AppModule.canWrite()) {
                cameraPermission.launch(android.Manifest.permission.CAMERA)
            }
            .padding(18.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            if (busy) "识别中…" else spec.label,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Bold,
            color = AiPurple
        )
        Text(spec.subtitle, style = MaterialTheme.typography.bodySmall, color = Sub)
        Text(
            "将调起相机；取消则走无照片文字降级",
            style = MaterialTheme.typography.labelSmall,
            color = Sub
        )
        if (!AppModule.canWrite()) {
            Text("只读账号不可提交", style = MaterialTheme.typography.labelSmall, color = Sub)
        }
    }
}

@Composable
fun KimiCtaByType(kimiType: String, baseRev: String? = null) {
    val spec = KIMI_SPECS.find { it.kimiType == kimiType } ?: return
    KimiCtaCard(spec, baseRev)
}
