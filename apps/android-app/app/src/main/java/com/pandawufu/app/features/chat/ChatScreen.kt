package com.pandawufu.app.features.chat

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.AppModule
import com.pandawufu.app.confirm.ConfirmBus
import com.pandawufu.app.confirm.ConfirmRequest
import com.pandawufu.app.ui.BossIa
import com.pandawufu.app.ui.Routes
import com.pandawufu.app.ui.designsystem.BrandBar
import com.pandawufu.app.ui.designsystem.AppScaffold
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.Line
import com.pandawufu.app.ui.designsystem.PageBg
import com.pandawufu.app.ui.designsystem.AppBgBrush
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.app.ui.designsystem.Txt
import com.pandawufu.shared.model.AgentActionCard
import com.pandawufu.shared.model.AgentStepDto
import com.pandawufu.shared.viewmodel.ChatViewModel

/** 老板 AI 页场景分组（对齐原型 p-chat suggest-grid，不堆工具箱） */
private enum class ChatScene(val label: String) {
    INVENTORY("进销"),
    KITCHEN("后厨"),
    BUSINESS("经营"),
    STORE("店务")
}

private data class ChatPrompt(
    val scene: ChatScene,
    val title: String,
    val hint: String,
    val question: String
)

private val CHAT_PROMPTS = listOf(
    ChatPrompt(ChatScene.INVENTORY, "下周备货建议", "补货闭环 · 销量预测", "下周该备多少货？"),
    ChatPrompt(ChatScene.INVENTORY, "缺料与报价", "库存线 · 供应商比价", "哪些原料需要补货？"),
    ChatPrompt(ChatScene.KITCHEN, "500份红饺用量", "菜谱换算 · 可转采购", "今天做500份红饺要多少料？"),
    ChatPrompt(ChatScene.KITCHEN, "菜品与配方", "功夫菜单 · 只读测算", "红色饺子怎么做？"),
    ChatPrompt(ChatScene.BUSINESS, "今日营收概况", "KPI · 时段对比", "今天营收怎么样？"),
    ChatPrompt(ChatScene.BUSINESS, "毛利结构分析", "成本拆解 · 调价建议", "哪个色毛利最低？为什么？"),
    ChatPrompt(ChatScene.STORE, "待办与预警", "今日盘面 · 只读汇总", "今天有哪些待办和预警？"),
    ChatPrompt(ChatScene.STORE, "确认打烊", "日清 · 须确认台", "确认打烊")
)

private val WELCOME_TEXT = BossIa.Ai.INTRO

