package com.pandawufu.app.ui.designsystem

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.R
import kotlin.math.roundToInt
import kotlin.random.Random

/** 卡片：白底、22 圆角、发丝边、柔和阴影、轻渐变面 */
@Composable
fun PandaCard(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit
) {
    Column(
        modifier
            .fillMaxWidth()
            .shadow(5.dp, RoundedCornerShape(22.dp), ambientColor = ShadowColor, spotColor = ShadowColor)
            .clip(RoundedCornerShape(22.dp))
            .background(Brush.verticalGradient(listOf(CardTop, CardBottom)))
            .border(1.dp, CardHairline, RoundedCornerShape(22.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        content = content
    )
}

/** 原型 card-h：粉紫竖条 + 粗标题 + 右侧 more */
@Composable
fun CardHeader(
    title: String,
    more: String? = null,
    onMore: (() -> Unit)? = null
) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            Box(
                Modifier
                    .width(4.dp)
                    .height(16.dp)
                    .clip(RoundedCornerShape(3.dp))
                    .background(Brush.verticalGradient(listOf(AiPink, AiPurple)))
            )
            Text(title, fontSize = 14.5.sp, fontWeight = FontWeight.ExtraBold, color = Txt)
        }
        if (more != null) {
            Text(
                more,
                fontSize = 11.sp,
                color = Sub,
                modifier = if (onMore != null) Modifier.clickable(onClick = onMore) else Modifier
            )
        }
    }
}

/**
 * 统一顶部栏（页面标题优先）：
 *   有返回 → 返回键 + 页面标题；无返回（一级页）→ 熊猫 logo + 页面标题。
 *   标题一行加粗，副标题一行省略（门店/口径），右侧留给动作。
 */
@Composable
fun BrandBar(
    title: String = com.pandawufu.app.ui.BossIa.Brand.NAME,
    subtitle: String = com.pandawufu.app.ui.BossIa.Brand.TAGLINE,
    onBack: (() -> Unit)? = null,
    trailing: @Composable (() -> Unit)? = null,
    showLogo: Boolean = true
) {
    Row(
        Modifier
            .fillMaxWidth()
            .height(52.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) {
                Box(
                    Modifier
                        .size(36.dp)
                        .clip(CircleShape)
                        .background(CardBg)
                        .border(1.dp, CardHairline, CircleShape)
                        .clickable(onClick = onBack),
                    contentAlignment = Alignment.Center
                ) {
                    Text("‹", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = Txt)
                }
                Spacer(Modifier.width(10.dp))
            } else if (showLogo) {
                Box(
                    Modifier
                        .size(34.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .background(CardBg)
                        .padding(5.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Image(
                        painter = painterResource(
                            if (Random.nextBoolean()) R.drawable.panda_male_sq else R.drawable.panda_female_sq
                        ),
                        contentDescription = com.pandawufu.app.ui.BossIa.Brand.NAME,
                        modifier = Modifier.fillMaxSize(),
                        contentScale = ContentScale.Fit,
                        alignment = Alignment.Center
                    )
                }
                Spacer(Modifier.width(9.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(
                    title,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.ExtraBold,
                    color = Txt,
                    maxLines = 1,
                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis
                )
                Text(
                    subtitle,
                    fontSize = 10.5.sp,
                    fontWeight = FontWeight.Medium,
                    color = Sub,
                    maxLines = 1,
                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis
                )
            }
        }
        trailing?.invoke()
    }
}

/** 问候语：标题后半段粉紫渐变字 */
@Composable
fun GreetBlock(name: String, accent: String, sub: String) {
    Column(Modifier.padding(horizontal = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            buildAnnotatedString {
                withStyle(SpanStyle(color = Txt, fontWeight = FontWeight.ExtraBold, fontSize = 24.sp)) {
                    append(name)
                    append(" ")
                }
                withStyle(
                    SpanStyle(
                        brush = Brush.horizontalGradient(listOf(AiPink, AiPurple)),
                        fontWeight = FontWeight.ExtraBold,
                        fontSize = 24.sp
                    )
                ) { append(accent) }
            }
        )
        Text(sub, fontSize = 12.sp, color = Sub, lineHeight = 16.sp)
    }
}

/** 墨色营收 banner（hero） */
@Composable
fun SumBanner(label: String, value: String, delta: String, valueSuffix: String? = null) {
    Box(
        Modifier
            .fillMaxWidth()
            .shadow(8.dp, RoundedCornerShape(22.dp), ambientColor = ShadowColor, spotColor = ShadowColor)
            .clip(RoundedCornerShape(22.dp))
            .background(Brush.linearGradient(listOf(Color(0xFF23252C), Ink)))
    ) {
        // 右上粉晕（对齐原型 ::after）
        Box(
            Modifier
                .align(Alignment.TopEnd)
                .offset(x = 26.dp, y = (-26).dp)
                .size(140.dp)
                .clip(CircleShape)
                .background(Color(255, 182, 193, 40))
        )
        Box(
            Modifier
                .align(Alignment.BottomEnd)
                .offset(x = 30.dp, y = 30.dp)
                .size(120.dp)
                .clip(CircleShape)
                .background(AiPurple.copy(alpha = 0.18f))
        )
        Column(
            Modifier.padding(horizontal = 18.dp, vertical = 17.dp),
            verticalArrangement = Arrangement.spacedBy(5.dp)
        ) {
            Text(label, fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold, color = Color(0xFFB9BCC6))
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 25.sp)) {
                        append(value)
                    }
                    if (!valueSuffix.isNullOrBlank()) {
                        append(" ")
                        withStyle(SpanStyle(color = Color(0xFFB9BCC6), fontWeight = FontWeight.SemiBold, fontSize = 13.sp)) {
                            append(valueSuffix)
                        }
                    }
                }
            )
            Text(delta, fontSize = 11.5.sp, fontWeight = FontWeight.Bold, color = FiveGreen)
        }
    }
}

