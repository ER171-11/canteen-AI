package com.pandawufu.app.features.inventory

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.pandawufu.app.ui.designsystem.Sub

// 原型 inv-po：采购单列表（BFF 未开放采购单端点，Sprint 1 为空态占位）
@Composable
fun PurchaseTab() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("暂无采购单\n（采购单端点待 BFF 开放）", style = MaterialTheme.typography.bodySmall, color = Sub)
    }
}
