package com.pandawufu.shared.repository

import com.pandawufu.shared.model.IngredientDto
import com.pandawufu.shared.model.PosTableDto
import com.pandawufu.shared.model.RecvRecordDto
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

/** 补货建议（由告急/偏低项推导；AI 建议·需确认，转单必须走 ConfirmGateway） */
data class RestockSuggestion(
    val ingredientId: String,
    val name: String,
    val unit: String,
    val suggestQty: Double,
    val reason: String
)

/**
 * 安全库存分档规则（Sprint 1 定版）：
 *  1. 安全线取值：ing.safe ?: ing.safety ?: ing.est × 2（est 为日耗估算，×2 = 两日安全垫）。
 *     三者皆缺时安全线=当前量（状态恒为充足），避免误报告急。
 *  2. ratio = qty / safety：
 *     ratio < 0.30        → 告急 CRITICAL（原型：0.44/2=22% → 告急）
 *     0.30 ≤ ratio < 0.75 → 偏低 LOW     （原型：0.9/2=45%、0.18/0.4=45% → 偏低）
 *     ratio ≥ 0.75        → 充足 ENOUGH  （原型：12.5/15=83%、6.2/8=77% → 充足）
 *  阈值取自原型 inv-stock 的 6 条样例反推，BFF 出正式规则后在此替换。
 */
object StockPolicy {
    const val CRITICAL_RATIO = 0.30
    const val LOW_RATIO = 0.75

    fun resolveSafety(ing: IngredientDto): Double {
        ing.safe?.let { if (it > 0) return it }
        ing.safety?.let { if (it > 0) return it }
        ing.est?.let { if (it > 0) return it * 2 }
        return (ing.qty ?: ing.stock ?: 0.0).coerceAtLeast(0.0)
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

    /** 由库存项推导补货建议（补到安全线），告急/偏低项才应传入 */
    fun toSuggestion(item: StockItem): RestockSuggestion =
        RestockSuggestion(
            ingredientId = item.ingredient.id,
            name = item.ingredient.name,
            unit = item.ingredient.unit,
            suggestQty = (item.safety - item.qty).coerceAtLeast(0.0),
            reason = "安全线 ${item.safety}${item.ingredient.unit}，现 ${item.qty}${item.ingredient.unit}（${item.status.label}）"
        )
}

/** 进销存（库存/补货/采购/进货 + POS 桌台，全部只读快照） */
interface InventoryRepository {
    suspend fun snapshot(): SnapshotDto
    suspend fun stockItems(): List<StockItem>
    suspend fun restockSuggestions(): List<RestockSuggestion>
    suspend fun recvRecords(): List<RecvRecordDto>
    suspend fun posTables(): List<PosTableDto>
}

class InventoryRepositoryImpl(private val bff: BffClient) : InventoryRepository {

    override suspend fun snapshot(): SnapshotDto = bff.snapshotLatest()

    override suspend fun stockItems(): List<StockItem> =
        snapshot().data?.ings.orEmpty().map(StockPolicy::toStockItem)

    override suspend fun restockSuggestions(): List<RestockSuggestion> =
        stockItems()
            .filter { it.status != StockStatus.ENOUGH }
            .sortedByDescending { it.safety - it.qty }
            .map(StockPolicy::toSuggestion)

    override suspend fun recvRecords(): List<RecvRecordDto> =
        snapshot().data?.recv.orEmpty()

    override suspend fun posTables(): List<PosTableDto> =
        snapshot().data?.pos.orEmpty()
}