/** 原型 .kv 行 */
@Composable
fun ProtoKv(label: String, value: String, valueColor: Color = Txt) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 5.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(label, fontSize = 11.sp, color = Sub)
        Text(value, fontSize = 11.sp, fontWeight = FontWeight.ExtraBold, color = valueColor)
    }
}

/** 时段热力条（12 格 / 24h 合并） */
@Composable
fun HeatMiniBar(hours: List<Pair<Int, Int>>) {
    val max = (hours.maxOfOrNull { it.second } ?: 1).coerceAtLeast(1)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        hours.forEach { (_, orders) ->
            val t = orders.toFloat() / max
            val c = when {
                t <= 0.05f -> PageBg
                t <= 0.35f -> Color(0xFFFBD3CC)
                t <= 0.7f -> AiPink
                else -> Color(0xFFC2185B)
            }
            Box(
                Modifier
                    .weight(1f)
                    .height(11.dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(c)
            )
        }
    }
}

/** 五福销量条 */
@Composable
fun FiveSaleRow(tag: String, tagBg: Color, name: String, count: String, pct: Float, barColors: List<Color>) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            Modifier
                .size(28.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(tagBg),
            contentAlignment = Alignment.Center
        ) {
            Text(tag, fontSize = 11.sp, fontWeight = FontWeight.Bold, color = Color.White)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(name, fontSize = 12.5.sp, fontWeight = FontWeight.Bold, color = Txt)
                Text(count, fontSize = 11.sp, color = Sub)
            }
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(7.dp)
                    .clip(RoundedCornerShape(4.dp))
                    .background(PageBg)
            ) {
                Box(
                    Modifier
                        .fillMaxWidth(pct.coerceIn(0.08f, 1f))
                        .height(7.dp)
                        .clip(RoundedCornerShape(4.dp))
                        .background(Brush.horizontalGradient(barColors))
                )
            }
        }
    }
}

