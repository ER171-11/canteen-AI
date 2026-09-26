package com.pandawufu.app.auth

import android.content.Context
import android.provider.Settings
import com.pandawufu.shared.auth.AuthTokenHolder

/** SharedPreferences 持久化 token / role / account / store / permissions */
class SessionStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_TOKEN, value).apply()

    var role: String?
        get() = prefs.getString(KEY_ROLE, null)
        set(value) = prefs.edit().putString(KEY_ROLE, value).apply()

    var account: String?
        get() = prefs.getString(KEY_ACCOUNT, null)
        set(value) = prefs.edit().putString(KEY_ACCOUNT, value).apply()

    var storeId: String?
        get() = prefs.getString(KEY_STORE_ID, null)
        set(value) = prefs.edit().putString(KEY_STORE_ID, value).apply()

    var storeName: String?
        get() = prefs.getString(KEY_STORE_NAME, null)
        set(value) = prefs.edit().putString(KEY_STORE_NAME, value).apply()

    var displayName: String?
        get() = prefs.getString(KEY_DISPLAY, null)
        set(value) = prefs.edit().putString(KEY_DISPLAY, value).apply()

    var canWrite: Boolean
        get() = prefs.getBoolean(KEY_CAN_WRITE, false)
        set(value) = prefs.edit().putBoolean(KEY_CAN_WRITE, value).apply()

    var permissionsCsv: String?
        get() = prefs.getString(KEY_PERMS, null)
        set(value) = prefs.edit().putString(KEY_PERMS, value).apply()

    val permissions: Set<String>
        get() = permissionsCsv?.split(',')?.filter { it.isNotBlank() }?.toSet().orEmpty()

    fun clear() {
        prefs.edit().clear().apply()
        AuthTokenHolder.clear()
    }

    fun restoreToHolder() {
        AuthTokenHolder.set(token)
    }

    fun deviceFp(context: Context): String {
        val id = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
            ?: "android-unknown"
        return "android-$id"
    }

    companion object {
        private const val PREFS = "panda_session"
        private const val KEY_TOKEN = "token"
        private const val KEY_ROLE = "role"
        private const val KEY_ACCOUNT = "account"
        private const val KEY_STORE_ID = "store_id"
        private const val KEY_STORE_NAME = "store_name"
        private const val KEY_DISPLAY = "display_name"
        private const val KEY_CAN_WRITE = "can_write"
        private const val KEY_PERMS = "permissions"
    }
}
