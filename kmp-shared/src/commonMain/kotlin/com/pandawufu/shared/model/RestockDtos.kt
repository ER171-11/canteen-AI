package com.pandawufu.shared.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/** GET /api/inventory/restock-suggest */
@Serializable
data class RestockSuggestResponse(
    val ok: Boolean = false,
    val mock: Boolean? = null,
    val source: String? = null,
    val count: Int = 0,
    /** 可办项总数（截断前） */
    val total: Int? = null,
    val truncated: Boolean? = null,
    val items: List<RestockSuggestItemDto> = emptyList(),
    val banner: String? = null
)

@Serializable
data class RestockSuggestItemDto(
    @SerialName("ingredientId") val ingredientId: String = "",
    val name: String = "",
    val unit: String = "",
    /** 现存量 */
    val qty: Double? = null,
    /** 安全线 */
    val safe: Double? = null,
    @SerialName("suggestQty") val suggestQty: Double = 0.0,
    val daily: Double? = null,
    @SerialName("daysLeft") val daysLeft: Double? = null,
    val reason: String = "",
    val source: String? = null,
    val urgency: String? = null,
    /** 验收标准规格要求：采购员照着买 */
    @SerialName("spec_req") val specReq: String? = null
)

/** GET /api/inventory/accept-standards */
@Serializable
data class AcceptStandardDto(
    @SerialName("ing_name") val ingName: String = "",
    val brand: String? = null,
    @SerialName("spec_req") val specReq: String? = null,
    val sensory: String? = null,
    @SerialName("weight_tol_pct") val weightTolPct: Double? = null,
    @SerialName("temp_req") val tempReq: String? = null,
    @SerialName("shelf_life_req") val shelfLifeReq: String? = null,
    @SerialName("cert_req") val certReq: String? = null
)

@Serializable
data class AcceptStandardsResponse(
    val ok: Boolean = false,
    val count: Int = 0,
    val standards: List<AcceptStandardDto> = emptyList(),
    val source: String? = null
)

/** GET /api/inventory/recv-accept?date= */
@Serializable
data class RecvAcceptRecordDto(
    @SerialName("recv_id") val recvId: String? = null,
    @SerialName("ing_name") val ingName: String? = null,
    @SerialName("qty_ordered") val qtyOrdered: Double? = null,
    @SerialName("qty_received") val qtyReceived: Double? = null,
    @SerialName("qty_rejected") val qtyRejected: Double? = null,
    val verdict: String? = null,
    val detail: JsonElement? = null,
    @SerialName("batch_no") val batchNo: String? = null,
    @SerialName("cert_no") val certNo: String? = null,
    val ts: String? = null,
    val source: String? = null
)

@Serializable
data class RecvAcceptResponse(
    val ok: Boolean = false,
    val date: String? = null,
    val count: Int = 0,
    val items: List<RecvAcceptRecordDto> = emptyList(),
    val records: List<RecvAcceptRecordDto> = emptyList()
) {
    fun all(): List<RecvAcceptRecordDto> = if (items.isNotEmpty()) items else records
}
