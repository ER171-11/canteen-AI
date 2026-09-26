package com.pandawufu.app.features.kitchen

import com.pandawufu.shared.model.RecipeDto
import com.pandawufu.shared.model.SopStepDto
import com.pandawufu.shared.repository.StockItem
import com.pandawufu.shared.repository.StockStatus
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import kotlin.math.roundToInt

/**
 * 厨房算料口径（饺子 · 金丰标准）：
 * - 「标准量 / 倍」= 菜谱计量基数：面粉 500g（+色汁/水+盐）起的一次配方；灶上「一盆」往往更大，勿等同
 * - 「个」= 该倍标准下剂个数（剂子 10–11g → 生饺）
 * - 「份」= 堂食售卖单位，不进菜谱换算滑条
 */
data class ScaledBomLine(
    val name: String,
    val qtyText: String,
    val neededApprox: Double? = null,
    val unit: String = "",
    val highlight: Boolean = false,
    val colorLocked: Boolean = false
)

data class ShortageHit(
    val line: ScaledBomLine,
    val stockName: String?,
    val onHand: Double?,
    val unit: String,
    val status: StockStatus?,
    val shortage: Boolean,
    val note: String
)

data class RecipeScaleResult(
    /** 计划下剂个数 */
    val qty: Int,
    /** 金丰标准一批出成个数（换算分母） */
    val batchBase: Int,
    /** qty / batchBase，约几批面 */
    val batches: Double,
    val lines: List<ScaledBomLine>,
    /** 单饺成本（列表「成本/个」） */
    val costPerPiece: Double?,
    val totalCost: Double?
) {
    /** 兼容旧字段名 */
    val costPerPortion: Double? get() = costPerPiece
}

data class SopTimelineStep(
    val step: SopStepDto,
    val timeLabel: String,
    val state: String // done | now | pending
)

private val COST_PER_BY_COLOR = mapOf(
    "红" to 3.42, "黑" to 3.42, "黄" to 3.20, "绿" to 3.30, "紫" to 3.25, "白" to 3.10
)

private val QTY_TOKEN = Regex("""(\d+(?:\.\d+)?)\s*(kg|g|斤|两|ml|L|升|个|份)?""", RegexOption.IGNORE_CASE)

private val COLOR_LOCK_KEYS = listOf("火龙果", "墨鱼", "南瓜", "菠菜", "紫薯")

/** 金丰标准一批建议出成（个）；与 seed params.一批出成_个 / boss-app RECIPE_BATCH 对齐 */
fun batchYieldOf(recipe: RecipeDto): Int {
    val p = recipe.params ?: return 67
    listOf("一批出成_个", "一批出成_中位").forEach { key ->
        val el = p[key] ?: return@forEach
        when (el) {
            is JsonPrimitive -> {
                el.intOrNull?.takeIf { it > 0 }?.let { return it }
                el.doubleOrNull?.roundToInt()?.takeIf { it > 0 }?.let { return it }
                el.contentOrNull?.toDoubleOrNull()?.roundToInt()?.takeIf { it > 0 }?.let { return it }
            }
            else -> {
                val t = el.toString().trim('"')
                t.toDoubleOrNull()?.roundToInt()?.takeIf { it > 0 }?.let { return it }
            }
        }
    }
    return 67
}

/** 滑条：1～10 倍金丰标准（每倍 = 菜谱计量面粉 500g，≠ 灶上一盆） */
fun scaleQtyBounds(batchBase: Int): Triple<Int, Int, Int> {
    val b = batchBase.coerceAtLeast(1)
    return Triple(b, b * 10, b)
}

/** 就近落到整倍标准个数（1～10 倍） */
fun snapScaleQty(qty: Int, batchBase: Int): Int {
    val b = batchBase.coerceAtLeast(1)
    val n = (qty.toDouble() / b).roundToInt().coerceIn(1, 10)
    return n * b
}

/** 当前是几倍金丰标准计量（每倍面粉 500g） */
fun standardMultiplesOf(qty: Int, batchBase: Int): Int {
    val b = batchBase.coerceAtLeast(1)
    return (qty.toDouble() / b).roundToInt().coerceIn(1, 10)
}

@Deprecated("Use standardMultiplesOf", ReplaceWith("standardMultiplesOf(qty, batchBase)"))
fun batchesOf(qty: Int, batchBase: Int): Int = standardMultiplesOf(qty, batchBase)

/**
 * 面主料完整行：优先 menu face_detail → params.面主料 → 色源回补。
 * face_main 只存色源锁定字段，不能单独当 BOM。
 */
