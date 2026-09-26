package com.pandawufu.shared.auth

/**
 * 端侧持有的 Bearer token（登录后注入 BffClient）。
 * 单进程读写；UI 主线程写入，网络线程读取。
 */
object AuthTokenHolder {
    @Suppress("ObjectPropertyName")
    private var _token: String? = null

    fun get(): String? = _token

    fun set(value: String?) {
        _token = value
    }

    fun clear() {
        _token = null
    }
}
