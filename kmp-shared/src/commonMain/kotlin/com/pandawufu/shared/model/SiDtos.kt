package com.pandawufu.shared.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * SI（超级智能）收件箱与简报契约。
 *
 * GET /api/report/briefing —— 老板开屏一条人话结论（确定性，无 LLM）
 * GET /api/inbox            —— 需拍板 / SI 正在办 / 异常 / SI 通知 聚合
 */
@Serializable
data class BriefingDto(
    val ok: Boolean = false,
    val mock: Boolean? = null,
    val date: String = "",
    val rev: JsonElement? = null,
    @SerialName("generated_at") val generatedAt: String? = null,
    val headline: String = "",
    val bullets: List<String> = emptyList(),
    val summary: String? = null,
    val todos: List<TodoDto> = emptyList(),
    val alerts: List<AlertDto> = emptyList()
) {
    fun revText(): String =
        rev?.jsonPrimitive?.contentOrNull
            ?: rev?.jsonPrimitive?.intOrNull?.toString()
            ?: ""
}

/** 收件箱单条：可来自动作队列、预警或 SI 通知 */
@Serializable
data class InboxItemDto(
    val id: String = "",
    /** decide | doing | alerts | feed */
    val group: String = "",
    val level: String = "info",
    val title: String = "",
    val summary: String = "",
    val route: String? = null,
    val type: String? = null,
    val status: String? = null,
    val kind: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    val rev: JsonElement? = null
)

@Serializable
data class InboxCountsDto(
    val decide: Int = 0,
    val doing: Int = 0,
    val alerts: Int = 0,
    val feed: Int = 0,
    val total: Int = 0
)

@Serializable
data class InboxDto(
    val ok: Boolean = false,
    val rev: JsonElement? = null,
    @SerialName("generated_at") val generatedAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    val counts: InboxCountsDto = InboxCountsDto(),
    val decide: List<InboxItemDto> = emptyList(),
    val doing: List<InboxItemDto> = emptyList(),
    val alerts: List<InboxItemDto> = emptyList(),
    val feed: List<InboxItemDto> = emptyList()
)

/** SI 规划时调用过的只读工具（供指挥台展示“SI 查了什么”） */
@Serializable
data class AgentStepDto(
    val tool: String = "",
    val args: JsonObject = JsonObject(emptyMap()),
    val ok: Boolean = true
)

@Serializable
data class PushRegisterRequest(
    val token: String,
    val platform: String = "android",
    val account: String? = null
)

@Serializable
data class PushRegisterResponse(
    val ok: Boolean = false,
    val token: String? = null,
    val cloud: Boolean = false
)

@Serializable
data class InboxAckRequest(
    val id: String? = null,
    val all: Boolean? = null
)

@Serializable
data class InboxAckResponse(
    val ok: Boolean = false,
    val unread: Int = 0
)

/* ------------------------------------------------------------------ */
/* 分级授权政策 / 审计                                                  */
/* ------------------------------------------------------------------ */

@Serializable
data class PolicyMatchDto(
    val origin: String = "si",
    val types: List<String> = emptyList(),
    @SerialName("max_amount") val maxAmount: Double = 0.0
)

@Serializable
data class PolicyDto(
    val id: String = "",
    val name: String = "",
    val enabled: Boolean = false,
    val match: PolicyMatchDto = PolicyMatchDto(),
    val tier: Int = 2,
    @SerialName("created_by") val createdBy: String? = null
)

@Serializable
data class PolicyViewDto(
    val ok: Boolean = false,
    @SerialName("auto_enabled") val autoEnabled: Boolean = false,
    val policies: List<PolicyDto> = emptyList(),
    @SerialName("today_auto") val todayAuto: Int = 0,
    @SerialName("never_auto") val neverAuto: List<String> = emptyList()
)

@Serializable
data class PolicyUpsertRequest(
    val id: String? = null,
    val name: String,
    val enabled: Boolean,
    val match: PolicyMatchDto
)

