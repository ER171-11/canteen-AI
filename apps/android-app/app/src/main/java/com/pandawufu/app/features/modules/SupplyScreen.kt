package com.pandawufu.app.features.modules

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier

// TODO: 对应原型 p-m-supply（供应链：采购单 / 比价 / Kimi 拍照验货 recv；
//  生成补货单必须经 ConfirmGateway 确认）。
@Composable
fun SupplyScreen() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("供应链（骨架）", style = MaterialTheme.typography.titleMedium)
    }
}
