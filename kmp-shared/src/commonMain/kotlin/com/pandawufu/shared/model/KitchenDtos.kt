package com.pandawufu.shared.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** GET /api/kitchen/recipes 列表项 */
@Serializable
data class RecipeDto(
    @SerialName("sku_id") val skuId: String,
    val name: String,
    /** 五色别：红/黑/黄/绿/紫/白/其他（热/凉/汤/甜） */
    val color: String? = null,
    val filling: String? = null,
    @SerialName("face_main") val faceMain: String? = null,
    // BOM：BFF 未公布元素结构，按字符串行解析；若为对象数组需收紧为 BomLineDto
    val main: List<String> = emptyList(),
    val aux: List<String> = emptyList(),
    val seasoning: List<String> = emptyList(),
    val steps: List<String> = emptyList(),
    val params: JsonObject? = null,
    val blessing: String? = null,
    @SerialName("diet_tags") val dietTags: List<String> = emptyList(),
    val version: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null
)

@Serializable
data class RecipesResponse(
    val ok: Boolean = false,
    val items: List<RecipeDto> = emptyList(),
    val rev: String = ""
)

/** SOP 步骤（配方详情与工单共用） */
@Serializable
data class SopStepDto(
    @SerialName("sku_id") val skuId: String? = null,
    @SerialName("step_no") val stepNo: Int = 0,
    val stage: String = "",
    @SerialName("duration_min") val durationMin: Int? = null,
    val tools: List<String> = emptyList(),
    val inputs: List<String> = emptyList(),
    @SerialName("key_points") val keyPoints: List<String> = emptyList(),
    @SerialName("qc_point") val qcPoint: String? = null,
    val risk: String? = null,
    val params: JsonObject? = null
)

@Serializable
data class RecipeDetailResponse(
    val ok: Boolean = false,
    val item: RecipeDto? = null,
    val steps: List<SopStepDto> = emptyList()
)

/** GET /api/sop/workorder?date= */
@Serializable
data class WorkorderDto(
    val id: String,
    @SerialName("sku_id") val skuId: String,
    val name: String,
    val color: String? = null,
    val qty: Int = 0,
    @SerialName("planned_start") val plannedStart: String? = null,
    val status: String = "pending",
    val steps: List<SopStepDto> = emptyList()
)

@Serializable
data class WorkordersResponse(
    val ok: Boolean = false,
    val date: String? = null,
    val workorders: List<WorkorderDto> = emptyList()
)

/** GET /api/kitchen/qc?date= —— BFF 未公布 item 结构，宽松建模，补契约后收紧 */
@Serializable
data class QcRecordDto(
    val id: String? = null,
    @SerialName("sku_id") val skuId: String? = null,
    val name: String? = null,
    val color: String? = null,
    @SerialName("check_type") val checkType: String? = null,
    val result: String? = null,
    val rate: Double? = null,
    val note: String? = null,
    val inspector: String? = null,
    val ts: String? = null
)

@Serializable
data class QcResponse(
    val ok: Boolean = false,
    val items: List<QcRecordDto> = emptyList()
)

/** GET /api/kitchen/board?date= → {ok, items:[{color, planned, done, qc_pass_rate}]} */
@Serializable
data class BoardItemDto(
    val color: String,
    val planned: Int = 0,
    val done: Int = 0,
    @SerialName("qc_pass_rate") val qcPassRate: Double? = null
)

@Serializable
data class BoardResponse(
    val ok: Boolean = false,
    val items: List<BoardItemDto> = emptyList()
)

/** POST /api/auth/login {account, device_fp} */
@Serializable
data class LoginRequest(val account: String, @SerialName("device_fp") val deviceFp: String)

@Serializable
data class LoginResponse(
    val ok: Boolean = false,
    val token: String? = null,
    val error: String? = null
)
