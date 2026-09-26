package com.pandawufu.app.offline

import android.content.Context
import android.util.Log
import java.io.File

/**
 * 业务只读缓存：联网成功后落盘，离线时回放。
 * 键与 BFF 路径对齐，如 report/daily、snapshot/latest、modules/vip。
 */
class OfflineCache(context: Context) {
    private val dir = File(context.applicationContext.filesDir, "offline_cache").also { it.mkdirs() }
    private val meta = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Volatile
    var lastServeFromCache: Boolean = false
        private set

    fun put(key: String, json: String) {
        runCatching {
            file(key).writeText(json)
            meta.edit()
                .putLong(metaKey(key), System.currentTimeMillis())
                .putLong(KEY_LAST_SYNC, System.currentTimeMillis())
                .apply()
            lastServeFromCache = false
        }.onFailure { Log.w(TAG, "cache put $key fail", it) }
    }

    fun get(key: String): String? {
        val f = file(key)
        if (!f.exists()) return null
        return runCatching { f.readText() }.getOrNull()?.also {
            lastServeFromCache = true
        }
    }

    fun cachedAt(key: String): Long = meta.getLong(metaKey(key), 0L)

    fun lastSyncAt(): Long = meta.getLong(KEY_LAST_SYNC, 0L)

    fun clear() {
        dir.listFiles()?.forEach { it.delete() }
        meta.edit().clear().apply()
    }

    private fun file(key: String): File {
        val safe = key.replace(Regex("[^a-zA-Z0-9._-]"), "_")
        return File(dir, "$safe.json")
    }

    private fun metaKey(key: String) = "ts:$key"

    companion object {
        private const val TAG = "OfflineCache"
        private const val PREFS = "panda_offline_cache"
        private const val KEY_LAST_SYNC = "last_sync_at"
    }
}
