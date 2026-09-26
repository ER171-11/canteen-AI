package com.pandawufu.app.auth

import android.content.Context

/** 更多页：常用收藏 + 最近访问（对齐原型 pf_fav / pf_recent） */
class ModulePrefs(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun favorites(): List<String> =
        prefs.getString(KEY_FAV, "")
            ?.split(',')
            ?.map { it.trim() }
            ?.filter { it.isNotEmpty() }
            .orEmpty()

    /** @return 切换后是否为已收藏 */
    fun toggleFavorite(route: String): Boolean {
        val set = favorites().toMutableList()
        val nowFav = if (set.contains(route)) {
            set.remove(route)
            false
        } else {
            set.add(0, route)
            true
        }
        prefs.edit().putString(KEY_FAV, set.take(12).joinToString(",")).apply()
        return nowFav
    }

    fun isFavorite(route: String): Boolean = favorites().contains(route)

    fun recent(): List<String> =
        prefs.getString(KEY_RECENT, "")
            ?.split(',')
            ?.map { it.trim() }
            ?.filter { it.isNotEmpty() }
            .orEmpty()

    fun touch(route: String) {
        if (route.isBlank()) return
        val next = (listOf(route) + recent().filter { it != route }).take(8)
        prefs.edit().putString(KEY_RECENT, next.joinToString(",")).apply()
    }

    fun clearRecent() {
        prefs.edit().remove(KEY_RECENT).apply()
    }

    /** 收银默认菜品分类（保本「推爆品」等写入） */
    fun posDefaultCat(): String =
        prefs.getString(KEY_POS_CAT, "")?.takeIf { it.isNotBlank() } ?: "全部"

    fun setPosDefaultCat(cat: String) {
        prefs.edit().putString(KEY_POS_CAT, cat).apply()
    }

    companion object {
        private const val PREFS = "panda_modules"
        private const val KEY_FAV = "fav_routes"
        private const val KEY_RECENT = "recent_routes"
        private const val KEY_POS_CAT = "pos_default_cat"
    }
}