/** 对应原型 p-chat：对话为主 · agent 只读问答 · 写操作走 ConfirmBus */
@Composable
fun ChatScreen(onOpenModule: (String) -> Unit = {}) {
    val context = LocalContext.current
    val viewModel = remember { ChatViewModel(AppModule.agentRepository) }
    val siVm = remember { com.pandawufu.shared.viewmodel.SiViewModel(AppModule.siRepository) }
    val state by viewModel.state.collectAsState()
    val siState by siVm.state.collectAsState()
    var input by remember { mutableStateOf("") }

    LaunchedEffect(Unit) {
        AppModule.ensureSession()
        siVm.dispatch(com.pandawufu.shared.viewmodel.SiViewModel.Intent.Refresh)
    }

    fun ask(q: String) {
        val trimmed = q.trim()
        if (trimmed.isEmpty()) return
        input = ""
        viewModel.dispatch(ChatViewModel.Intent.Ask(trimmed))
    }

    fun openCard(card: AgentActionCard) {
        if (!AppModule.canWrite()) {
            Toast.makeText(context, "当前岗位只读，无法进确认台", Toast.LENGTH_SHORT).show()
            return
        }
        ConfirmBus.ask(
            ConfirmRequest(
                title = card.title,
                summary = card.summary.ifBlank { "系统算好了 · 须老板点一次才落库" },
                type = card.type,
                payload = card.payload,
                baseRev = state.rev,
                onResult = { r ->
                    Toast.makeText(
                        context,
                        r.fold({ "已确认 · ${card.type}" }, { it.message ?: "失败" }),
                        Toast.LENGTH_SHORT
                    ).show()
                }
            )
        )
    }

    AppScaffold(
        title = BossIa.Ai.TITLE,
        subtitle = BossIa.Ai.SUB
    ) {
        val canCockpit = AppModule.role == "老板" || AppModule.role == "店长" || AppModule.can("analysis")
        val workbenches = buildList {
            if (AppModule.can("inventory")) add("采购工作台" to Routes.M_WB_PROCUREMENT)
            if (AppModule.can("kitchen")) add("厨师工作台" to Routes.M_WB_KITCHEN)
        }
        SiToolRow(
            decide = siState.inbox?.counts?.decide ?: 0,
            doing = siState.inbox?.counts?.doing ?: 0,
            canCockpit = canCockpit,
            workbenches = workbenches,
            onOpen = onOpenModule
        )

        state.note?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = Sub, lineHeight = 16.sp)
        }
        state.error?.let {
            Text("暂时答不上来：$it", color = Color(0xFFE8584A), fontSize = 12.sp)
        }

        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            if (state.messages.isEmpty() && !state.loading) {
                item { ChatSceneSuggestGrid(onPick = { ask(it) }) }
                item { ChatBubble(role = "assistant", text = WELCOME_TEXT) }
            }

            items(state.messages) { msg ->
                ChatBubble(role = msg.role, text = msg.text)
                if (msg.role == "assistant" && msg.steps.isNotEmpty()) {
                    ChatSteps(steps = msg.steps, engine = msg.engine)
                }
                if (msg.role == "assistant" && msg.cards.isNotEmpty()) {
                    ChatActionCards(cards = msg.cards, onOpen = { openCard(it) })
                }
            }

            if (state.messages.isNotEmpty() && state.suggestions.isNotEmpty() && !state.loading) {
                item { ChatFollowUpChips(suggestions = state.suggestions, onPick = { ask(it) }) }
            }

            if (state.loading) {
                item { CircularProgressIndicator(color = Ink, strokeWidth = 3.dp) }
            }
        }

        ChatVisionFootnote()

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("问店 SI…") },
                singleLine = true,
                shape = RoundedCornerShape(14.dp)
            )
            Button(
                onClick = { ask(input) },
                enabled = !state.loading && input.isNotBlank(),
                colors = ButtonDefaults.buttonColors(containerColor = Ink, contentColor = Color.White),
                shape = RoundedCornerShape(14.dp)
            ) { Text("发送", fontWeight = FontWeight.Bold) }
        }
    }
}

@Composable
private fun ChatActionCards(
    cards: List<AgentActionCard>,
    onOpen: (AgentActionCard) -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("系统算好了 · 点一次进确认台", fontSize = 11.sp, fontWeight = FontWeight.Bold, color = FiveGreen)
        cards.forEach { card ->
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = Color.White),
                modifier = Modifier
                    .fillMaxWidth()
                    .border(1.dp, FiveGreen.copy(alpha = 0.35f), RoundedCornerShape(14.dp))
            ) {
                Column(
                    Modifier.padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    Text(card.title, fontWeight = FontWeight.Bold, fontSize = 14.sp, color = Ink)
                    if (card.summary.isNotBlank()) {
                        Text(card.summary, fontSize = 12.sp, color = Sub, lineHeight = 16.sp)
                    }
                    Text("type · ${card.type}", fontSize = 10.sp, color = Sub)
                    OutlinedButton(
                        onClick = { onOpen(card) },
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(
                            card.ctaLabel.ifBlank { "去确认台" },
                            fontWeight = FontWeight.Bold,
                            color = FiveGreen
                        )
                    }
                }
            }
        }
    }
}

