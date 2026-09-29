package com.pandawufu.app.media

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.media.ExifInterface
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.max

/**
 * D 块「水印相机强制启用与追溯」的核心。
 *
 * 设计取舍（改动前请先读）：
 * 1. 用系统相机 `ActivityResultContracts.TakePicture()` 而不是 `TakePicturePreview()`：
 *    后者只回缩略图（~百像素），既撑不起水印条带也留不下可追溯原图。
 *    TakePicture 需要一个可写 Uri，故配合 FileProvider 把原图落到 filesDir/photos/raw。
 * 2. 全程零新增依赖：方向矫正用框架自带的 [android.media.ExifInterface]（API 5+），
 *    缩放/水印/压缩用 `Bitmap` + `Canvas` 手写。
 * 3. **水印强制执行**：成品一律经 [compose] 产出。即使调用方没给全门店/点位名，
 *    也会用「未标注门店 / 未标注点位」占位把条带画上，杜绝出现无水印照片。
 */

/** 水印内容：地点 = 门店 + 点位名；操作人用于异常回溯 */
data class WatermarkSpec(
    val storeName: String,
    val pointName: String,
    val operator: String,
    val kind: String = "",              // 品控 / 巡检，用于台账检索
    val capturedAt: Long = System.currentTimeMillis()
)

/** 合成完成的成品照片（水印已烧进像素） */
data class WatermarkedPhoto(
    val file: File,
    val capturedAt: Long,
    val width: Int,
    val height: Int,
    val sizeBytes: Long,
    val watermarkText: String
)

object WatermarkCamera {

    const val DIR_RAW = "photos/raw"
    const val DIR_WM = "photos/wm"

    /** 长边上限：运营现场工位网速一般，压到 1600px 兼顾可判定与上传耗时 */
    const val MAX_LONG_EDGE = 1600
    const val JPEG_QUALITY = 80

    private const val UNKNOWN_STORE = "未标注门店"
    private const val UNKNOWN_POINT = "未标注点位"

