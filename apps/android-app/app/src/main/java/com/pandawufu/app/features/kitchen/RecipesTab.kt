package com.pandawufu.app.features.kitchen

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.shared.viewmodel.KitchenViewModel

// 原型 kt-rec：功夫菜单（五色分组）+ 点击展开 BOM/参数/步骤
@Composable
fun RecipesTab(state: KitchenViewModel.KitchenState, viewModel: KitchenViewModel) {
    if (state.loading && state.recipes.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        return
    }
    val grouped = state.recipes.groupBy { it.color ?: "其他" }
    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        grouped.forEach { (color, recipes) ->
            item(key = "hdr-$color") {
                Text("$color 系（${recipes.size}）", style = MaterialTheme.typography.titleMedium)
            }
            items(recipes, key = { it.skuId }) { recipe ->
                RecipeRow(recipe, onClick = {
                    viewModel.dispatch(KitchenViewModel.KitchenIntent.SelectRecipe(recipe.skuId))
                })
            }
        }
        // 选中配方：展开 BOM / 参数 / 步骤
        state.selectedRecipe?.let { sel ->
            item(key = "detail-${sel.skuId}") {
                RecipeDetailCard(state, sel)
            }
        }
    }
}

@Composable
private fun RecipeRow(recipe: com.pandawufu.shared.model.RecipeDto, onClick: () -> Unit) {
    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = CardBg),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick)
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(
                Modifier.size(34.dp).clip(CircleShape).background(colorOfFive(recipe.color)),
                contentAlignment = Alignment.Center
            ) {
                Text(recipe.color ?: "-", color = Color.White, style = MaterialTheme.typography.labelSmall)
            }
            Column(Modifier.weight(1f)) {
                Text(recipe.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
                Text(
                    listOfNotNull(recipe.faceMain, recipe.blessing?.let { "寓意$it" }).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall
                )
            }
            recipe.dietTags.take(2).forEach { StatusTag(it, FiveGreenC) }
        }
    }
}

@Composable
private fun RecipeDetailCard(state: KitchenViewModel.KitchenState, sel: com.pandawufu.shared.model.RecipeDto) {
    Card(
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = CardBg),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("配方 · ${sel.name}", style = MaterialTheme.typography.titleMedium)
            if (state.detailLoading) {
                CircularProgressIndicator()
            } else {
                BomSection("主料", sel.main)
                BomSection("辅料", sel.aux)
                BomSection("调味", sel.seasoning)
                if (sel.params != null) {
                    Text("参数", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
                    sel.params.forEach { (k, v) ->
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(k, style = MaterialTheme.typography.bodySmall)
                            Text(v.toString().trim('"'), style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
                if (state.selectedSteps.isNotEmpty()) {
                    Text("SOP 步骤", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
                    state.selectedSteps.forEach { step ->
                        Column {
                            Text("${step.stepNo}. ${step.stage}（${step.durationMin ?: "-"}min）", style = MaterialTheme.typography.bodyMedium)
                            step.qcPoint?.let { Text("质检点：$it", style = MaterialTheme.typography.bodySmall) }
                            step.risk?.let { Text("⚠ $it", style = MaterialTheme.typography.bodySmall, color = FiveRedC) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun BomSection(title: String, lines: List<String>) {
    if (lines.isEmpty()) return
    Text(title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
    lines.forEach { Text("· $it", style = MaterialTheme.typography.bodySmall) }
}
