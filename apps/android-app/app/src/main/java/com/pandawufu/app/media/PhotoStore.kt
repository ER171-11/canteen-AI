package com.pandawufu.app.media

import android.content.Context
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File

/**
 * 巡检 / 品控照片的**手机本地**台账（C、D 块）。
 *
 * 用户已确认的硬约束：
 * - 巡检照片只存手机，服务器只收「节点 + 责任人 + 时间 + 是否完成」状态与元数据；
 * - 因此本类不提供任何上传通道，只有落盘、检索、清理三件事。
 *
 * 存储布局（全部在 filesDir 下，卸载即清，不需要任何存储权限）：
 * ```
 * filesDir/photos/wm/        水印成品（水印已烧进像素）
 * filesDir/photos/index.json 台账索引（原子写：先写 .tmp 再改名）
 * ```
 * 索引损坏（断电写一半等）时自动降级为空台账并重建，绝不让 App 起不来。
 */
@Serializable
data class PhotoEntry(
    val id: String,
    val file: String,
    val kind: String = "",              // 品控 / 巡检
    @SerialName("node_id") val nodeId: String? = null,
    @SerialName("point_name") val pointName: String = "",
    @SerialName("store_name") val storeName: String = "",
    val operator: String = "",
    @SerialName("captured_at") val capturedAt: Long = 0L,
    @SerialName("day") val day: String = "",
    @SerialName("size_bytes") val sizeBytes: Long = 0L,
    val width: Int = 0,
    val height: Int = 0,
    val watermark: String = ""
)

@Serializable
data class PhotoIndex(
    val version: Int = 1,
    val entries: List<PhotoEntry> = emptyList()
)

data class PhotoStoreStats(
    val count: Int,
    val bytes: Long,
    val oldestAt: Long?,
    val newestAt: Long?
)

class PhotoStore(context: Context) {

