package com.pandawufu.app.media

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Compose 侧的水印相机入口：一次 `capture(spec)` 走完
 * 「校验相机权限 → 申请权限 → 系统相机写原图到私有目录 → 后台合成水印 → 回调成品」。
 *
 * 调用方（品控页 / 巡检页）只关心成品与失败话术，不必重复处理 FileProvider 与 Uri 授权。
 */
class WatermarkCapture internal constructor(
    private val start: (WatermarkSpec) -> Unit
) {
    /** 一键拍照。同一时刻只允许一张在途，重复点击会自动忽略。 */
    fun capture(spec: WatermarkSpec) = start(spec)

    companion object {
        const val ERR_CAMERA_UNAVAILABLE = "相机不可用，请改用无照片降级记录"
        const val ERR_NOT_CAPTURED = "未拍到照片，请重试"
        const val ERR_COMPOSE_FAILED = "照片处理失败，请重试"
    }
}

@Composable
fun rememberWatermarkCapture(
    onCaptured: (WatermarkedPhoto, WatermarkSpec) -> Unit,
    onFailed: (String) -> Unit = {}
): WatermarkCapture {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    // 回调每次重组都会换新实例，用 UpdatedState 兜住，避免闭包里一直是第一帧的旧回调
    val capturedRef = rememberUpdatedState(onCaptured)
    val failedRef = rememberUpdatedState(onFailed)

    var pendingSpec by remember { mutableStateOf<WatermarkSpec?>(null) }
    var pendingRaw by remember { mutableStateOf<File?>(null) }
    var inFlight by remember { mutableStateOf(false) }

    /** 清掉在途原图，避免失败时残留垃圾文件 */
    fun discardRaw() {
        pendingRaw?.delete()
        pendingRaw = null
        pendingSpec = null
        inFlight = false
    }

    val takePicture = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture()
    ) { saved: Boolean ->
        val spec = pendingSpec
        val raw = pendingRaw
        pendingSpec = null
        pendingRaw = null
        if (spec == null || raw == null) {
            inFlight = false
            return@rememberLauncherForActivityResult
        }
        if (!saved) {
            raw.delete()
            inFlight = false
            failedRef.value(WatermarkCapture.ERR_NOT_CAPTURED)
            return@rememberLauncherForActivityResult
        }
        // 合成是 CPU 密集（解码 1600px + 画布），必须离开主线程，否则拍照后界面会卡一下
        scope.launch {
            val photo = withContext(Dispatchers.IO) {
                WatermarkCamera.compose(context, raw, spec)
            }
            inFlight = false
            if (photo == null) failedRef.value(WatermarkCapture.ERR_COMPOSE_FAILED)
            else capturedRef.value(photo, spec)
        }
    }

    fun fire(spec: WatermarkSpec) {
        if (inFlight) return
        val raw = WatermarkCamera.rawFile(context, prefix = if (spec.kind.isNotBlank()) spec.kind else "cap")
        val uri = try {
            WatermarkCamera.uriFor(context, raw)
        } catch (e: Exception) {
            raw.delete()
            failedRef.value(WatermarkCapture.ERR_CAMERA_UNAVAILABLE)
            return
        }
        pendingSpec = spec
        pendingRaw = raw
        inFlight = true
        try {
            takePicture.launch(uri)
        } catch (e: Exception) {
            discardRaw()
            failedRef.value(WatermarkCapture.ERR_CAMERA_UNAVAILABLE)
        }
    }

    val askPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted: Boolean ->
        val spec = pendingSpec
        if (!granted) {
            discardRaw()
            failedRef.value("未授权相机，无法拍照留证")
            return@rememberLauncherForActivityResult
        }
        if (spec == null) {
            inFlight = false
            return@rememberLauncherForActivityResult
        }
        pendingSpec = null
        fire(spec)
    }

    return remember(context) {
        WatermarkCapture { spec ->
            if (hasCameraPermission(context)) {
                fire(spec)
            } else {
                pendingSpec = spec
                askPermission.launch(Manifest.permission.CAMERA)
            }
        }
    }
}

/** 是否已拿到相机运行时权限（不是「设备有没有摄像头」） */
fun hasCameraPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
        PackageManager.PERMISSION_GRANTED
