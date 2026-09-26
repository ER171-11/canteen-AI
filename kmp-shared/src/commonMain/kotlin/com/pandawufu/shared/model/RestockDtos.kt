package com.pandawufu.shared.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

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
    val urgency: String? = null
)