    private val timeFmt = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA)
    private val stampFmt = SimpleDateFormat("yyyyMMdd_HHmmss_SSS", Locale.CHINA)
    private val dayFmt = SimpleDateFormat("yyyy-MM-dd", Locale.CHINA)

    fun nowText(ts: Long): String = timeFmt.format(Date(ts))

    fun dayKey(ts: Long): String = dayFmt.format(Date(ts))

    /** 原图落点（TakePicture 直接写入这里） */
    fun rawFile(context: Context, prefix: String = "raw"): File {
        val dir = File(context.filesDir, DIR_RAW).apply { mkdirs() }
        return File(dir, "${safe(prefix)}_${stampFmt.format(Date())}.jpg")
    }

    /** 水印成品落点 */
    fun watermarkFile(context: Context, prefix: String = "wm"): File {
        val dir = File(context.filesDir, DIR_WM).apply { mkdirs() }
        return File(dir, "${safe(prefix)}_${stampFmt.format(Date())}.jpg")
    }

    /** 交给系统相机的可写 content:// Uri（必须带写权限，否则相机无法落盘） */
    fun uriFor(context: Context, file: File): Uri =
        FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)

    /** 水印三行：第一行时刻，第二行地点（门店·点位），第三行操作人与用途 */
    fun watermarkLines(spec: WatermarkSpec): List<String> = listOf(
        nowText(spec.capturedAt),
        "${spec.storeName.trim().ifBlank { UNKNOWN_STORE }} · " +
            spec.pointName.trim().ifBlank { UNKNOWN_POINT },
        buildString {
            append("操作人 ")
            append(spec.operator.trim().ifBlank { "未标注" })
            if (spec.kind.isNotBlank()) append("　").append(spec.kind)
        }
    )

    /**
     * 原图 → 水印成品。
     * @return 成品；任何一步失败（文件损坏/空间不足）返回 null，由调用方决定降级话术。
     */
    fun compose(context: Context, raw: File, spec: WatermarkSpec, prefix: String = "wm"): WatermarkedPhoto? {
        val src = loadUpright(raw) ?: return null
        return try {
            val stamped = drawWatermark(src, watermarkLines(spec))
            if (stamped !== src) src.recycle()
            val out = watermarkFile(context, prefix)
            val bytes = saveJpeg(stamped, out)
            if (bytes <= 0L) return null
            WatermarkedPhoto(
                file = out,
                capturedAt = spec.capturedAt,
                width = stamped.width,
                height = stamped.height,
                sizeBytes = bytes,
                watermarkText = watermarkLines(spec).joinToString(" ")
            ).also { stamped.recycle() }
        } finally {
            raw.delete()
        }
    }

    /**
     * 读取并按 EXIF 方向摆正，同时按 [MAX_LONG_EDGE] 降采样。
     * 先只读边界算 inSampleSize，避免大图整张进内存被 OOM 杀掉。
     */
    fun loadUpright(file: File): Bitmap? {
        if (!file.exists() || file.length() <= 0L) return null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

        val opts = BitmapFactory.Options().apply {
            inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight)
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        val decoded = BitmapFactory.decodeFile(file.absolutePath, opts) ?: return null
        return applyExifRotation(decoded, readOrientation(file))
    }

    /** 长边压到 MAX_LONG_EDGE 所需的 2 的幂次采样率 */
    fun sampleSize(width: Int, height: Int): Int {
        var sample = 1
        var longEdge = max(width, height)
        while (longEdge / 2 >= MAX_LONG_EDGE) {
            longEdge /= 2
            sample *= 2
        }
        return sample
    }

    private fun readOrientation(file: File): Int = try {
        ExifInterface(file.absolutePath)
            .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    } catch (e: Exception) {
        ExifInterface.ORIENTATION_NORMAL
    }

    /** 竖拍照片在像素里通常是横向的，必须按 EXIF 摆正，否则水印会跟着躺倒 */
    fun applyExifRotation(src: Bitmap, orientation: Int): Bitmap {
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
            else -> return src
        }
        return runCatching {
            Bitmap.createBitmap(src, 0, 0, src.width, src.height, matrix, true)
        }.getOrNull() ?: src
    }

    /**
     * 在照片左下角叠加半透明条带水印。
     * 条带宽度按文字实测宽度自适应，字号随图片宽度缩放，保证 1600px 与 800px 观感一致。
     */
    fun drawWatermark(src: Bitmap, lines: List<String>): Bitmap {
        val out: Bitmap = if (src.isMutable) {
            src
        } else {
            runCatching { src.copy(Bitmap.Config.ARGB_8888, true) }.getOrNull() ?: return src
        }
        if (lines.isEmpty()) return out
        val canvas = Canvas(out)
        val unit = max(12f, out.width / 48f)

        val title = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textSize = unit
            isFakeBoldText = true
        }
        val body = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.argb(232, 255, 255, 255)
            textSize = unit * 0.82f
        }

        val pad = unit * 0.85f
        val lineGap = unit * 0.30f
        val heights = lines.indices.map { if (it == 0) title.textSize else body.textSize }
        val textWidth = lines.indices.maxOf { i ->
            (if (i == 0) title else body).measureText(lines[i])
        }
        val bandWidth = textWidth + pad * 2
        val bandHeight = heights.sum() + lineGap * (lines.size - 1) + pad * 2

        val left = unit * 0.75f
        val bottom = out.height - unit * 0.75f
        val band = RectF(left, bottom - bandHeight, left + bandWidth, bottom)

        canvas.drawRoundRect(
            band,
            unit * 0.5f,
            unit * 0.5f,
            Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(122, 0, 0, 0) }
        )

        var y = band.top + pad
        lines.forEachIndexed { i, text ->
            val paint = if (i == 0) title else body
            y += paint.textSize
            canvas.drawText(text, band.left + pad, y, paint)
            y += lineGap
        }
        return out
    }

    /** JPEG 落盘。返回字节数，0 表示失败。 */
    fun saveJpeg(bitmap: Bitmap, out: File, quality: Int = JPEG_QUALITY): Long {
        out.parentFile?.mkdirs()
        return try {
            FileOutputStream(out).use { fos ->
                bitmap.compress(Bitmap.CompressFormat.JPEG, quality, fos)
                fos.flush()
            }
            out.length()
        } catch (e: Exception) {
            runCatching { out.delete() }
            0L
        }
    }

    /** 水印条带在图片上的相对高度占比（供 UI 预占位，避免预览跳变） */
    fun bandRatio(): Float = 0.14f

    private fun safe(s: String): String =
        s.trim().ifBlank { "p" }.replace(Regex("[^A-Za-z0-9_\\-]"), "_").take(24)
}
