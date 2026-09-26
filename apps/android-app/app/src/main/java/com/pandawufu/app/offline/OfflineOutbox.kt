package com.pandawufu.app.offline

import android.content.Context
import android.util.Log
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/** 离线写操作发件箱：确认台在无网时入队，联网后冲刷到 /api/actions。 */
class OfflineOutbox(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }
    private val listSer = ListSerializer(Item.serializer())

    @Serializable
    data class Item(
        val localId: String,
        val type: String,
        val payloadJson: String,
        val operator: String? = null,
        val baseRev: String? = null,
        val title: String? = null,
        val summary: String? = null,
        val createdAt: Long = System.currentTimeMillis()
    )

    fun list(): List<Item> {
        val raw = prefs.getString(KEY_ITEMS, "[]") ?: "[]"
        return runCatching { json.decodeFromString(listSer, raw) }.getOrElse {
            Log.w(TAG, "outbox decode fail", it)
            emptyList()
        }
    }

    fun count(): Int = list().size

    fun enqueue(item: Item) {
        val next = list() + item
        prefs.edit().putString(KEY_ITEMS, json.encodeToString(listSer, next)).apply()
        Log.i(TAG, "outbox +1 type=${item.type} local=${item.localId} size=${next.size}")
    }

    fun remove(localId: String) {
        val next = list().filterNot { it.localId == localId }
        prefs.edit().putString(KEY_ITEMS, json.encodeToString(listSer, next)).apply()
    }

    fun clear() {
        prefs.edit().remove(KEY_ITEMS).apply()
    }

    companion object {
        private const val TAG = "OfflineOutbox"
        private const val PREFS = "panda_offline_outbox"
        private const val KEY_ITEMS = "items"
    }
}