fun faceDoughLines(recipe: RecipeDto): List<String> {
    recipe.faceDetail?.takeIf { it.isNotBlank() }?.let { detail ->
        val parts = detail.split(Regex("""[、,，]""")).map { it.trim() }.filter { it.isNotEmpty() }
        if (parts.isNotEmpty()) return parts
    }
    val fromParams = recipe.params?.get("面主料")?.let { el ->
        when (el) {
            is kotlinx.serialization.json.JsonArray ->
                el.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.takeIf { s -> s.isNotBlank() } }
            is JsonPrimitive -> el.contentOrNull?.takeIf { it.isNotBlank() }?.let { listOf(it) }
            else -> null
        }
    }.orEmpty()
    if (fromParams.isNotEmpty()) return fromParams
    val color = recipe.faceMain?.takeIf { it.isNotBlank() }
    return buildList {
        add("五得利雪花粉八星500g")
        if (color != null) add(color)
        add("食盐3g")
    }
}

fun costPerPieceOf(recipe: RecipeDto): Double? =
    recipe.cost
        ?: COST_PER_BY_COLOR[recipe.color]
        ?: COST_PER_BY_COLOR[recipe.color?.take(1)]

fun costPerPortionOf(recipe: RecipeDto): Double? = costPerPieceOf(recipe)

fun scaleRecipeBom(recipe: RecipeDto, qty: Int): RecipeScaleResult {
    val base = batchYieldOf(recipe).coerceAtLeast(1)
    val q = snapScaleQty(qty, base)
    val k = q.toDouble() / base
    val raw = buildList {
        addAll(faceDoughLines(recipe))
        addAll(recipe.main)
        addAll(recipe.aux)
        // 面盐已在面主料；调味里若再有食盐仍保留（馅盐口径，对齐金丰标准）
        addAll(recipe.seasoning)
    }
    val lines = raw.map { line ->
        val parsed = parsePrimaryQty(line, k)
        val locked = COLOR_LOCK_KEYS.any { line.contains(it) }
        ScaledBomLine(
            name = stripQty(line),
            qtyText = parsed.text,
            neededApprox = parsed.amount,
            unit = parsed.unit,
            highlight = locked,
            colorLocked = locked
        )
    }
    val cpp = costPerPieceOf(recipe)
    return RecipeScaleResult(
        qty = q,
        batchBase = base,
        batches = k,
        lines = lines,
        costPerPiece = cpp,
        totalCost = cpp?.times(q)
    )
}

/**
 * 按当前库存粗估最多能做几倍金丰标准（以面粉/色源等可匹配原料为瓶颈）。
 * 未匹配到库存的行跳过；清水等无库存项跳过。
 */
data class StockYieldHint(
    val maxMultiples: Int?,
    val maxPieces: Int?,
    val bottleneck: String?,
    val note: String
)

fun estimateStockYield(recipe: RecipeDto, stock: List<StockItem>): StockYieldHint {
    if (stock.isEmpty()) {
        return StockYieldHint(null, null, null, "库存未加载，暂不能估可做量")
    }
    val base = scaleRecipeBom(recipe, batchYieldOf(recipe))
    var minMult = Int.MAX_VALUE
    var bottleneck: String? = null
    for (line in base.lines) {
        val need = line.neededApprox ?: continue
        if (need <= 0) continue
        val name = line.name
        if (name.contains("清水") || name.contains("水") && !name.contains("果汁") && !name.contains("汁")) continue
        val hit = findStock(name, stock) ?: continue
        val onHand = toComparableQty(hit.qty, hit.ingredient.unit, line.unit) ?: continue
        val perBatch = toComparableQty(need, line.unit, line.unit) ?: need
        if (perBatch <= 0) continue
        val n = kotlin.math.floor(onHand / perBatch).toInt()
        if (n < minMult) {
            minMult = n
            bottleneck = hit.ingredient.name
        }
    }
    if (minMult == Int.MAX_VALUE) {
        return StockYieldHint(null, null, null, "菜谱料与库存名对不上，先补原料档案或点「转采购」")
    }
    val capped = minMult.coerceIn(0, 99)
    val pieces = capped * base.batchBase
    return StockYieldHint(
        maxMultiples = capped,
        maxPieces = pieces,
        bottleneck = bottleneck,
        note = when {
            capped <= 0 -> "库存不够 1 倍标准量（瓶颈：${bottleneck ?: "原料"}）→ 转采购"
            capped == 1 -> "库存约够 1×标准 · ${pieces}个（瓶颈：${bottleneck}）"
            else -> "库存约够 ${capped}×标准 · ${pieces}个（瓶颈：${bottleneck}）"
        }
    )
}

