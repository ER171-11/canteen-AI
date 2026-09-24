package com.pandawufu.app.features.modules

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier

// TODO: 对应原型 p-m-equipment（设备能耗：设备台账 / 能耗曲线 / 维保提醒）。
@Composable
fun EquipmentScreen() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("设备能耗（骨架）", style = MaterialTheme.typography.titleMedium)
    }
}
