package com.pandawufu.shared.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** GET /api/snapshot/latest → {ok, rev, generated_at, size, data, ext} */
@Serializable
data class SnapshotDto(
    val ok: Boolean = false,
    val rev: String = "",
    @SerialName("generated_at") val generatedAt: String? = null,
    val size: Int? = null,
    val data: SnapshotDataDto? = null,
    /** 扩展字段（BFF 预留），保持透传 */
    val ext: Map<String, String>? = null
)

@Serializable
data class SnapshotDataDto(
    /** 163 条真实原料 */
    val ings: List<IngredientDto> = emptyList(),
    val dishes: List<DishDto> = emptyList(),
    val recv: List<RecvRecordDto> = emptyList(),
    /** POS 桌台（8 桌） */
    val pos: List<PosTableDto> = emptyList()
)

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
    val price: Double? = null
)

/** 菜品 {id,cat,name,est,price,q,on}：q=在售量/今日已售，on=是否在售 */
@Serializable
data class DishDto(
    val id: String,
    val cat: String? = null,
    val name: String,
    val est: Double? = null,
    val price: Double? = null,
    val q: Double? = null,
    val on: Boolean = true
)

/** 进货入库记录（recv）。字段宽松，BFF 补契约后收紧。 */
@Serializable
data class RecvRecordDto(
    val id: String,
    val supplier: String? = null,
    val summary: String? = null,
    val status: String? = null,
    val amount: Double? = null,
    val ts: String? = null
)

/** POS 桌台。state ∈ free(空闲)|busy(就餐)|clean(待清)|rsv(预订) */
@Serializable
data class PosTableDto(
    val id: String,
    val no: String? = null,
    val state: String = "free",
    val seats: Int? = null
)
