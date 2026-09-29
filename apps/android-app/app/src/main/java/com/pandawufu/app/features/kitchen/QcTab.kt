package com.pandawufu.app.features.kitchen

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.AppModule
import com.pandawufu.app.confirm.KimiCtaByType
import com.pandawufu.shared.viewmodel.KitchenViewModel
import com.pandawufu.shared.viewmodel.QcMediaViewModel

/**
 * 品控 = 后厨第3步：成品/摆盘拍照判定（A 块）+ 留样/着装合规识别。
 * 拍照判定主体见 [QcMediaSection]；下方保留留样/着装两条服务端 CTA 作为补充。
 */
@Composable
fun QcTab(state: KitchenViewModel.KitchenState) {
    val qcVm = remember {
        QcMediaViewModel(
            kitchenRepository = AppModule.kitchenRepository,
            kimiRepository = AppModule.kimiRepository,
            mediaRepository = AppModule.qcMediaRepository,
            today = null,
            defaultStation = AppModule.storeName,
            nowMs = { System.currentTimeMillis() }
        )
    }
    LaunchedEffect(Unit) {
        qcVm.dispatch(QcMediaViewModel.QcMediaIntent.LoadMediaStatus)
        qcVm.dispatch(QcMediaViewModel.QcMediaIntent.Refresh)
    }

    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { QcMediaSection(qcVm, state) }

        item {
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        "其它合规识别（服务端 CTA）",
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold
                    )
                    Text("留样与着装合规仍走确认台入账。", fontSize = 12.sp, color = Sub)
                    KimiCtaByType("sample", baseRev = state.rev)
                    KimiCtaByType("uniform", baseRev = state.rev)
                }
            }
        }
    }
}
