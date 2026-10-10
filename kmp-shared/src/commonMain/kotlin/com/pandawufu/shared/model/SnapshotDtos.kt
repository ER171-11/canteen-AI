package com.pandawufu.shared.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

/** GET /api/snapshot/latest → {ok, rev, generated_at, size, data, ext} */
@Serializable
data class SnapshotDto(
    val ok: Boolean = false,
    /** BFF 可能返回数字或字符串 */
    val rev: JsonElement? = null,
    @SerialName("generated_at") val generatedAt: String? = null,
    val size: Int? = null,
    val data: SnapshotDataDto? = null,
    /** 扩展字段：recipes / staff_* / fs_* / bookings 等数组对象 */
    val ext: JsonObject? = null
) {
    fun revText(): String =
        rev?.jsonPrimitive?.contentOrNull
            ?: rev?.jsonPrimitive?.intOrNull?.toString()
            ?: ""
}

@Serializable
data class SnapshotDataDto(
    /** 163 条真实原料 */
    val ings: List<IngredientDto> = emptyList(),
    val dishes: List<DishDto> = emptyList(),
    /** 进货入库 JH */
    val recv: List<RecvRecordDto> = emptyList(),
    /** 采购单 CG（草稿/在途，不入库） */
    val orders: List<RecvRecordDto> = emptyList(),
    /** POS 桌台（8 桌） */
    val pos: List<PosTableDto> = emptyList(),
    val sales: List<SaleLineDto> = emptyList(),
    val quotes: List<QuoteDto> = emptyList(),
    val platforms: List<PlatformDto> = emptyList(),
    /** 供应商名字符串列表（店内实发，兼容） */
    val suppliers: List<String> = emptyList(),
    /** 供应商档案（结构化，vendor.upsert 写入） */
    val vendors: List<VendorDto> = emptyList()
)

@Serializable
data class VendorDto(
    val id: String? = null,
    @SerialName("vendor_id") val vendorId: String? = null,
    val name: String,
    val contact: String? = null,
    val phone: String? = null,
    val category: String? = null,
    val level: String? = null,
    val rating: Double? = null,
    val status: String? = null,
    /** 账期：月结30天 / 周结 / 现结 */
    val period: String? = null,
    val note: String? = null
) {
    fun resolvedId(): String = id ?: vendorId ?: name
}

@Serializable
data class SaleLineDto(
    val id: String? = null,
    val name: String? = null,
    val amount: Double? = null,
    val total: Double? = null,
    val revenue: Double? = null,
    val ts: String? = null,
    val date: String? = null,
    val platform: String? = null
)

@Serializable
data class QuoteDto(
    val id: String? = null,
    val ing: String? = null,
    val name: String? = null,
    val src: String? = null,
    val supplier: String? = null,
    val price: Double? = null,
    val unit: String? = null,
    val per: String? = null,
    val date: String? = null,
    val note: String? = null
)

@Serializable
data class PlatformDto(
    val id: String? = null,
    val name: String? = null,
    val tpl: String? = null,
    val orders: Int? = null,
    val rating: Double? = null,
    val status: String? = null
)

/** 店内快照 suppliers 现为字符串数组（供应商名） */
typealias SupplierName = String


/**
 * 原料。BFF 仅保证 {id,name,cat,unit}，其余字段宽松探测：
 *  - qty/stock     当前库存量（两种命名都探测）
 *  - safe/safety   安全库存（分档逻辑见 repository/InventoryRepository.kt）
 *  - est           日耗估算（无安全库存时按 est×2 兜底）
 */
@Serializable
data class IngredientDto(
    val id: String,
    val name: String,
    val cat: String? = null,
    val unit: String = "",
    val qty: Double? = null,
    val stock: Double? = null,
    val safe: Double? = null,
    val safety: Double? = null,
    val est: Double? = null,
    val price: Double? = null,
    /** 采购单位 */
    val buy: String? = null,
    /** 包规 */
    val pack: String? = null,
    val moq: String? = null,
    /** 供应商 */
    val sup: String? = null,
    val spec: String? = null,
    val conv: Double? = null,
    val on: Boolean? = null,
    val avg: Double? = null
)

/** 菜品 {id,cat,name,est,price,q,on,cost,sku_id}：q=在售量/今日已售，on=是否在售；cost/gross_margin 来自保本价盘 */
@Serializable
data class DishDto(
    val id: String,
    val cat: String? = null,
    val name: String,
    val est: Double? = null,
    val price: Double? = null,
    val q: Double? = null,
    val on: Boolean = true,
    val cost: Double? = null,
    @SerialName("gross_margin") val grossMargin: Double? = null,
    @SerialName("dish_type") val dishType: String? = null,
    @SerialName("sku_id") val skuId: String? = null,
    @SerialName("baoben_id") val baobenId: String? = null,
    @SerialName("recipe_link") val recipeLink: String? = null,
    /** 是否配了配方（BFF 快照下发时按 ext.recipes 标记）；false = 结账不扣库存（FP-SALE-14） */
    @SerialName("has_recipe") val hasRecipe: Boolean = true
)

/** 进货/采购单据明细行 */
@Serializable
data class RecvLineDto(
    val ing: String? = null,
    val name: String? = null,
    val qty: Double? = null,
    val unit: String? = null,
    val price: Double? = null,
    val amount: Double? = null
)

/** 进货/采购单据（recv 与 orders 字段同构，宽松探测）。 */
@Serializable
data class RecvRecordDto(
    val id: String,
    val no: String? = null,
    val supplier: String? = null,
    val summary: String? = null,
    val note: String? = null,
    val status: String? = null,
    val amount: Double? = null,
    val payable: Double? = null,
    val ts: String? = null,
    val date: String? = null,
    val lines: List<RecvLineDto>? = null
)

/** POS 挂单行（绑桌 bill） */
@Serializable
data class PosBillLineDto(
    val name: String? = null,
    val sku: String? = null,
    @SerialName("sku_id") val skuId: String? = null,
    val qty: Int? = null,
    val price: Double? = null,
    val amount: Double? = null
) {
    fun label(): String = name?.takeIf { it.isNotBlank() } ?: skuId ?: sku ?: "?"
}

/** POS 桌台。state ∈ free(空闲)|busy(就餐)|clean(待清)|rsv(预订) */
@Serializable
data class PosTableDto(
    val id: String,
    val no: String? = null,
    val name: String? = null,
    val state: String = "free",
    val seats: Int? = null,
    val zone: String? = null,
    /** 绑定会员（储值结账联动扣减用） */
    @SerialName("vip_member_id") val vipMemberId: String? = null,
    @SerialName("vip_name") val vipName: String? = null,
    /** 挂单金额（开台/绑桌后） */
    val amount: Double? = null,
    @SerialName("bill_summary") val billSummary: String? = null,
    /** 挂单明细；退菜/加菜据此改数 */
    val bill: List<PosBillLineDto> = emptyList()
)
