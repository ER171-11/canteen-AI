package com.pandawufu.app.confirm

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * 老板侧「办完了吗」信号：确认台成功后写一句人话 + 触发首页刷新。
 * executed=true 表示店内消费器已回调「已执行」；false 表示仅入队待消费。
 */
object OpsSignal {
    var banner by mutableStateOf<String?>(null)
        private set
    var bannerRoute by mutableStateOf<String?>(null)
        private set
    /** 最近一次确认的执行摘要（如智能关联明细），供结果页展示 */
    var lastDetail by mutableStateOf<String?>(null)
        private set
    var refreshHomeTick by mutableIntStateOf(0)
        private set
    private var _hideTodoKinds by mutableStateOf(setOf<String>())
    private var hideDay: String? = null

    /** 被消待办按日 key 复位：跨天后同类待办要重新出现 */
    val hideTodoKinds: Set<String>
        get() {
            resetHidesIfNewDay()
            return _hideTodoKinds
        }

    private fun todayKey(): String =
        java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.CHINA).format(java.util.Date())

    private fun resetHidesIfNewDay() {
        val today = todayKey()
        if (hideDay != today) {
            hideDay = today
            if (_hideTodoKinds.isNotEmpty()) _hideTodoKinds = emptySet()
        }
    }

    fun afterConfirm(type: String, executed: Boolean = true, detail: String? = null) {
        lastDetail = detail?.takeIf { it.isNotBlank() }
        val done = if (executed) "店内已执行" else "已入队·等消费器"
        when {
            type.startsWith("restock") -> {
                banner = "$done · 打开「进销 → 采购」看草稿 PO"
                bannerRoute = "inventory/purchase"
                // 仅真正执行后才消掉首页补货待办，避免「入队即假装办完」
                if (executed) {
                    resetHidesIfNewDay()
                    _hideTodoKinds = _hideTodoKinds + "restock"
                }
            }
            type.startsWith("recv") || type == "order.mark" -> {
                banner = if (executed) "采购/入库已落库 · 打开进销核对"
                else "$done · 消费器跑通后库存才会变"
                bannerRoute = "inventory/purchase"
            }
            type.startsWith("stock.count") -> {
                banner = if (executed) "盘点已改账面 · 打开「进销 → 库存」"
                else "$done · 盘点改账需消费器"
                bannerRoute = "inventory"
            }
            type.startsWith("workorder") -> {
                banner = "$done · 打开「厨房 → 工单」"
                bannerRoute = "kitchen"
                if (executed) {
                    resetHidesIfNewDay()
                    _hideTodoKinds = _hideTodoKinds + "prep"
                }
            }
            type.startsWith("pos.pay") -> {
                banner = if (executed) "结账已落库·已按菜谱扣料" else "$done · 等消费器扣 BOM"
                bannerRoute = "m/pos"
            }
            type.startsWith("pos.") -> {
                banner = "$done · 巡台页下拉可见更新"
                bannerRoute = "m/pos"
            }
            type.startsWith("loss") -> {
                banner = if (executed) "报损已扣库存 · 打开进销核对"
                else "$done · 报损扣库存需消费器"
                bannerRoute = "inventory"
            }
            type.startsWith("dish.auto_link") -> {
                val tip = detail?.removePrefix("dish.auto_link ")?.trim().orEmpty()
                banner = when {
                    executed && tip.isNotBlank() -> "智能关联完成 · $tip"
                    executed -> "菜单已智能挂菜谱 · 结账可扣 BOM"
                    else -> "$done · 等消费器关联"
                }
                bannerRoute = "m/restaurant"
            }
            type.startsWith("dish.") -> {
                banner = "$done · 菜单稍后刷新"
                bannerRoute = "m/restaurant"
            }
            type.startsWith("ing.") || type.startsWith("quote.") || type.startsWith("vendor.") -> {
                banner = "$done · 进销/供应商页稍后刷新"
                bannerRoute = "inventory"
            }
            type.startsWith("config") -> {
                banner = if (executed) "设置已写入店内" else "$done"
                bannerRoute = "m/restaurant"
            }
            type.startsWith("day.close") -> {
                banner = if (executed) "打烊日清已登记 · 可到财务核对" else "$done · 等消费器落账"
                bannerRoute = "m/finance"
            }
            type.startsWith("finance.recon") -> {
                banner = if (executed) "三方勾兑已落账 · 打开财务核对" else "$done · 等消费器落账"
                bannerRoute = "m/finance"
            }
            type.startsWith("fs.cert") -> {
                banner = if (executed) "证照已更新 · 打开食安核对" else "$done"
                bannerRoute = "m/foodsafe"
            }
            type.startsWith("supply.") -> {
                banner = "$done · 供应链稍后刷新"
                bannerRoute = "m/supply"
            }
            else -> {
                banner = "$done · 可在「审批队列」查看终态"
                bannerRoute = "m/actions"
            }
        }
        refreshHomeTick++
    }

    fun clearBanner() {
        banner = null
        bannerRoute = null
    }

    fun hideTodo(kind: String) {
        if (kind.isBlank()) return
        resetHidesIfNewDay()
        _hideTodoKinds = _hideTodoKinds + kind
    }

    fun peekBanner(): String? = banner
}