@Serializable
data class PolicyUpsertResponse(
    val ok: Boolean = false,
    val policy: PolicyDto? = null
)

@Serializable
data class PolicyToggleRequest(
    @SerialName("auto_enabled") val autoEnabled: Boolean
)

@Serializable
data class SiAuditResponse(
    val ok: Boolean = false,
    val items: List<JsonObject> = emptyList()
)

/* ------------------------------------------------------------------ */
/* SI 目标 / What-if 模拟                                              */
/* ------------------------------------------------------------------ */

@Serializable
data class GoalItemDto(
    val id: String = "",
    val label: String = "",
    val metric: String = "",
    val target: Double = 0.0,
    val unit: String = "",
    /** gte | lte */
    val dir: String = "gte",
    val current: Double? = null,
    /** on_track | at_risk | off_track | unknown */
    val status: String = "unknown",
    val gap: Double? = null,
    val advice: String = "",
    val route: String? = null
)

@Serializable
data class GoalsViewDto(
    val ok: Boolean = false,
    val items: List<GoalItemDto> = emptyList(),
    val score: Int = 0,
    @SerialName("updated_at") val updatedAt: String? = null,
    val rev: JsonElement? = null
)

@Serializable
data class SimRequest(
    val sku: String? = null,
    val portions: Int = 1,
    @SerialName("price_delta_pct") val priceDeltaPct: Double = 0.0,
    @SerialName("material_name") val materialName: String? = null,
    @SerialName("material_delta_pct") val materialDeltaPct: Double = 0.0
)

@Serializable
data class SimSideDto(
    val price: Double? = null,
    @SerialName("portion_cost") val portionCost: Double? = null,
    @SerialName("gross_margin") val grossMargin: Double? = null,
    @SerialName("batch_cost") val batchCost: Double? = null,
    @SerialName("portion_pieces") val portionPieces: Int? = null
)

@Serializable
data class SimDeltaDto(
    @SerialName("margin_pct") val marginPct: Double? = null,
    @SerialName("portion_cost") val portionCost: Double? = null,
    val profit: Double? = null
)

@Serializable
data class SimMaterialDto(
    val name: String = "",
    @SerialName("need_kg") val needKg: Double = 0.0,
    @SerialName("unit_price") val unitPrice: Double? = null,
    @SerialName("delta_cost") val deltaCost: Double? = null
)

@Serializable
data class SimResultDto(
    val ok: Boolean = false,
    val error: String? = null,
    val sku: String? = null,
    val name: String? = null,
    val available: Int? = null,
    val base: SimSideDto? = null,
    val projected: SimSideDto? = null,
    val delta: SimDeltaDto? = null,
    @SerialName("material_impact") val materialImpact: List<SimMaterialDto> = emptyList(),
    val materials: List<SimMaterialDto> = emptyList(),
    val note: String? = null
)

@Serializable
data class GoalUpsertRequest(
    val id: String,
    val target: Double? = null,
    val label: String? = null,
    val unit: String? = null,
    val dir: String? = null
)

@Serializable
data class PreferencesDto(
    @SerialName("briefing_at") val briefingAt: String = "08:00",
    @SerialName("evening_at") val eveningAt: String = "21:30",
    @SerialName("watch_metrics") val watchMetrics: List<String> = emptyList(),
    @SerialName("muted_alerts") val mutedAlerts: List<String> = emptyList()
)

@Serializable
data class PreferencesResponse(
    val ok: Boolean = false,
    val preferences: PreferencesDto = PreferencesDto()
)

/* ------------------------------------------------------------------ */
/* SI 专家团 / 战役 / 知识                                             */
/* ------------------------------------------------------------------ */

@Serializable
data class RecommendDto(
    val text: String = "",
    val route: String? = null,
    val action: String? = null
)

