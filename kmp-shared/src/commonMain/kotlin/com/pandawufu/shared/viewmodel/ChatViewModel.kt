package com.pandawufu.shared.viewmodel

import com.pandawufu.shared.AppDispatchers
import com.pandawufu.shared.model.AgentActionCard
import com.pandawufu.shared.repository.AgentRepository
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
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
        val cards: List<AgentActionCard> = emptyList()
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

    fun dispatch(intent: Intent) {
        when (intent) {
            is Intent.Ask -> ask(intent.question.trim())
        }
    }

    private fun ask(q: String) {
        if (q.isEmpty()) return
        scope.launch {
            _state.update {
                it.copy(
                    loading = true,
                    error = null,
                    messages = it.messages + Message("user", q)
                )
            }
            try {
                val resp = repo.chat(q)
                val rev = resp.revText().ifBlank { null }
                _state.update {
                    it.copy(
                        loading = false,
                        messages = it.messages + Message(
                            role = "assistant",
                            text = resp.answer ?: "（无回答）",
                            cards = resp.cards
                        ),
                        suggestions = resp.suggestions.ifEmpty { it.suggestions },
                        note = resp.note,
                        rev = rev ?: it.rev
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
    }

    fun clear() = scope.cancel()
}
