package com.pandawufu.app.features.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.pandawufu.app.AppModule
import com.pandawufu.shared.viewmodel.HomeViewModel

// TODO: 对应原型 p-home（简报 Tab：今日 KPI 卡 / 五色销量 / AI 建议 / 待办）。
// 当前仅接 /api/health 与 /api/report/daily 展示 rev，KPI 卡片待 BFF 数据契约落地后补齐。
@Composable
fun HomeScreen() {
    val viewModel = remember {
        HomeViewModel(AppModule.healthRepository, AppModule.reportRepository)
    }
    val state by viewModel.state.collectAsState()

    LaunchedEffect(Unit) { viewModel.dispatch(HomeViewModel.HomeIntent.Refresh) }

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("简报", style = MaterialTheme.typography.titleLarge)

        Card(
            shape = RoundedCornerShape(20.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
        ) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                when {
                    state.loading -> CircularProgressIndicator()
                    state.error != null -> Text("连接失败：${state.error}", style = MaterialTheme.typography.bodyMedium)
                    else -> {
                        Text("今日营收 ¥${state.report?.revenue ?: 0.0}", style = MaterialTheme.typography.titleMedium)
                        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                            Text("订单 ${state.report?.orders ?: 0}", style = MaterialTheme.typography.bodyMedium)
                            Text("rev ${state.rev ?: "-"}", style = MaterialTheme.typography.bodySmall)
                        }
                        if (state.stale) {
                            Text("数据已过期，请刷新", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
        }

        Button(onClick = { viewModel.dispatch(HomeViewModel.HomeIntent.Refresh) }) {
            Text("刷新")
        }
    }
}
