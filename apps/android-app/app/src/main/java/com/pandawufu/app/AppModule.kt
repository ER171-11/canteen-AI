package com.pandawufu.app

import com.pandawufu.shared.network.BffClient
import com.pandawufu.shared.network.SseClient
import com.pandawufu.shared.redline.ConfirmGateway
import com.pandawufu.shared.repository.ActionRepositoryImpl
import com.pandawufu.shared.repository.HealthRepositoryImpl
import com.pandawufu.shared.repository.KimiRepositoryImpl
import com.pandawufu.shared.repository.ReportRepositoryImpl
import com.pandawufu.shared.repository.SnapshotRepositoryImpl

/**
 * 极简服务定位（骨架阶段免 DI 框架）。
 * 模拟器访问宿主机 BFF 用 10.0.2.2；真机改为局域网地址。
 */
object AppModule {
    private const val BFF_BASE_URL = "http://10.0.2.2:8787"

    // TODO: 登录后注入真实 Bearer token
    val bffClient = BffClient(baseUrl = BFF_BASE_URL, tokenProvider = { null })
    val sseClient = SseClient(bffClient)

    val healthRepository = HealthRepositoryImpl(bffClient)
    val snapshotRepository = SnapshotRepositoryImpl(bffClient)
    val reportRepository = ReportRepositoryImpl(bffClient)
    val actionRepository = ActionRepositoryImpl(bffClient)
    val kimiRepository = KimiRepositoryImpl(bffClient, sseClient)

    fun initRedline() {
        ConfirmGateway.init(actionRepository)
    }
}
