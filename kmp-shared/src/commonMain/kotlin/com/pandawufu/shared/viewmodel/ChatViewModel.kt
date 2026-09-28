package com.pandawufu.shared.viewmodel

import com.pandawufu.shared.AppDispatchers
import com.pandawufu.shared.model.AgentActionCard
import com.pandawufu.shared.model.AgentStepDto
import com.pandawufu.shared.network.AgentSseEvent
import com.pandawufu.shared.repository.AgentRepository
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class ChatViewModel(
    private val repo: AgentRepository,
    dispatcher: CoroutineDispatcher = AppDispatchers.main
) {
    data class Message(
        val role: String,
        val text: String,
        /** 仅 assistant：可点提案 → ConfirmBus */
        val cards: List<AgentActionCard> = emptyList(),
        /** 仅 assistant：SI 本轮调用过的只读工具（过程可视化） */
        val steps: List<AgentStepDto> = emptyList(),
        /** si | rules */
        val engine: String? = null,
        val id: String = ""
    )

    data class State(
        val loading: Boolean = false,
        val messages: List<Message> = emptyList(),
        val suggestions: List<String> = listOf(
            "下周该备多少货？",
            "今天做500份红饺要多少料？",
            "今天营收怎么样？",
            "确认打烊"
        ),
        val rev: String? = null,
        val error: String? = null,
        val note: String? = null
    )

    sealed interface Intent {
        data class Ask(val question: String) : Intent
    }

    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()
    private var seq = 0

    fun dispatch(intent: Intent) {
        when (intent) {
            is Intent.Ask -> ask(intent.question.trim())
        }
    }

    private fun ask(q: String) {
        if (q.isEmpty()) return
        scope.launch {
            val n = seq++
            val uid = "u$n"
            val aid = "a$n"
            _state.update {
                it.copy(
                    loading = true,
                    error = null,
                    messages = it.messages + Message("user", q, id = uid)
                )
            }

            var text = ""
            var cards = emptyList<AgentActionCard>()
            var steps = emptyList<AgentStepDto>()
            var engine: String? = null
            var done = false

            fun render() {
                _state.update { st ->
                    val list = st.messages.toMutableList()
                    val idx = list.indexOfFirst { it.id == aid }
                    val msg = Message("assistant", text.ifBlank { "…" }, cards, steps, engine, aid)
                    if (idx >= 0) list[idx] = msg else list.add(msg)
                    st.copy(messages = list)
                }
            }

            try {
                repo.chatStream(q).collect { ev ->
                    when (ev) {
                        is AgentSseEvent.Stage -> {
                            if (!ev.tool.isNullOrBlank()) {
                                steps = steps + AgentStepDto(tool = ev.tool, ok = true)
                            }
                            render()
                        }
                        is AgentSseEvent.Delta -> {
                            text += ev.delta
                            render()
                        }
                        is AgentSseEvent.Done -> {
                            done = true
                            engine = ev.engine
                            if (ev.answer.isNotBlank()) text = ev.answer
                            cards = ev.cards
                            render()
                            _state.update {
                                it.copy(
                                    loading = false,
                                    suggestions = ev.suggestions.ifEmpty { it.suggestions },
                                    rev = ev.rev ?: it.rev,
                                    note = if (ev.engine == "si") {
                                        "SI 已用只读工具取数 · 提案进确认台 · AI 不写库"
                                    } else it.note
                                )
                            }
                        }
                        is AgentSseEvent.Error -> throw IllegalStateException(ev.message)
                    }
                }
                if (!done && text.isBlank()) throw IllegalStateException("stream empty")
                _state.update { it.copy(loading = false) }
            } catch (e: Exception) {
                // 流式失败 → 回退非流式问答
                fallback(q, aid)
            }
        }
    }

    private suspend fun fallback(q: String, aid: String) {
        try {
            val resp = repo.chat(q)
            _state.update { st ->
                val list = st.messages.toMutableList()
                val idx = list.indexOfFirst { it.id == aid }
                val msg = Message(
                    role = "assistant",
                    text = resp.answer ?: "（无回答）",
                    cards = resp.cards,
                    steps = resp.steps,
                    engine = resp.engine,
                    id = aid
                )
                if (idx >= 0) list[idx] = msg else list.add(msg)
                st.copy(
                    loading = false,
                    messages = list,
                    suggestions = resp.suggestions.ifEmpty { st.suggestions },
                    note = resp.note,
                    rev = resp.revText().ifBlank { st.rev }
                )
            }
        } catch (e: Exception) {
            val fail = com.pandawufu.shared.util.LoadFailure.from(e)
            _state.update {
                it.copy(
                    loading = false,
                    error = listOfNotNull(fail.error, fail.hint).joinToString(" · ").ifBlank { "提问失败" }
                )
            }
        }
    }

    fun clear() = scope.cancel()
}
