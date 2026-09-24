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
    fun safetyFallsBackToQtyWhenNothingProvided() {
        val ing = IngredientDto(id = "4", name = "d", qty = 7.5)
        assertEquals(7.5, StockPolicy.resolveSafety(ing))
        assertEquals(StockStatus.ENOUGH, StockPolicy.toStockItem(ing).status) // 不误报告急
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
