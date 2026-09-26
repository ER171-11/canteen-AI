package com.pandawufu.shared.repository

import com.pandawufu.shared.model.IngredientDto
import com.pandawufu.shared.model.PosTableDto
import com.pandawufu.shared.model.RecvRecordDto
import com.pandawufu.shared.model.RestockSuggestItemDto
import com.pandawufu.shared.model.SnapshotDataDto
import com.pandawufu.shared.model.SnapshotDto
import com.pandawufu.shared.network.BffClient

/** 库存状态三档（对齐原型 inv-stock 的 tag：充足/偏低/告急） */
enum class StockStatus(val label: String) { ENOUGH("充足"), LOW("偏低"), CRITICAL("告急") }

/** 原料 + 当前量 + 安全线 + 状态 */
data class StockItem(
    val ingredient: IngredientDto,
    val qty: Double,
    val safety: Double,
    val status: StockStatus
)

/** 补货建议（优先 BFF 日耗估算；回退安全线；转单必须走 ConfirmGateway → orders 草稿） */
data class RestockSuggestion(
    val ingredientId: String,
    val name: String,
    val unit: String,
    val suggestQty: Double,
    val reason: String,
    val qty: Double? = null,
    val safe: Double? = null,
    val daysLeft: Double? = null,
    val urgency: String? = null,
    val source: String? = null
)

/**
 * 安全库存分档规则（Sprint 1 定版，仍用于库存 Tab 色标）：
 *  1. 安全线取值：ing.safe ?: ing.safety ?: ing.est × 2
 *  2. ratio = qty / safety：
 *     ratio < 0.30        → 告急 CRITICAL
 *     0.30 ≤ ratio < 0.75 → 偏低 LOW
 *     ratio ≥ 0.75        → 充足 ENOUGH
 */
object StockPolicy {
    const val CRITICAL_RATIO = 0.30
    const val LOW_RATIO = 0.75

    fun resolveSafety(ing: IngredientDto): Double {
        ing.safe?.let { if (it > 0) return it }
        ing.safety?.let { if (it > 0) return it }
        ing.est?.let { if (it > 0) return it * 2 }
        // 无档案时：零库存按安全线 1 告急；有量不误判为充足（避免补货链空转）
        val qty = ing.qty ?: ing.stock ?: 0.0
        return if (qty <= 0.0) 1.0 else 0.0
    }

    fun classify(qty: Double, safety: Double): StockStatus {
        if (safety <= 0.0) return StockStatus.ENOUGH
        val ratio = qty / safety
        return when {
            ratio < CRITICAL_RATIO -> StockStatus.CRITICAL
            ratio < LOW_RATIO -> StockStatus.LOW
            else -> StockStatus.ENOUGH
        }
    }

    fun toStockItem(ing: IngredientDto): StockItem {
        val qty = ing.qty ?: ing.stock ?: 0.0
        val safety = resolveSafety(ing)
        return StockItem(ing, qty, safety, classify(qty, safety))
    }

    /** 本地回退：补到安全线（无 BFF 建议时） */
    fun toSuggestion(item: StockItem): RestockSuggestion =
        RestockSuggestion(
            ingredientId = item.ingredient.id,
            name = item.ingredient.name,
            unit = item.ingredient.unit,
            suggestQty = (item.safety - item.qty).coerceAtLeast(0.0),
            reason = "安全线 ${item.safety}${item.ingredient.unit}，现 ${item.qty}${item.ingredient.unit}（${item.status.label}）",
            qty = item.qty,
            safe = item.safety,
            source = "safety_fallback"
        )

    fun fromBff(item: RestockSuggestItemDto): RestockSuggestion =
        RestockSuggestion(
            ingredientId = item.ingredientId,
            name = item.name,
            unit = item.unit,
            suggestQty = item.suggestQty,
            reason = item.reason,
            qty = item.qty,
            safe = item.safe,
            daysLeft = item.daysLeft,
            urgency = item.urgency,
            source = item.source
        )
}

/** 进销存（库存/补货/采购/进货 + POS 桌台） */
interface InventoryRepository {
    suspend fun snapshot(): SnapshotDto
    suspend fun stockItems(): List<StockItem>
    suspend fun restockSuggestions(): List<RestockSuggestion>
    suspend fun purchaseOrders(): List<RecvRecordDto>
    suspend fun recvRecords(): List<RecvRecordDto>
    suspend fun posTables(): List<PosTableDto>
}

class InventoryRepositoryImpl(private val bff: BffClient) : InventoryRepository {

    override suspend fun snapshot(): SnapshotDto {
        return try {
            val s = bff.snapshotLatest()
            // 404 体可能解成 ok=false；空开成空快照，避免进销整页失败
            if (!s.ok && s.data == null && s.revText().isEmpty()) {
                SnapshotDto(ok = true, data = SnapshotDataDto())
            } else {
                s
            }
        } catch (e: Exception) {
            val fail = com.pandawufu.shared.util.LoadFailure.from(e)
            if (fail.soft) SnapshotDto(ok = true, data = SnapshotDataDto()) else throw e
        }
    }

    override suspend fun stockItems(): List<StockItem> =
        snapshot().data?.ings.orEmpty().map(StockPolicy::toStockItem)

    override suspend fun restockSuggestions(): List<RestockSuggestion> {
        val remote = runCatching { bff.restockSuggest() }.getOrNull()
        if (remote != null && remote.ok && remote.items.isNotEmpty()) {
            return remote.items.map(StockPolicy::fromBff)
        }
        // 本地回退也只取告急/偏低前 15，避免首页一键变成上百项
        return stockItems()
            .filter { it.status != StockStatus.ENOUGH }
            .sortedWith(
                compareBy<StockItem> {
                    when (it.status) {
                        StockStatus.CRITICAL -> 0
                        StockStatus.LOW -> 1
                        StockStatus.ENOUGH -> 2
                    }
                }.thenByDescending { it.safety - it.qty }
            )
            .take(15)
            .map(StockPolicy::toSuggestion)
    }

    override suspend fun purchaseOrders(): List<RecvRecordDto> =
        snapshot().data?.orders.orEmpty()

    override suspend fun recvRecords(): List<RecvRecordDto> =
        snapshot().data?.recv.orEmpty()

    override suspend fun posTables(): List<PosTableDto> =
        snapshot().data?.pos.orEmpty()
}
