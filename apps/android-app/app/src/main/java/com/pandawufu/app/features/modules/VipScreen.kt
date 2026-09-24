package com.pandawufu.app.features.modules

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier

// TODO: 对应原型 p-m-vip（会员营销：储值记录 / 复购周期 / AI 活动建议）。
@Composable
fun VipScreen() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("会员营销（骨架）", style = MaterialTheme.typography.titleMedium)
    }
}
