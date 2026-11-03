package com.pandawufu.shared.repository

import com.pandawufu.shared.model.IngredientDto
import kotlin.test.Test
import kotlin.test.assertEquals

class StockPolicyTest {

    @Test
    fun safetyPrefersExplicitSafeThenSafetyThenEstTimesTwo() {
        assertEquals(2.0, StockPolicy.resolveSafety(IngredientDto(id = "1", name = "a", safe = 2.0, safety = 9.0, est = 5.0)))
        assertEquals(3.0, StockPolicy.resolveSafety(IngredientDto(id = "2", name = "b", safety = 3.0, est = 5.0)))
        assertEquals(10.0, StockPolicy.resolveSafety(IngredientDto(id = "3", name = "c", est = 5.0))) // est×2
    }

    @Test
    fun safetyIsUnknownWhenNoArchiveButStocked() {
        // 口径变更（4fafbd2）：无档案（safe/safety/est 全缺）时不再拿 qty 当安全线，
        // 有量 → 安全线 0（没有安全线就不编造），判「充足」而不是误报告急
        val ing = IngredientDto(id = "4", name = "d", qty = 7.5)
        assertEquals(0.0, StockPolicy.resolveSafety(ing))
        assertEquals(StockStatus.ENOUGH, StockPolicy.toStockItem(ing).status) // 不误报告急
    }

    @Test
    fun safetyIsOneWhenNoArchiveAndEmpty() {
        // 零库存且无档案 → 安全线按 1 兜底，判告急（避免补货链空转）
        val ing = IngredientDto(id = "6", name = "e", qty = 0.0)
        assertEquals(1.0, StockPolicy.resolveSafety(ing))
        assertEquals(StockStatus.CRITICAL, StockPolicy.toStockItem(ing).status)
    }

    @Test
    fun classifyBoundariesMatchPrototypeSamples() {
        // 原型 inv-stock 样例：0.44/2=22% 告急；0.9/2=45% 偏低；12.5/15=83% 充足；6.2/8=77% 充足
        assertEquals(StockStatus.CRITICAL, StockPolicy.classify(0.44, 2.0))
        assertEquals(StockStatus.LOW, StockPolicy.classify(0.9, 2.0))
        assertEquals(StockStatus.LOW, StockPolicy.classify(0.18, 0.4))
        assertEquals(StockStatus.ENOUGH, StockPolicy.classify(12.5, 15.0))
        assertEquals(StockStatus.ENOUGH, StockPolicy.classify(6.2, 8.0))
    }

    @Test
    fun classifyThresholdEdges() {
        assertEquals(StockStatus.CRITICAL, StockPolicy.classify(0.29, 1.0))
        assertEquals(StockStatus.LOW, StockPolicy.classify(0.30, 1.0))
        assertEquals(StockStatus.LOW, StockPolicy.classify(0.749, 1.0))
        assertEquals(StockStatus.ENOUGH, StockPolicy.classify(0.75, 1.0))
        assertEquals(StockStatus.ENOUGH, StockPolicy.classify(1.0, 0.0)) // 无安全线不告警
    }

    @Test
    fun suggestionFillsUpToSafetyLine() {
        val item = StockItem(
            ingredient = IngredientDto(id = "5", name = "墨鱼汁", unit = "kg", qty = 0.18, safe = 0.4),
            qty = 0.18, safety = 0.4, status = StockStatus.LOW
        )
        val s = StockPolicy.toSuggestion(item)
        assertEquals(0.4 - 0.18, s.suggestQty, 1e-9)
        assertEquals("墨鱼汁", s.name)
        assertEquals("kg", s.unit)
    }
}