/** KPI 2×N 小格 */
@Composable
fun KpiGrid(items: List<Triple<String, String, String?>>, columns: Int = 2) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        items.chunked(columns).forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                row.forEach { (lab, value, delta) ->
                    Column(
                        Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(18.dp))
                            .background(Color.White)
                            .border(1.dp, CardHairline, RoundedCornerShape(18.dp))
                            .padding(14.dp)
                    ) {
                        Text(lab, fontSize = 11.sp, color = Sub, fontWeight = FontWeight.SemiBold)
                        Text(value, fontSize = 20.sp, fontWeight = FontWeight.ExtraBold, color = Txt)
                        if (!delta.isNullOrBlank()) {
                            val dc = when {
                                delta.startsWith("+") -> FiveGreen
                                delta.startsWith("-") -> FiveRed
                                else -> Sub
                            }
                            Text(delta, fontSize = 10.5.sp, color = dc, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
                repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

/** 模块宫格 cell（更多/全部应用） */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ModuleCell(
    label: String,
    subtitle: String,
    iconBg: Color,
    modifier: Modifier = Modifier,
    onLongClick: (() -> Unit)? = null,
    onClick: () -> Unit
) {
    Column(
        modifier
            .clip(RoundedCornerShape(18.dp))
            .background(Color.White)
            .border(1.dp, CardHairline, RoundedCornerShape(18.dp))
            .then(
                if (onLongClick != null) {
                    Modifier.combinedClickable(onClick = onClick, onLongClick = onLongClick)
                } else {
                    Modifier.clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = ripple(bounded = true, color = AiPink.copy(alpha = 0.25f)),
                        onClick = onClick
                    )
                }
            )
            .padding(vertical = 14.dp, horizontal = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(
            Modifier
                .size(42.dp)
                .clip(RoundedCornerShape(13.dp))
                .background(iconBg),
            contentAlignment = Alignment.Center
        ) {
            Text(label.take(1), fontWeight = FontWeight.Bold, color = Txt, fontSize = 15.sp)
        }
        Spacer(Modifier.height(7.dp))
        Text(label, fontSize = 11.5.sp, fontWeight = FontWeight.Bold, color = Txt)
        Text(subtitle, fontSize = 9.sp, color = Sub)
    }
}

/** 快捷操作 short */
@Composable
fun ShortAction(
    label: String,
    iconBg: Color,
    modifier: Modifier = Modifier,
    onClick: () -> Unit
) {
    Column(
        modifier
            .clip(RoundedCornerShape(16.dp))
            .background(Color.White)
            .border(1.dp, CardHairline, RoundedCornerShape(16.dp))
            .clickable(onClick = onClick)
            .padding(vertical = 12.dp, horizontal = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(
            Modifier
                .size(34.dp)
                .clip(RoundedCornerShape(11.dp))
                .background(iconBg),
            contentAlignment = Alignment.Center
        ) {
            Text(label.take(1), fontSize = 13.sp, fontWeight = FontWeight.Bold, color = Txt)
        }
        Spacer(Modifier.height(5.dp))
        Text(label, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = Txt)
    }
}

/** 预警行 */
@Composable
fun AlertRow(levelColor: Color, title: String, detail: String, onClick: (() -> Unit)? = null) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(levelColor))
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = Txt)
            Text(detail, fontSize = 11.sp, color = Sub)
        }
    }
}

/** 双折线迷你趋势（营收/对比） */
@Composable
fun DualSparkline(values: List<Float>, color: Color = AiPink) {
    if (values.isEmpty()) return
    val maxV = values.maxOrNull()?.coerceAtLeast(1f) ?: 1f
    val minV = values.minOrNull() ?: 0f
    val span = (maxV - minV).coerceAtLeast(1f)
    androidx.compose.foundation.Canvas(
        Modifier
            .fillMaxWidth()
            .height(46.dp)
            .padding(vertical = 4.dp)
    ) {
        val w = size.width
        val h = size.height
        val step = if (values.size == 1) w else w / (values.size - 1)
        val path = androidx.compose.ui.graphics.Path()
        values.forEachIndexed { i, v ->
            val x = i * step
            val y = h - ((v - minV) / span) * h * 0.85f - h * 0.08f
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        drawPath(path, color = color, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 3.5f, cap = androidx.compose.ui.graphics.StrokeCap.Round))
        val path2 = androidx.compose.ui.graphics.Path()
        values.forEachIndexed { i, v ->
            val x = i * step
            val y = h - ((v * 0.92f - minV) / span) * h * 0.85f - h * 0.08f
            if (i == 0) path2.moveTo(x, y) else path2.lineTo(x, y)
        }
        drawPath(path2, color = Color(0xFFC9CDD4), style = androidx.compose.ui.graphics.drawscope.Stroke(width = 2.5f, cap = androidx.compose.ui.graphics.StrokeCap.Round))
    }
}

