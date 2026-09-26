package com.pandawufu.app.features.inventory

import com.pandawufu.shared.repository.StockItem
import com.pandawufu.shared.repository.StockStatus

/**
 * 进销存双维分类（餐饮办货专业口径）
 *
 * 维① 使用场景 —— 谁用、怎么补：
 *   菜谱挂钩 / 后厨专用 / 前厅桌边 / 通用库房
 *
 * 维② 品类 —— 买什么、放哪：
 *   米面粮油 / 肉禽蛋 / 水产海鲜 / 蔬果菌菇 / 调味酱料 /
 *   干货杂粮 / 色源特料 / 酒水饮料 / 耗材包材 / 待归类
 *
 * 端侧智能归类：不依赖档案里常错的 cat=「其他」。
 */

/** 场景维 */
enum class IngScene(val label: String, val hint: String) {
    ALL("全部场景", "告急优先 · 可再按品类收窄"),
    RECIPE("菜谱挂钩", "进饺子/热菜 BOM · 算料→可做量→转采购"),
    KITCHEN("后厨专用", "后厨料水/大包装酱料 · 按安全线补"),
    FRONT("前厅桌边", "桌边蘸料小瓶 · 不进菜谱算料"),
    COMMON("通用库房", "耗材/整件干货/共用冷链 · 周补或安全线")
}

/** 品类维 */
enum class IngKind(val label: String, val tag: String, val hint: String) {
    ALL("全部品类", "全", "先看场景，再看品类"),
    GRAIN_OIL("米面粮油", "粮", "面粉/大米/淀粉/食用油 · 主食底座"),
    MEAT_EGG("肉禽蛋", "肉", "猪牛羊鸡鸭蛋 · 冷链日耗"),
    SEAFOOD("水产海鲜", "鲜", "鱼虾贝鱿 · 鲜度敏感"),
    PRODUCE("蔬果菌菇", "菜", "叶菜菌菇葱姜蒜 · 隔日损耗大"),
    SEASONING("调味酱料", "味", "盐糖酱油蚝油香料 · 后厨/前厅再分场景"),
    DRY_GOODS("干货杂粮", "干", "粉丝木耳腐竹杂粮 · 库房常温"),
    COLOR("色源特料", "色", "火龙果/墨鱼/红曲/紫薯 · 五福色源锁定"),
    BEVERAGE("酒水饮料", "饮", "酒水奶茶椰浆等"),
    PACK("耗材包材", "耗", "手套口罩打包袋 · 不进菜谱"),
    OTHER("待归类", "?", "名称难识别 · 建议后台改档案")
}

data class IngClass(val scene: IngScene, val kind: IngKind)

