package com.pandawufu.app.features.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier

// TODO: 对应原型 p-chat（AI 对话 Tab：消息流 / 快捷指令 / Kimi SSE delta 流式渲染）。
@Composable
fun ChatScreen() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("AI 对话（骨架）", style = MaterialTheme.typography.titleMedium)
    }
}
