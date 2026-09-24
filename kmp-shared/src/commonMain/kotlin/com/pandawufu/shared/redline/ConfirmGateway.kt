package com.pandawufu.shared.redline

import com.pandawufu.shared.model.ActionDto
import com.pandawufu.shared.model.ActionStatus
import com.pandawufu.shared.repository.ActionRepository

/**
 * 红线网关 —— 端侧任何写操作的唯一入口。
 *
 * ⚠ 禁止绕过 ⚠
 *  - UI / ViewModel / 业务代码一律不得直接调用 ActionRepository 或 BffClient.postAction；
 *  - 禁止端侧写库（SQLDelight 仅存撤销栈与草稿，不含业务数据写）；
 *  - 预测 ≠ 下单：AI 预测 UI 之后必须经由 create(PENDING) → 用户确认 → confirm() 两段式提交；
 *  - 服务端 rev 冲突由 RedlineGuard 在确认前检测。
 */
class ConfirmGateway(private val actionRepository: ActionRepository) {

    /** 第一段：生成待确认动作（草稿态）。 */
    suspend fun propose(type: String, payload: Map<String, String>, baseRev: String? = null): ActionDto =
        actionRepository.create(
            ActionDto(
                id = newActionId(),
                type = type,
                payload = payload,
                status = ActionStatus.PENDING,
                baseRev = baseRev
            )
        )

    /** 第二段：用户确认后提交执行。rev 过期时调用方必须先走 RedlineGuard 刷新。 */
    suspend fun confirm(action: ActionDto): ActionDto =
        actionRepository.confirm(action)

    private fun newActionId(): String =
        "act-${kotlin.random.Random.nextLong().toString(16)}-${kotlin.random.Random.nextInt(0, 0xFFFF)}"

    companion object {
        /** 进程内单例。App 启动时通过 [init] 注入实现；测试可注入 mock。 */
        @Volatile
        private var instance: ConfirmGateway? = null

        fun init(actionRepository: ActionRepository): ConfirmGateway =
            instance ?: synchronized(this) {
                instance ?: ConfirmGateway(actionRepository).also { instance = it }
            }

        val shared: ConfirmGateway
            get() = instance ?: error("ConfirmGateway 未初始化：请在 App 启动时调用 ConfirmGateway.init(...)")
    }
}
