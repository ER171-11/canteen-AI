package com.pandawufu.app.features.kitchen

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier

// TODO: 对应原型 p-kitchen（厨房 Tab：五色饺子产能 / 菜谱成本 / Kimi 拍照品控 qc·plate）。
@Composable
fun KitchenScreen() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("厨房（骨架）", style = MaterialTheme.typography.titleMedium)
    }
}