// —— 品类关键词 ——
private val COLOR_KEYS = listOf("火龙果", "墨鱼", "红曲", "紫薯粉", "紫薯", "菠菜汁")
private val PACK_KEYS = listOf(
    "手套", "口罩", "保鲜膜", "保鲜袋", "打包", "餐盒", "筷子", "牙签",
    "围裙", "抹布", "垃圾袋", "纸巾", "纸杯", "硅胶", "蒸冠"
)
private val BEVERAGE_KEYS = listOf("奶", "椰浆", "啤酒", "可乐", "雪碧", "饮料", "酒", "啵乐乐")
private val GRAIN_KEYS = listOf(
    "面粉", "雪花", "生粉", "淀粉", "泡打粉", "澄粉", "糯米", "大米", "粳米",
    "食用油", "花生油", "菜籽油", "调和油", "猪油"
)
private val MEAT_KEYS = listOf(
    "猪", "牛", "羊", "鸡", "鸭", "五花", "前肩", "前腿", "肉馅", "鸡蛋", "鸭蛋", "皮蛋"
)
private val SEA_KEYS = listOf(
    "鱼", "虾", "蟹", "鱿", "贝", "海参", "带鱼", "黄鱼", "鲅鱼", "炮弹", "炮笋",
    "海蜇", "海白螺", "墨鱼" // 墨鱼汁走色源；整墨鱼可水产——classify 里色源优先
)
private val PRODUCE_KEYS = listOf(
    "白菜", "大白菜", "圆白菜", "菠菜", "南瓜", "香菇", "鲜香菇",
    "木耳", "云耳", "马蹄", "荸荠", "玉米", "酸菜", "韭黄", "韭菜", "芹菜",
    "茴香", "鱼腥草", "萝卜", "豆腐", "香芹", "葱", "姜", "蒜",
    "青椒", "辣椒", "豆角", "豆芽", "笋", "菇", "西葫芦", "山药", "胡萝卜", "莴笋", "藕", "蕨"
)
private val DRY_KEYS = listOf(
    "粉丝", "粉条", "腐竹", "干香菇", "花生", "芝麻", "白芝麻", "杂粮", "红豆", "绿豆"
)
private val SEASON_KEYS = listOf(
    "盐", "糖", "酱油", "生抽", "老抽", "蚝油", "醋", "料酒", "香油", "芝麻油",
    "胡椒", "花椒", "十三香", "八角", "大料", "香叶", "味精", "鸡精",
    "豆瓣", "酱", "蜜", "沙拉", "芥末", "辣椒油", "红油", "藤椒油", "花椒油"
)
private val FRONT_SMALL_KEYS = listOf(
    "正阳饺子酱油", "饺子酱油", "蘸", "芥末"
)
/** 明确挂金丰菜谱 BOM 的名 */
private val RECIPE_BOM_KEYS = listOf(
    "面粉", "雪花", "火龙果", "墨鱼", "南瓜", "菠菜", "紫薯", "红曲",
    "猪前肩", "前肩肉", "黑猪前肩", "冬菇", "荸荠", "茴香", "大葱",
    "玉米", "香芹", "酸菜", "西葫芦", "山药", "白萝卜", "木耳", "粉丝", "韭菜", "白菜"
)

fun classifyIng(item: StockItem): IngClass =
    classifyIngByName(item.ingredient.name, item.ingredient.cat)

fun classifyIngByName(name: String, archiveCat: String? = null): IngClass {
    val kind = classifyKind(name, archiveCat)
    val scene = classifyScene(name, kind)
    return IngClass(scene, kind)
}

fun classifyKind(name: String, archiveCat: String? = null): IngKind {
    val cat = archiveCat.orEmpty()
    if (PACK_KEYS.any { name.contains(it) }) return IngKind.PACK
    if (COLOR_KEYS.any { name.contains(it) }) return IngKind.COLOR
    if (BEVERAGE_KEYS.any { name.contains(it) }) return IngKind.BEVERAGE
    if (GRAIN_KEYS.any { name.contains(it) }) return IngKind.GRAIN_OIL
    if (MEAT_KEYS.any { name.contains(it) } || cat.contains("鲜肉")) return IngKind.MEAT_EGG
    // 墨鱼汁已在色源；整只墨鱼等
    if ((SEA_KEYS.any { name.contains(it) } || cat.contains("水产")) && !name.contains("墨鱼汁")) {
        return IngKind.SEAFOOD
    }
    if (DRY_KEYS.any { name.contains(it) }) return IngKind.DRY_GOODS
    if (SEASON_KEYS.any { name.contains(it) } || cat.contains("干调")) return IngKind.SEASONING
    if (PRODUCE_KEYS.any { name.contains(it) } || cat.contains("蔬菜")) return IngKind.PRODUCE
    return IngKind.OTHER
}

