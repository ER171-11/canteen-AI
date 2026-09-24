package com.pandawufu.shared.redline

/**
 * 红线守卫：检测本地 rev 是否落后于服务端（快照被他人/他端更新）。
 * 写操作确认前必须先校验，过期则刷新快照并重新生成动作，防止覆盖新数据。
 */
object RedlineGuard {

    /** rev 为 "yyyyMMdd" 或递增序号字符串；无法解析时按字符串不等即过期处理。 */
    fun isStale(localRev: String?, remoteRev: String?): Boolean {
        if (localRev.isNullOrBlank() || remoteRev.isNullOrBlank()) return true
        val l = localRev.toLongOrNull()
        val r = remoteRev.toLongOrNull()
        return if (l != null && r != null) l < r else localRev != remoteRev
    }

    /** 确认写操作前的硬校验；返回 true 表示放行。 */
    fun checkBeforeConfirm(localRev: String?, remoteRev: String?): Boolean = !isStale(localRev, remoteRev)
}
