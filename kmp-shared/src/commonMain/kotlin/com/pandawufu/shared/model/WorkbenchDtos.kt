package com.pandawufu.shared.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** 采购工作台：按需求×菜谱BOM→库存缺口→采购清单 */
@Serializable
data class WbProcurementLineDto(
    val name: String = "",
    val unit: String = "斤",
    val need: Double = 0.0,
    val have: Double = 0.0,
    val safe: Double? = null,
    val gap: Double = 0.0,
    val grams: Int = 0,
    val price: Double = 0.0,
    val estimated: Double = 0.0
)

@Serializable
data class WbRestockItemDto(
    val name: String = "",
    val qty: Double = 0.0,
    val unit: String = "斤",
    val price: Double = 0.0
)

@Serializable
data class WbRestockPayloadDto(
    val supplier: String = "",
    val note: String = "",
    val items: List<WbRestockItemDto> = emptyList()
)

@Serializable
data class ProcurementWorkbenchDto(
    val ok: Boolean = false,
    val date: String = "",
    @SerialName("demand_portions") val demandPortions: Map<String, Double> = emptyMap(),
    @SerialName("demand_total") val demandTotal: Double = 0.0,
    @SerialName("need_lines") val needLines: List<WbProcurementLineDto> = emptyList(),
    @SerialName("to_buy") val toBuy: List<WbProcurementLineDto> = emptyList(),
    val missing: List<String> = emptyList(),
    @SerialName("est_total") val estTotal: Double = 0.0,
    @SerialName("restock_payload") val restockPayload: WbRestockPayloadDto? = null,
    @SerialName("accept_standards") val acceptStandards: Int = 0,
    val rev: Int? = null
)

/** 厨师工作台：今日工单 + 菜谱标准 + 品控 */
@Serializable
data class WbKitchenParamsDto(
    @SerialName("醒发") val ferment: String? = null,
    @SerialName("剂子") val dough: String? = null,
    @SerialName("成品") val finished: String? = null,
    @SerialName("点凉水") val water: String? = null
)

@Serializable
data class WbWorkorderDto(
    val id: String? = null,
    @SerialName("sku_id") val skuId: String? = null,
    val name: String? = null,
    val qty: Double = 0.0,
    val status: String = "",
    val steps: Int = 0,
    val params: WbKitchenParamsDto? = null,
    @SerialName("qc_total") val qcTotal: Int = 0,
    @SerialName("qc_pass") val qcPass: Int = 0,
    @SerialName("qc_rate") val qcRate: Int? = null
)

@Serializable
data class WbStandardsDto(
    val recipes: Int = 0,
    @SerialName("sop_steps") val sopSteps: Int = 0,
    val note: String? = null
)

@Serializable
data class KitchenWorkbenchDto(
    val ok: Boolean = false,
    val date: String = "",
    val workorders: List<WbWorkorderDto> = emptyList(),
    val planned: Double = 0.0,
    val standards: WbStandardsDto? = null,
    @SerialName("qc_pending") val qcPending: Int = 0,
    val advice: List<String> = emptyList(),
    val rev: Int? = null
)

/** 到货验收工作台 */
@Serializable
data class WbRecvLineDto(
    val name: String = "",
    val qty: Double = 0.0,
    val unit: String = "",
    @SerialName("spec_req") val specReq: String? = null
)

@Serializable
data class WbRecvOrderDto(
    val id: String? = null,
    val no: String? = null,
    val supplier: String = "",
    val date: String = "",
    val status: String = "",
    val lines: List<WbRecvLineDto> = emptyList()
)

@Serializable
data class RecvWorkbenchDto(
    val ok: Boolean = false,
    val date: String = "",
    val orders: List<WbRecvOrderDto> = emptyList(),
    val standards: Int = 0,
    val note: String? = null,
    val rev: Int? = null
)