fun classifyScene(name: String, kind: IngKind): IngScene {
    if (kind == IngKind.PACK || kind == IngKind.BEVERAGE) return IngScene.COMMON
    if (kind == IngKind.COLOR) return IngScene.RECIPE
    // 前厅：小瓶桌边蘸料
    if (FRONT_SMALL_KEYS.any { name.contains(it) }) return IngScene.FRONT
    if (kind == IngKind.SEASONING && isFrontTableSize(name)) return IngScene.FRONT
    // 菜谱挂钩：色源/面粉/明确馅料原料
    if (kind == IngKind.GRAIN_OIL && (name.contains("面粉") || name.contains("雪花"))) {
        return IngScene.RECIPE
    }
    if (RECIPE_BOM_KEYS.any { name.contains(it) }) return IngScene.RECIPE
    // 大包装酱料 / 整件 → 后厨或通用
    if (kind == IngKind.SEASONING) {
        return if (isBulkPack(name)) IngScene.KITCHEN else IngScene.KITCHEN
    }
    if (kind == IngKind.MEAT_EGG || kind == IngKind.SEAFOOD || kind == IngKind.PRODUCE) {
        return if (RECIPE_BOM_KEYS.any { name.contains(it) }) IngScene.RECIPE else IngScene.KITCHEN
    }
    if (kind == IngKind.DRY_GOODS || kind == IngKind.GRAIN_OIL) return IngScene.COMMON
    if (kind == IngKind.OTHER) return IngScene.COMMON
    return IngScene.KITCHEN
}

private fun isFrontTableSize(name: String): Boolean {
    if (name.contains("*") || name.contains("×") || name.contains("件")) return false
    val ml = extractMl(name) ?: return false
    return ml in 200..550 && (name.contains("醋") || name.contains("香油") ||
        name.contains("芝麻油") || name.contains("酱油") || name.contains("生抽") || name.contains("老抽"))
}

private fun isBulkPack(name: String): Boolean =
    name.contains("*") || name.contains("×") || name.contains("件") ||
        name.contains("桶") || name.contains("箱") ||
        (extractMl(name)?.let { it >= 1000 } == true) ||
        (extractKg(name)?.let { it >= 1.0 } == true)

private fun extractMl(name: String): Int? =
    Regex("""(\d+)\s*ml""", RegexOption.IGNORE_CASE).find(name)?.groupValues?.getOrNull(1)?.toIntOrNull()

private fun extractKg(name: String): Double? =
    Regex("""(\d+(?:\.\d+)?)\s*kg""", RegexOption.IGNORE_CASE).find(name)?.groupValues?.getOrNull(1)?.toDoubleOrNull()

fun sceneHint(s: IngScene): String = s.hint
fun kindHint(k: IngKind): String = k.hint

fun kindColor(k: IngKind): androidx.compose.ui.graphics.Color = when (k) {
    IngKind.GRAIN_OIL -> androidx.compose.ui.graphics.Color(0xFFD4A017)
    IngKind.MEAT_EGG -> androidx.compose.ui.graphics.Color(0xFFC45C4A)
    IngKind.SEAFOOD -> androidx.compose.ui.graphics.Color(0xFF3A7CA5)
    IngKind.PRODUCE -> androidx.compose.ui.graphics.Color(0xFF5BA85B)
    IngKind.SEASONING -> androidx.compose.ui.graphics.Color(0xFFE67E22)
    IngKind.DRY_GOODS -> androidx.compose.ui.graphics.Color(0xFF8D6E63)
    IngKind.COLOR -> androidx.compose.ui.graphics.Color(0xFF9B59B6)
    IngKind.BEVERAGE -> androidx.compose.ui.graphics.Color(0xFF5DADE2)
    IngKind.PACK -> androidx.compose.ui.graphics.Color(0xFF7F8C8D)
    else -> androidx.compose.ui.graphics.Color(0xFF2C2C34)
}

/** 库存页顶部摘要 */
data class BossStockDigest(
    val critical: Int,
    val low: Int,
    val enough: Int,
    val needByScene: List<Pair<IngScene, Int>>,
    val needByKind: List<Pair<IngKind, Int>>,
    val topCritical: List<StockItem>
)