/** 把库存单位粗换成菜谱单位（g/kg/斤），对不上则 null */
private fun toComparableQty(qty: Double, fromUnit: String?, toUnit: String?): Double? {
    val g = toGrams(qty, fromUnit) ?: return null
    val target = (toUnit ?: "").lowercase()
    return when {
        target.isBlank() || target == "g" || target == "ml" -> g
        target == "kg" || target == "l" || target == "升" -> g / 1000.0
        target == "斤" -> g / 500.0
        target == "两" -> g / 50.0
        else -> g // 兜底按 g 比
    }
}

private fun toGrams(qty: Double, unit: String?): Double? {
    val u = (unit ?: "").lowercase().trim()
    return when {
        u.isBlank() || u == "g" || u == "ml" || u == "克" -> qty
        u == "kg" || u == "l" || u == "升" || u == "公斤" -> qty * 1000.0
        u == "斤" -> qty * 500.0
        u == "两" -> qty * 50.0
        u == "袋" || u == "瓶" || u == "桶" || u == "箱" -> null // 无法换算
        else -> qty
    }
}

/** 对照库存：色源锁定不可替换；辅料告急/偏低标缺并建议调量 */
fun matchShortages(scaled: RecipeScaleResult, stock: List<StockItem>): List<ShortageHit> {
    if (scaled.lines.isEmpty()) return emptyList()
    return scaled.lines.map { line ->
        val hit = findStock(line.name, stock)
        when {
            line.colorLocked -> ShortageHit(
                line = line,
                stockName = hit?.ingredient?.name,
                onHand = hit?.qty,
                unit = hit?.ingredient?.unit ?: line.unit,
                status = hit?.status,
                shortage = hit != null && hit.status != StockStatus.ENOUGH,
                note = if (hit == null) "色源锁定 · 库存未匹配到同名原料"
                else if (hit.status != StockStatus.ENOUGH) "色源锁定 · 现库${fmtNum(hit.qty)}${hit.ingredient.unit}（${hit.status.label}）不可替换，仅可催采"
                else "色源锁定 · 库存充足，不可替换"
            )
            hit == null -> ShortageHit(
                line = line,
                stockName = null,
                onHand = null,
                unit = line.unit,
                status = null,
                shortage = false,
                note = "未匹配库存名，转采购时按算料量写入草稿"
            )
            hit.status == StockStatus.CRITICAL || hit.status == StockStatus.LOW -> ShortageHit(
                line = line,
                stockName = hit.ingredient.name,
                onHand = hit.qty,
                unit = hit.ingredient.unit,
                status = hit.status,
                shortage = true,
                note = "缺料 · 现${fmtNum(hit.qty)}${hit.ingredient.unit}/安全${fmtNum(hit.safety)} · 建议调量或转采购"
            )
            else -> ShortageHit(
                line = line,
                stockName = hit.ingredient.name,
                onHand = hit.qty,
                unit = hit.ingredient.unit,
                status = hit.status,
                shortage = false,
                note = "库存${hit.status.label}"
            )
        }
    }
}

/**
 * 按开餐时刻倒排 SOP 时间线（原型 kt-sop）。
 * 连续同 stage 合并，避免种子重复工序把时间轴拉成凌晨。
 */
fun buildSopTimeline(
    steps: List<SopStepDto>,
    mealClock: LocalTime = LocalTime.of(11, 30),
    now: LocalTime = LocalTime.now()
): List<SopTimelineStep> {
    if (steps.isEmpty()) return emptyList()
    val ordered = steps.sortedBy { it.stepNo }
    val collapsed = mutableListOf<SopStepDto>()
    for (s in ordered) {
        val last = collapsed.lastOrNull()
        if (last != null && last.stage == s.stage) {
            val mergedDur = listOfNotNull(last.durationMin, s.durationMin).maxOrNull()
            collapsed[collapsed.lastIndex] = last.copy(
                durationMin = mergedDur ?: last.durationMin,
                keyPoints = (last.keyPoints + s.keyPoints).distinct(),
                qcPoint = last.qcPoint ?: s.qcPoint,
                risk = last.risk ?: s.risk
            )
        } else {
            collapsed += s
        }
    }
    val durations = collapsed.map { step ->
        when {
            step.durationMin != null && step.durationMin!! > 0 -> step.durationMin!!
            step.stage.contains("醒发") -> 30
            step.stage.contains("煮") -> 15
            step.stage.contains("包") -> 20
            else -> 15
        }
    }
    val total = durations.sum().coerceAtMost(180) // 开餐前最多倒排 3 小时，贴近午市节奏
    var cursor = mealClock.minusMinutes(total.toLong())
    // 若压缩了总时长，按比例缩放各步
    val scale = if (durations.sum() > 180) 180.0 / durations.sum() else 1.0
    val scaledDur = durations.map { (it * scale).roundToInt().coerceAtLeast(5) }
    val fmt = DateTimeFormatter.ofPattern("HH:mm")
    var stepNo = 1
    return collapsed.mapIndexed { idx, step ->
        val dur = scaledDur[idx]
        val start = cursor
        val end = cursor.plusMinutes(dur.toLong())
        cursor = end
        val label = if (dur >= 20) "${start.format(fmt)}–${end.format(fmt)}" else start.format(fmt)
        val explicit = step.params?.get("state")?.toString()?.trim('"')
        val state = when {
            !explicit.isNullOrBlank() -> explicit
            end.isBefore(now) || end == now -> "done"
            !start.isAfter(now) && end.isAfter(now) -> "now"
            else -> "pending"
        }
        SopTimelineStep(
            step = step.copy(stepNo = stepNo++),
            timeLabel = label,
            state = state
        )
    }
}

