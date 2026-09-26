package com.pandawufu.app.features.modules

/** 跨页深链：首页待办打开模块时落到指定 pill（消费后清空） */
object ModuleEntry {
    @Volatile
    var pendingPill: Int? = null

    fun open(pill: Int?) {
        pendingPill = pill
    }

    fun consumePill(default: Int = 0): Int {
        val v = pendingPill ?: default
        pendingPill = null
        return v
    }
}