/** SI 指挥台入口：按老板高频三件事组织（要拍板 / 在办 / 目标）+ 低频设置收口。 */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun SiToolRow(
    decide: Int,
    doing: Int,
    canCockpit: Boolean,
    workbenches: List<Pair<String, String>>,
    onOpen: (String) -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (canCockpit) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(Ink)
                    .clickable { onOpen(Routes.M_SI_COCKPIT) }
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically
            ) {
                Text("全局 SI 驾驶舱", fontSize = 12.5.sp, fontWeight = FontWeight.ExtraBold, color = Color.White)
                Text("全店态势一屏看 ›", fontSize = 10.5.sp, color = Color.White.copy(alpha = 0.8f))
            }
        }
        if (workbenches.isNotEmpty()) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                workbenches.forEach { (label, route) ->
                    Column(
                        Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(12.dp))
                            .background(Color.White)
                            .border(1.dp, Line, RoundedCornerShape(12.dp))
                            .clickable { onOpen(route) }
                            .padding(10.dp)
                    ) {
                        Text("我的工作台", fontSize = 9.5.sp, color = Sub)
                        Text(label, fontSize = 12.5.sp, fontWeight = FontWeight.Bold, color = Ink)
                    }
                }
            }
        }
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(CardBg)
                .border(1.dp, Line, RoundedCornerShape(12.dp))
                .clickable { onOpen(Routes.HOME) }
                .padding(horizontal = 12.dp, vertical = 9.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically
        ) {
            Text("今日总览", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = Ink)
            Text("简报 · 主线 · KPI ›", fontSize = 10.5.sp, color = Sub)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SiEntryCell(
                title = "要我拍板",
                subtitle = if (decide > 0) "$decide 条等你点头" else "暂无待批",
                badge = decide,
                modifier = Modifier.weight(1f),
                onClick = { onOpen(Routes.M_INBOX) }
            )
            SiEntryCell(
                title = "SI 在办",
                subtitle = if (doing > 0) "执行中 $doing · 战役" else "战役 · 目标",
                badge = 0,
                modifier = Modifier.weight(1f),
                onClick = { onOpen(Routes.M_SI_MISSIONS) }
            )
            SiEntryCell(
                title = "目标",
                subtitle = "老板定标 · SI 盯",
                badge = 0,
                modifier = Modifier.weight(1f),
                onClick = { onOpen(Routes.M_SI_GOALS) }
            )
        }
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(CardBg)
                .border(1.dp, Line, RoundedCornerShape(12.dp))
                .clickable { onOpen(Routes.M_SI_SETTINGS) }
                .padding(horizontal = 12.dp, vertical = 9.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically
        ) {
            Text("SI 设置与能力", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = Ink)
            Text("授权 · 专家团 · 知识 · 模拟 ›", fontSize = 10.5.sp, color = Sub)
        }
    }
}

@Composable
private fun SiEntryCell(
    title: String,
    subtitle: String,
    badge: Int,
    modifier: Modifier = Modifier,
    onClick: () -> Unit
) {
    Column(
        modifier
            .clip(RoundedCornerShape(12.dp))
            .background(Color.White)
            .border(1.dp, Line, RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(10.dp)
    ) {
        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            Text(title, fontSize = 12.5.sp, fontWeight = FontWeight.Bold, color = Ink)
            if (badge > 0) {
                androidx.compose.foundation.layout.Spacer(Modifier.size(4.dp))
                Box(
                    Modifier
                        .clip(RoundedCornerShape(20.dp))
                        .background(Color(0xFFE8584A))
                        .padding(horizontal = 5.dp, vertical = 1.dp)
                ) {
                    Text("$badge", fontSize = 9.sp, fontWeight = FontWeight.Bold, color = Color.White)
                }
            }
        }
        Text(subtitle, fontSize = 10.sp, color = Sub)
    }
}