@Serializable
data class SpecialistDto(
    val id: String = "",
    val name: String = "",
    val icon: String = "",
    val domain: String = "",
    val status: String = "on_track",
    val findings: List<String> = emptyList(),
    val recommends: List<RecommendDto> = emptyList()
)

@Serializable
data class TeamCountsDto(val off: Int = 0, val risk: Int = 0, val on: Int = 0)

@Serializable
data class TeamReviewDto(
    val ok: Boolean = false,
    val rev: JsonElement? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    val summary: String = "",
    val specialists: List<SpecialistDto> = emptyList(),
    val counts: TeamCountsDto = TeamCountsDto()
)

@Serializable
data class MissionKpiDto(
    val metric: String? = null,
    val target: Double = 0.0,
    val unit: String = "",
    val dir: String = "gte"
)

@Serializable
data class MissionStepDto(
    val id: String = "",
    val label: String = "",
    val owner: String = "",
    val route: String? = null,
    @SerialName("action_type") val actionType: String? = null,
    val status: String = "todo",
    @SerialName("done_at") val doneAt: String? = null
)

@Serializable
data class MilestoneDto(
    val id: String = "",
    val label: String = "",
    val status: String = "todo"
)

@Serializable
data class MissionLogDto(val ts: String = "", val text: String = "")

@Serializable
data class MissionDto(
    val id: String = "",
    val title: String = "",
    val objective: String = "",
    val domain: String = "",
    val autonomy: String = "advise",
    val status: String = "active",
    @SerialName("horizon_days") val horizonDays: Int = 14,
    val kpi: MissionKpiDto? = null,
    val milestones: List<MilestoneDto> = emptyList(),
    val steps: List<MissionStepDto> = emptyList(),
    val log: List<MissionLogDto> = emptyList(),
    val checkpoints: Int = 0,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null
) {
    val progress: Int
        get() {
            val total = steps.size
            if (total == 0) return 0
            return (steps.count { it.status == "done" } * 100) / total
        }
}

@Serializable
data class MissionsResponse(
    val ok: Boolean = false,
    val missions: List<MissionDto> = emptyList(),
    val templates: List<String> = emptyList()
)

@Serializable
data class MissionResponse(
    val ok: Boolean = false,
    val mission: MissionDto? = null
)

@Serializable
data class MissionCreateRequest(
    val template: String? = null,
    val title: String? = null,
    val autonomy: String? = null
)

@Serializable
data class MissionAdvanceRequest(
    @SerialName("step_id") val stepId: String? = null
)

@Serializable
data class MissionTickDto(
    val ok: Boolean = false,
    val advanced: Int = 0,
    val digest: List<JsonObject> = emptyList()
)

@Serializable
data class KnowledgePlaybookDto(
    val id: String = "",
    val title: String = "",
    val insight: String = "",
    val evidence: String? = null,
    val recommend: String? = null,
    val route: String? = null,
    val tags: List<String> = emptyList(),
    val source: String? = null
)

@Serializable
data class KnowledgeResponse(
    val ok: Boolean = false,
    val derived: List<KnowledgePlaybookDto> = emptyList(),
    val custom: List<KnowledgePlaybookDto> = emptyList()
)

@Serializable
data class KnowledgeAddRequest(
    val title: String,
    val insight: String = "",
    val tags: List<String> = emptyList()
)

@Serializable
data class KnowledgeAddResponse(
    val ok: Boolean = false,
    val playbook: KnowledgePlaybookDto? = null
)

@Serializable
data class SimpleOkDto(
    val ok: Boolean = false,
    val removed: Boolean = false
)

/* ------------------------------------------------------------------ */
/* SI 主线流程                                                          */
/* ------------------------------------------------------------------ */

@Serializable
data class PipelineItemDto(
    val id: String? = null,
    val title: String = "",
    val sub: String = "",
    val type: String? = null,
    val route: String? = null,
    @SerialName("mission_id") val missionId: String? = null,
    @SerialName("next_step_id") val nextStepId: String? = null,
    @SerialName("next_step_label") val nextStepLabel: String? = null,
    @SerialName("mission_template") val missionTemplate: String? = null
)