fun buildBossStockDigest(stock: List<StockItem>): BossStockDigest {
    val critical = stock.count { it.status == StockStatus.CRITICAL }
    val low = stock.count { it.status == StockStatus.LOW }
    val enough = stock.count { it.status == StockStatus.ENOUGH }
    fun need(it: StockItem) =
        it.status == StockStatus.CRITICAL || it.status == StockStatus.LOW
    val byScene = IngScene.entries.filter { it != IngScene.ALL }.mapNotNull { s ->
        val n = stock.count { classifyIng(it).scene == s && need(it) }
        if (n > 0) s to n else null
    }.sortedByDescending { it.second }
    val byKind = IngKind.entries.filter { it != IngKind.ALL }.mapNotNull { k ->
        val n = stock.count { classifyIng(it).kind == k && need(it) }
        if (n > 0) k to n else null
    }.sortedByDescending { it.second }
    val top = stock.filter(::need).sortedWith(
        compareBy<StockItem> {
            when (it.status) {
                StockStatus.CRITICAL -> 0
                StockStatus.LOW -> 1
                else -> 2
            }
        }.thenBy { it.qty / it.safety.coerceAtLeast(0.01) }
    ).take(5)
    return BossStockDigest(critical, low, enough, byScene, byKind, top)
}

fun dedupeStockForDisplay(stock: List<StockItem>): List<StockItem> {
    val groups = linkedMapOf<String, MutableList<StockItem>>()
    for (s in stock) {
        val key = normalizeIngKey(s.ingredient.name)
        groups.getOrPut(key) { mutableListOf() }.add(s)
    }
    return groups.values.map { list ->
        list.maxWith(compareBy<StockItem> { it.qty })
    }
}

private fun normalizeIngKey(name: String): String =
    name
        .replace(Regex("""\d+(\.\d+)?\s*(ml|g|kg|L|斤|瓶|包|袋|件|\*).*$""", RegexOption.IGNORE_CASE), "")
        .replace(Regex("""[*×xX]\s*\d+.*$"""), "")
        .replace(Regex("""\s+"""), "")
        .take(12)
        .ifBlank { name }

// —— 兼容旧 API（RestockTab 等）——
@Deprecated("Use IngKind", ReplaceWith("IngKind"))
enum class BossCat(val label: String, val emojiHint: String, val buyHint: String) {
    ALL("全部", "全", ""),
    MEAT("肉禽蛋", "肉", ""),
    SEAFOOD("水产海鲜", "鲜", ""),
    VEG("蔬果菌菇", "菜", ""),
    STAPLE("米面粮油", "粮", ""),
    COLOR("色源特料", "色", ""),
    SEASON("调味酱料", "味", ""),
    FRONT("前厅桌边", "桌", ""),
    PACK("耗材包材", "耗", ""),
    OTHER("待归类", "?", "")
}

@Deprecated("Use classifyIngByName")
fun classifyBossCat(item: StockItem): BossCat = kindToBoss(classifyIng(item).kind)

@Deprecated("Use classifyIngByName")
fun classifyBossCatByName(name: String, archiveCat: String? = null): BossCat =
    kindToBoss(classifyIngByName(name, archiveCat).kind)

private fun kindToBoss(k: IngKind): BossCat = when (k) {
    IngKind.MEAT_EGG -> BossCat.MEAT
    IngKind.SEAFOOD -> BossCat.SEAFOOD
    IngKind.PRODUCE -> BossCat.VEG
    IngKind.GRAIN_OIL -> BossCat.STAPLE
    IngKind.COLOR -> BossCat.COLOR
    IngKind.SEASONING -> BossCat.SEASON
    IngKind.PACK -> BossCat.PACK
    IngKind.ALL -> BossCat.ALL
    else -> BossCat.OTHER
}

@Deprecated("Use IngScene")
enum class IngZone(val label: String) {
    ALL("全部"), KITCHEN_BOM("后厨配方"), FRONT_DIP("前厅蘸料"), DRY("干调冷链"), OTHER("其他")
}

@Deprecated("Use classifyIng")
fun classifyIngZone(item: StockItem): IngZone = when (classifyIng(item).scene) {
    IngScene.RECIPE -> IngZone.KITCHEN_BOM
    IngScene.FRONT -> IngZone.FRONT_DIP
    IngScene.KITCHEN -> IngZone.DRY
    IngScene.COMMON -> IngZone.OTHER
    IngScene.ALL -> IngZone.ALL
}

@Deprecated("removed")
fun zoneHint(zone: IngZone): String = ""
fun bossCatHint(cat: BossCat): String = cat.buyHint
