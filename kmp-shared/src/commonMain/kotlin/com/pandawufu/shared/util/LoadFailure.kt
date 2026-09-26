package com.pandawufu.shared.util

/**
 * 把底层异常收成老板听得懂的「硬错 / 软提示」。
 * 无快照、断网不应整页「加载失败」；有数据时只挂 hint。
 */
data class LoadFailure(
    /** 硬错误标题；软态（无快照）时为 null */
    val error: String?,
    /** 下一步说明 */
    val hint: String?,
    val soft: Boolean = error == null
) {
    companion object {
        const val NO_SNAPSHOT_HINT = "no_snapshot"
        const val NO_SNAPSHOT_MSG =
            "店内快照未接通 · 菜谱可先看标准菜单，工单/出品需店内推送后刷新"

        fun from(throwable: Throwable): LoadFailure = fromMessage(throwable.message)

        fun fromMessage(raw: String?): LoadFailure {
            val m = raw.orEmpty()
            val lower = m.lowercase()
            return when {
                lower.contains("no snapshot") || lower.contains("no_snapshot") ->
                    LoadFailure(error = null, hint = NO_SNAPSHOT_MSG, soft = true)

                lower.contains("unable to resolve host") ||
                    lower.contains("failed to connect") ||
                    lower.contains("connection refused") ||
                    lower.contains("connection reset") ||
                    lower.contains("network is unreachable") ||
                    lower.contains("software caused connection abort") ||
                    lower.contains("timed out") ||
                    lower.contains("timeout") ||
                    lower.contains("unreachable") ->
                    LoadFailure(
                        error = "暂时连不上门店服务",
                        hint = "请确认 BFF 已启动，且手机与电脑同网，再点重试"
                    )

                lower.contains("401") || lower.contains("unauthorized") || lower.contains("invalid token") ->
                    LoadFailure(error = "登录已失效", hint = "请退出后重新登录")

                lower.contains("403") || lower.contains("forbidden") ->
                    LoadFailure(error = "当前账号无权限", hint = "请用老板/店长账号，或找店长开写权")

                m.isBlank() ->
                    LoadFailure(error = "加载失败", hint = "可点重试；仍不行再查网络与 BFF")

                else ->
                    LoadFailure(
                        error = m.take(120),
                        hint = "可点重试；若反复出现请查 BFF 日志"
                    )
            }
        }

        /** BFF 软空开：hint=no_snapshot */
        fun fromApiHint(hint: String?, message: String?): LoadFailure? {
            if (hint == NO_SNAPSHOT_HINT || hint == "no snapshot") {
                return LoadFailure(error = null, hint = message?.takeIf { it.isNotBlank() } ?: NO_SNAPSHOT_MSG, soft = true)
            }
            return null
        }
    }
}
