package com.pandawufu.shared.repository

import com.pandawufu.shared.model.*
import com.pandawufu.shared.network.BffClient

/** 厨房中枢（菜谱 / SOP 工单 / 品控 / 出品看板，全部只读） */
interface KitchenRepository {
    suspend fun recipes(): RecipesResponse
    suspend fun recipeDetail(skuId: String): RecipeDetailResponse
    suspend fun workorders(date: String? = null): WorkordersResponse
    suspend fun qc(date: String? = null): QcResponse
    suspend fun board(date: String? = null): BoardResponse
    suspend fun demand(date: String? = null): KitchenDemandDto
}

class KitchenRepositoryImpl(private val bff: BffClient) : KitchenRepository {
    override suspend fun recipes(): RecipesResponse = bff.kitchenRecipes()
    override suspend fun recipeDetail(skuId: String): RecipeDetailResponse = bff.kitchenRecipeDetail(skuId)
    override suspend fun workorders(date: String?): WorkordersResponse = bff.kitchenWorkorders(date)
    override suspend fun qc(date: String?): QcResponse = bff.kitchenQc(date)
    override suspend fun board(date: String?): BoardResponse = bff.kitchenBoard(date)
    override suspend fun demand(date: String?): KitchenDemandDto = bff.kitchenDemand(date)
}
