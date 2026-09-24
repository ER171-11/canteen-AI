package com.pandawufu.app.features.modules

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier

// TODO: 对应原型 p-m-foodsafe（食安证照：证照台账 / 留样记录，Kimi 拍照留样登记 sample）。
@Composable
fun FoodsafeScreen() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("食安证照（骨架）", style = MaterialTheme.typography.titleMedium)
    }
}