@Serializable
data class PipelineStageDto(
    val key: String = "",
    val label: String = "",
    val count: Int = 0,
    /** alert | warn | info | ok */
    val status: String = "ok",
    val text: String = "",
    val route: String? = null,
    val items: List<PipelineItemDto> = emptyList()
)

@Serializable
data class PipelineDto(
    val ok: Boolean = false,
    val rev: JsonElement? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    val headline: String = "",
    val stages: List<PipelineStageDto> = emptyList(),
    @SerialName("next_key") val nextKey: String = "watch"
)

/* ------------------------------------------------------------------ */
/* 老板全局驾驶舱                                                      */
/* ------------------------------------------------------------------ */

@Serializable
data class CockpitKpisDto(
    @SerialName("revenue_today") val revenueToday: Double = 0.0,
    @SerialName("breakeven_day") val breakevenDay: Double? = null,
    @SerialName("attain_pct") val attainPct: Double? = null,
    @SerialName("gross_margin_pct") val grossMarginPct: Double? = null,
    @SerialName("loss_rate_pct") val lossRatePct: Double? = null,
    @SerialName("avg_ticket") val avgTicket: Double? = null,
    @SerialName("daily_avg_revenue") val dailyAvgRevenue: Double? = null
)

@Serializable
data class CockpitGoalDto(
    val label: String = "",
    val status: String = "",
    val current: Double? = null,
    val target: Double? = null,
    val unit: String = "",
    val advice: String = ""
)

@Serializable
data class CockpitSpecialistDto(
    val id: String = "",
    val name: String = "",
    val icon: String = "",
    val status: String = "on_track",
    val finding: String = ""
)

@Serializable
data class CockpitTeamDto(
    val counts: TeamCountsDto = TeamCountsDto(),
    val summary: String = "",
    val specialists: List<CockpitSpecialistDto> = emptyList()
)

@Serializable
data class CockpitNextDto(
    val key: String = "",
    val label: String = "",
    val text: String = "",
    val count: Int = 0,
    val route: String? = null,
    val status: String = "ok"
)

@Serializable
data class CockpitStageDto(
    val key: String = "",
    val label: String = "",
    val status: String = "ok",
    val count: Int = 0,
    val text: String = ""
)

@Serializable
data class CockpitInboxDto(
    val decide: Int = 0,
    val doing: Int = 0,
    val alerts: Int = 0
)

@Serializable
data class CockpitMissionDto(
    val id: String = "",
    val title: String = "",
    val progress: Int = 0
)

@Serializable
data class CockpitTrendDto(
    val date: String = "",
    val revenue: Double = 0.0
)

@Serializable
data class CockpitQueueDto(
    @SerialName("pending_confirm") val pendingConfirm: Int = 0,
    @SerialName("pending_execute") val pendingExecute: Int = 0,
    @SerialName("oldest_execute_min") val oldestExecuteMin: Int = 0,
    val stalled: Boolean = false
)

@Serializable
data class CockpitDto(
    val ok: Boolean = false,
    val rev: JsonElement? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    val headline: String = "",
    val kpis: CockpitKpisDto? = null,
    @SerialName("goal_score") val goalScore: Int = 0,
    @SerialName("goals_alert") val goalsAlert: List<CockpitGoalDto> = emptyList(),
    val team: CockpitTeamDto? = null,
    val next: CockpitNextDto? = null,
    val stages: List<CockpitStageDto> = emptyList(),
    val inbox: CockpitInboxDto? = null,
    val queue: CockpitQueueDto? = null,
    val advice: List<String> = emptyList(),
    val trend: List<CockpitTrendDto> = emptyList(),
    val missions: List<CockpitMissionDto> = emptyList()
)