    private val root = File(context.filesDir, "photos").apply { mkdirs() }
    private val indexFile = File(root, "index.json")
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        prettyPrint = false
    }
    private val lock = Any()

    @Volatile
    private var cache: MutableList<PhotoEntry>? = null

    /* ---------- 写入 ---------- */

    /** 成品入库。返回台账条目；落盘失败返回 null（照片仍可用，只是不入索引）。 */
    fun record(photo: WatermarkedPhoto, spec: WatermarkSpec, nodeId: String? = null): PhotoEntry? {
        if (!photo.file.exists()) return null
        val entry = PhotoEntry(
            id = "ph_${photo.capturedAt}_${photo.file.nameWithoutExtension.takeLast(9)}",
            file = photo.file.absolutePath,
            kind = spec.kind,
            nodeId = nodeId?.takeIf { it.isNotBlank() },
            pointName = spec.pointName,
            storeName = spec.storeName,
            operator = spec.operator,
            capturedAt = photo.capturedAt,
            day = WatermarkCamera.dayKey(photo.capturedAt),
            sizeBytes = photo.sizeBytes,
            width = photo.width,
            height = photo.height,
            watermark = photo.watermarkText
        )
        synchronized(lock) {
            val list = loadLocked().toMutableList()
            list.removeAll { it.id == entry.id }
            list.add(entry)
            val ok = saveLocked(list)
            cache = list
            return if (ok) entry else null
        }
    }

    /* ---------- 检索（时间 / 点位 / 责任人） ---------- */

    fun all(): List<PhotoEntry> = synchronized(lock) { loadLocked().sortedByDescending { it.capturedAt } }

    fun query(
        fromMs: Long? = null,
        toMs: Long? = null,
        nodeId: String? = null,
        pointKeyword: String? = null,
        operator: String? = null,
        kind: String? = null,
        limit: Int = 500
    ): List<PhotoEntry> {
        val key = pointKeyword?.trim()?.lowercase().orEmpty()
        return all().asSequence()
            .filter { fromMs == null || it.capturedAt >= fromMs }
            .filter { toMs == null || it.capturedAt <= toMs }
            .filter { nodeId.isNullOrBlank() || it.nodeId == nodeId }
            .filter { operator.isNullOrBlank() || it.operator == operator }
            .filter { kind.isNullOrBlank() || it.kind == kind }
            .filter {
                key.isBlank() ||
                    it.pointName.lowercase().contains(key) ||
                    it.storeName.lowercase().contains(key)
            }
            .take(limit)
            .toList()
    }

    /** 某点位当日是否已有照片（巡检「未拍照即未完成」的就地判据） */
    fun hasTodayPhoto(nodeId: String, dayKey: String): Boolean =
        all().any { it.nodeId == nodeId && it.day == dayKey }

    fun find(id: String): PhotoEntry? = all().firstOrNull { it.id == id }

    fun stats(): PhotoStoreStats {
        val list = all()
        return PhotoStoreStats(
            count = list.size,
            bytes = list.sumOf { it.sizeBytes },
            oldestAt = list.minByOrNull { it.capturedAt }?.capturedAt,
            newestAt = list.maxByOrNull { it.capturedAt }?.capturedAt
        )
    }

    /* ---------- 清理策略 ---------- */

    /**
     * 容量上限 + 按天清理。
     * 先删超过 [keepDays] 天的老照片，再按时间从旧到新删到总量不超过 [maxBytes]。
     * 现场手机存储紧张，这一步同时删文件与索引条目，避免索引里挂着死路径。
     *
     * @return 被清理的条目数
     */
    fun prune(
        maxBytes: Long = DEFAULT_MAX_BYTES,
        keepDays: Int = DEFAULT_KEEP_DAYS,
        nowMs: Long = System.currentTimeMillis()
    ): Int {
        val cutoff = nowMs - keepDays.toLong() * 24L * 3600_000L
        synchronized(lock) {
            val list = loadLocked().toMutableList()
            val removed = mutableListOf<PhotoEntry>()

            list.filter { it.capturedAt > 0 && it.capturedAt < cutoff }.forEach {
                removed.add(it)
                list.remove(it)
            }

            var total = list.sumOf { it.sizeBytes }
            if (total > maxBytes) {
                val oldestFirst = list.sortedBy { it.capturedAt }
                for (e in oldestFirst) {
                    if (total <= maxBytes) break
                    removed.add(e)
                    list.remove(e)
                    total -= e.sizeBytes
                }
            }

            if (removed.isNotEmpty()) {
                removed.forEach { runCatching { File(it.file).delete() } }
                saveLocked(list)
                cache = list
            }
            return removed.size
        }
    }

    /** 清空全部本地照片（设置页「清理现场照片」用） */
    fun clear(): Int {
        synchronized(lock) {
            val list = loadLocked()
            list.forEach { runCatching { File(it.file).delete() } }
            saveLocked(emptyList())
            cache = mutableListOf()
            return list.size
        }
    }

    /* ---------- 索引读写 ---------- */

    private fun loadLocked(): List<PhotoEntry> {
        cache?.let { return it }
        val loaded = try {
            if (!indexFile.exists()) emptyList()
            else json.decodeFromString(PhotoIndex.serializer(), indexFile.readText()).entries
        } catch (e: Exception) {
            emptyList()
        }
        // 索引里可能残留已被系统清掉的文件，读的时候顺手剔除，避免台账出现死条
        val alive = loaded.filter { File(it.file).exists() }
        val mutable = alive.toMutableList()
        cache = mutable
        return mutable
    }

    private fun saveLocked(list: List<PhotoEntry>): Boolean = try {
        root.mkdirs()
        val tmp = File(root, "index.json.tmp")
        tmp.writeText(json.encodeToString(PhotoIndex.serializer(), PhotoIndex(entries = list)))
        if (indexFile.exists() && !indexFile.delete()) tmp.delete() else tmp.renameTo(indexFile)
    } catch (e: Exception) {
        false
    }

    companion object {
        /** 300MB：约 1600px/JPEG80 的 1500 张，够覆盖一个月现场留证 */
        const val DEFAULT_MAX_BYTES = 300L * 1024L * 1024L

        /** 30 天：与门店月度复盘的节奏对齐 */
        const val DEFAULT_KEEP_DAYS = 30
    }
}
