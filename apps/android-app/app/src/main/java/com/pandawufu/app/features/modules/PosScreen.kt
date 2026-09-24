package com.pandawufu.app.features.modules

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier

// TODO: 对应原型 p-m-pos（堂食收银：桌台网格 / 并拆单撤销栈 → kmp-shared pos.UndoStack，
//  结算写操作必须经 ConfirmGateway → /api/actions）。
@Composable
fun PosScreen() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("堂食收银（骨架）", style = MaterialTheme.typography.titleMedium)
    }
}
