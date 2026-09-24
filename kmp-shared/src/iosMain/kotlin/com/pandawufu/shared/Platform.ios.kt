package com.pandawufu.shared

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import platform.Foundation.NSLog

actual object AppDispatchers {
    // iOS 无 Dispatchers.Main 的 K/N 内置保证前，使用 main 队列调度由 UI 层保证；
    // 若接入 kotlinx-coroutines-core 的 DarwinMain 调度器可替换为 Dispatchers.Main。
    actual val main: CoroutineDispatcher = Dispatchers.Main
    // K/N 无 Dispatchers.IO，用 Default 承担 IO 型工作
    actual val io: CoroutineDispatcher = Dispatchers.Default
}

actual fun platformLogD(tag: String, message: String) {
    NSLog("[$tag] $message")
}
