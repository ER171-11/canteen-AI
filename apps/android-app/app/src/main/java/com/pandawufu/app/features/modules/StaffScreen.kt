package com.pandawufu.app.features.modules

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier

// TODO: 对应原型 p-m-staff（排班员工：班次表 / 人效 / Kimi 拍照着装合规 uniform）。
@Composable
fun StaffScreen() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("排班员工（骨架）", style = MaterialTheme.typography.titleMedium)
    }
}
