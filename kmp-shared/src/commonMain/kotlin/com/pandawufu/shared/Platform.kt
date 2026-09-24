package com.pandawufu.shared

import kotlinx.coroutines.CoroutineDispatcher

/** 平台调度器。 */
expect object AppDispatchers {
    val main: CoroutineDispatcher
    val io: CoroutineDispatcher
}

/** 平台日志。 */
expect fun platformLogD(tag: String, message: String)
