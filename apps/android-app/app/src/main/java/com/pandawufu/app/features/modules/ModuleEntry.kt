package com.pandawufu.app.features.modules

/** 跨页深链：首页待办打开模块时落到指定 pill（消费后清空） */
object ModuleEntry {
    @Volatile
    var pendingPill: Int? = null

    /** 跨页深链：打开收银并预选某桌（如首页/前厅点「收钱」） */
    @Volatile
    var pendingTableId: String? = null

    fun open(pill: Int?) {
        pendingPill = pill
    }

    fun openTable(tableId: String?) {
        pendingTableId = tableId
    }

    fun consumePill(default: Int = 0): Int {
        val v = pendingPill ?: default
        pendingPill = null
        return v
    }

    fun consumeTable(): String? {
        val v = pendingTableId
        pendingTableId = null
        return v
    }
}