/** 待办行 + 黑胶囊按钮 */
@Composable
fun TodoRow(title: String, detail: String, action: String, onAction: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Brush.horizontalGradient(listOf(Color.White, Color(0xFFFAFBFD))))
            .border(1.dp, Line, RoundedCornerShape(14.dp))
            .padding(11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = Txt)
            Text(detail, fontSize = 11.sp, color = Sub)
        }
        Text(
            action,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            color = Color.White,
            modifier = Modifier
                .clip(RoundedCornerShape(20.dp))
                .background(Brush.horizontalGradient(listOf(Ink, Color(0xFF3A3A3A))))
                .clickable(onClick = onAction)
                .padding(horizontal = 14.dp, vertical = 8.dp)
        )
    }
}

/**
 * 左滑露出确认/忽略（对齐原型 swipe-row）。
 * onConfirm / onDismiss 由业务决定；未提供时仅动画回弹。
 */
@Composable
fun SwipeTodoRow(
    title: String,
    detail: String,
    action: String,
    onAction: () -> Unit,
    onConfirm: (() -> Unit)? = null,
    onDismiss: (() -> Unit)? = null
) {
    var offsetX by remember { mutableStateOf(0f) }
    val maxReveal = with(LocalDensity.current) { 148.dp.toPx() }
    Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp))) {
        Row(
            Modifier
                .matchParentSize()
                .background(Color(0xFFF7F8FB))
                .padding(end = 8.dp),
            horizontalArrangement = Arrangement.End,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                "确认",
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                color = Color.White,
                modifier = Modifier
                    .clip(RoundedCornerShape(19.dp))
                    .background(FiveGreen)
                    .clickable {
                        offsetX = 0f
                        (onConfirm ?: onAction).invoke()
                    }
                    .padding(horizontal = 14.dp, vertical = 10.dp)
            )
            Spacer(Modifier.width(8.dp))
            Text(
                "忽略",
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                color = Color.White,
                modifier = Modifier
                    .clip(RoundedCornerShape(19.dp))
                    .background(FiveRed)
                    .clickable {
                        offsetX = 0f
                        onDismiss?.invoke()
                    }
                    .padding(horizontal = 14.dp, vertical = 10.dp)
            )
        }
        Box(
            Modifier
                .offset { IntOffset(offsetX.roundToInt(), 0) }
                .pointerInput(Unit) {
                    detectHorizontalDragGestures(
                        onDragEnd = {
                            offsetX = if (offsetX < -maxReveal * 0.45f) -maxReveal else 0f
                        },
                        onHorizontalDrag = { _, dx ->
                            offsetX = (offsetX + dx).coerceIn(-maxReveal, 0f)
                        }
                    )
                }
        ) {
            TodoRow(title = title, detail = detail, action = action, onAction = onAction)
        }
    }
}

/**
 * 模块加载态：硬错 / 软提示 + 一键重试。
 * 无快照、断网不再只甩一行「加载失败：xxx」。
 */
@Composable
fun LoadStatusBanner(
    error: String? = null,
    hint: String? = null,
    onRetry: (() -> Unit)? = null
) {
    if (error.isNullOrBlank() && hint.isNullOrBlank()) return
    val hard = !error.isNullOrBlank()
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(if (hard) FiveRed.copy(alpha = 0.10f) else Color(0xFFFFF6E8))
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        if (hard) {
            Text(error!!, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = FiveRed)
        }
        if (!hint.isNullOrBlank()) {
            Text(hint, fontSize = 12.sp, color = if (hard) Sub else Ink)
        }
        if (onRetry != null) {
            Text(
                "点击重试",
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
                color = AiPink,
                modifier = Modifier
                    .padding(top = 2.dp)
                    .clickable(onClick = onRetry)
            )
        }
    }
}