@Composable
private fun ChatSceneSuggestGrid(onPick: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(BossIa.Ai.QUICK, fontSize = 12.sp, fontWeight = FontWeight.Bold, color = Sub)
        ChatScene.entries.forEach { scene ->
            val prompts = CHAT_PROMPTS.filter { it.scene == scene }
            if (prompts.isEmpty()) return@forEach
            Text(scene.label, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = Sub)
            prompts.chunked(2).forEach { row ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { p ->
                        ChatSuggestCell(
                            title = p.title,
                            subtitle = p.hint,
                            modifier = Modifier.weight(1f),
                            onClick = { onPick(p.question) }
                        )
                    }
                    if (row.size == 1) {
                        androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

@Composable
private fun ChatSuggestCell(
    title: String,
    subtitle: String,
    modifier: Modifier = Modifier,
    onClick: () -> Unit
) {
    Column(
        modifier
            .clip(RoundedCornerShape(14.dp))
            .background(Color.White)
            .border(1.dp, Line, RoundedCornerShape(14.dp))
            .clickable(onClick = onClick)
            .padding(10.dp)
    ) {
        Text(title, fontSize = 11.5.sp, fontWeight = FontWeight.Bold, color = Txt)
        Text(subtitle, fontSize = 10.sp, color = Sub, modifier = Modifier.padding(top = 2.dp))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChatFollowUpChips(suggestions: List<String>, onPick: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("继续问", fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = Sub)
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            suggestions.take(6).forEach { s ->
                Text(
                    s,
                    modifier = Modifier
                        .clip(RoundedCornerShape(20.dp))
                        .background(CardBg)
                        .border(1.dp, Line, RoundedCornerShape(20.dp))
                        .clickable { onPick(s) }
                        .padding(horizontal = 10.dp, vertical = 6.dp),
                    fontSize = 11.sp,
                    color = Ink,
                    fontWeight = FontWeight.Medium
                )
            }
        }
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun ChatSteps(steps: List<AgentStepDto>, engine: String?) {    val label = if (engine == "si") "SI 查了这些只读数据" else "答案来自门店快照"
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, fontSize = 10.sp, color = Sub, fontWeight = FontWeight.SemiBold)
        androidx.compose.foundation.layout.FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            steps.forEach { s ->
                Text(
                    "🔧 ${toolLabel(s.tool)}",
                    modifier = Modifier
                        .clip(RoundedCornerShape(20.dp))
                        .background(CardBg)
                        .padding(horizontal = 8.dp, vertical = 4.dp),
                    fontSize = 10.sp,
                    color = Ink
                )
            }
        }
    }
}

private fun toolLabel(tool: String): String = when (tool) {
    "store_overview" -> "营收概况"
    "low_stock" -> "缺货清单"
    "forecast_restock" -> "备货预测"
    "dish_margin" -> "菜品毛利"
    "sales_trend" -> "营收走势"
    "pending_actions" -> "确认台待办"
    "list_alerts" -> "预警汇总"
    else -> tool
}

@Composable
private fun ChatBubble(role: String, text: String) {
    val isUser = role == "user"
    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (isUser) Color(0xFFF3F0F8) else CardBg
        ),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.padding(12.dp)) {
            Text(
                if (isUser) "我" else "问店 SI · 在线",
                style = MaterialTheme.typography.labelMedium,
                color = Sub,
                fontWeight = FontWeight.SemiBold
            )
            Text(text, style = MaterialTheme.typography.bodyMedium, color = Txt, lineHeight = 20.sp)
        }
    }
}

/** 拍照类 Kimi CTA 归属进销/后厨子页，本页仅提示路径，避免与对话抢主位 */
@Composable
private fun ChatVisionFootnote() {
    Text(
        "现场拍照：验货/盘点 → 货品；品控/留样 → 后厨。识别结论仅供参考，入账仍走确认台。",
        fontSize = 10.sp,
        color = Sub,
        lineHeight = 14.sp
    )
}