fun colorLockNote(color: String?): String = when (color) {
    "红" -> "色源锁定：红色必须火龙果，不可替换；辅料不足时 AI 仅建议调量并备注影响。"
    "黑" -> "色源锁定：黑色以墨鱼汁为色源，不可用酱油等替代。"
    "黄" -> "色源锁定：黄色以南瓜泥为色源，替换需备注观感影响。"
    "绿" -> "色源锁定：绿色以菠菜汁为色源，替换需备注观感影响。"
    "紫" -> "色源锁定：紫色以紫薯粉为色源，替换需备注观感影响。"
    else -> "缺料时优先调量；色源类原料不可随意替换。"
}

private data class ParsedQty(val text: String, val amount: Double?, val unit: String)

private fun parsePrimaryQty(line: String, k: Double): ParsedQty {
    val matches = QTY_TOKEN.findAll(line).toList()
    if (matches.isEmpty()) return ParsedQty("×${"%.2f".format(k)}", null, "")
    val parts = matches.map { m ->
        val n = m.groupValues[1].toDouble() * k
        val unit = m.groupValues.getOrNull(2).orEmpty()
        Triple(n, unit, formatQty(n, unit) + unit)
    }
    val primary = parts.first()
    return ParsedQty(
        text = parts.joinToString(" / ") { it.third },
        amount = primary.first,
        unit = primary.second
    )
}

private fun stripQty(line: String): String =
    line.replace(QTY_TOKEN, "").replace(Regex("""\s{2,}"""), " ").trim().ifBlank { line }

private fun formatQty(v: Double, unit: String): String {
    val u = unit.lowercase()
    return when {
        u == "g" || u == "ml" || u == "个" || u == "份" -> v.roundToInt().toString()
        v >= 100 -> v.roundToInt().toString()
        v >= 10 -> "%.1f".format(v)
        else -> "%.2f".format(v)
    }
}

private fun fmtNum(v: Double): String =
    if (v >= 10) "%.1f".format(v) else "%.2f".format(v)

private val BOM_STOCK_ALIASES = listOf(
    "五得利雪花粉八星" to "五得利雪花面粉",
    "五得利雪花粉" to "五得利雪花面粉",
    "雪花粉" to "五得利雪花面粉",
    "猪前肩肉" to "黑猪前肩肉",
    "三肥七瘦" to "黑猪前肩肉",
    "食盐" to "雪天精制盐",
    "精盐" to "雪天精制盐",
    "墨鱼汁" to "食用墨鱼汁",
    "海天蚝油" to "海天上等蚝油",
    "海天生抽" to "海天金标生抽",
    "海天老抽" to "海天草菇老抽",
    "白胡椒粉" to "白胡椒粉",
    "十三香" to "王守义十三香",
    "葱花" to "葱",
    "姜末" to "姜",
    "大葱" to "葱",
    "冬菇" to "香菇",
    "火龙果汁" to "火龙果",
    "南瓜泥" to "南瓜",
    "菠菜汁" to "菠菜",
    "紫薯粉" to "紫薯粉"
)

private fun findStock(bomName: String, stock: List<StockItem>): StockItem? {
    val key = bomName.replace(Regex("""[（(].*?[）)]"""), "").trim()
    if (key.isEmpty()) return null
    // 金丰菜谱名 → 店内原料名
    for ((from, to) in BOM_STOCK_ALIASES) {
        if (key.contains(from) || bomName.contains(from)) {
            stock.firstOrNull { it.ingredient.name.contains(to) }?.let { return it }
        }
    }
    stock.firstOrNull { it.ingredient.name == key }?.let { return it }
    stock.firstOrNull { it.ingredient.name.contains(key) || key.contains(it.ingredient.name) }?.let { return it }
    val tokens = key.split(Regex("""[\s/、，,·]+""")).filter { it.length >= 2 }.sortedByDescending { it.length }
    for (t in tokens) {
        stock.firstOrNull { it.ingredient.name.contains(t) }?.let { return it }
    }
    return null
}
