package com.pandawufu.app.features.inventory

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier

// TODO: 对应原型 p-inventory（进销存 Tab：库存预警 / 五色备货 AI 预测(预测≠下单) / Kimi 拍照盘点 stock）。
@Composable
fun InventoryScreen() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("进销存（骨架）", style = MaterialTheme.typography.titleMedium)
    }
}
