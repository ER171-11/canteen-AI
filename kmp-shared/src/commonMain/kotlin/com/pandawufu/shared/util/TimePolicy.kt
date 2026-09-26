package com.pandawufu.shared.util

/** 极简 ISO-8601 解析（commonMain 无 kotlinx-datetime 依赖）：
 *  支持 `yyyy-MM-ddTHH:mm:ss(.SSS)?(Z|±HH:mm|±HHmm)?`，缺省时区按 UTC。 */
object TimeUtil {

    fun parseIsoToEpochMs(iso: String): Long? {
        val m = Regex(
            """^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})?$"""
        ).find(iso.trim()) ?: return null
        val g = m.groupValues
        val year = g[1].toInt(); val month = g[2].toInt(); val day = g[3].toInt()
        val hh = g[4].toInt(); val mm = g[5].toInt(); val ss = g[6].toInt()
        val frac = if (g[7].isEmpty()) 0L else g[7].padEnd(3, '0').toLong()
        val offsetMs = when (val tz = g[8]) {
            "", "Z" -> 0L
            else -> {
                val digits = tz.removePrefix("+").removePrefix("-").replace(":", "")
                val oh = digits.substring(0, 2).toLong()
                val om = digits.substring(2, 4).toLong()
                val total = (oh * 60 + om) * 60_000L
                if (tz.startsWith("-")) total else -total
            }
        }
        val days = daysFromCivil(year, month, day)
        return days * 86_400_000L + (hh * 3600L + mm * 60L + ss) * 1000L + frac + offsetMs
    }

    /** Howard Hinnant days_from_civil：公历日期 → 1970-01-01 起天数 */
    fun daysFromCivil(y0: Int, m: Int, d: Int): Long {
        var y = y0
        if (m <= 2) y -= 1
        val era = (if (y >= 0) y else y - 399) / 400
        val yoe = y - era * 400
        val doy = (153 * (if (m > 2) m - 3 else m + 9) + 2) / 5 + d - 1
        val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146097L + doe - 719468L
    }
}

/** 数据时延判定：now - generated_at > 阈值（默认 15 分钟）即 stale，UI 黄色标注。 */
object StalePolicy {
    const val DEFAULT_THRESHOLD_MS: Long = 15 * 60_000L

    fun isStale(
        generatedAtIso: String?,
        nowEpochMs: Long,
        thresholdMs: Long = DEFAULT_THRESHOLD_MS
    ): Boolean {
        val gen = generatedAtIso?.let(TimeUtil::parseIsoToEpochMs) ?: return true
        return nowEpochMs - gen > thresholdMs
    }

    /** 距生成过去的分钟数（供 UI 展示「xx 分钟前更新」）；无法解析返回 null */
    fun ageMinutes(generatedAtIso: String?, nowEpochMs: Long): Long? {
        val gen = generatedAtIso?.let(TimeUtil::parseIsoToEpochMs) ?: return null
        return ((nowEpochMs - gen) / 60_000L).coerceAtLeast(0)
    }
}
