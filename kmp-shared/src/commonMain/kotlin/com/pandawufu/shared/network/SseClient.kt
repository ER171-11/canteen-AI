package com.pandawufu.shared.network

import com.pandawufu.shared.model.KimiResultDto
import com.pandawufu.shared.model.KimiVisionRequest
import com.pandawufu.shared.model.AgentActionCard
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.utils.io.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** SSE 事件：对齐 BFF /api/kimi/vision/stream 的 event:stage/delta/done/error。 */
sealed class SseEvent {
    data class Stage(val stage: String) : SseEvent()
    data class Delta(val delta: String) : SseEvent()
    data class Done(val result: KimiResultDto, val model: String?, val traceId: String?) : SseEvent()
    data class Error(val message: String, val traceId: String?) : SseEvent()
}

/** SI 指挥台流式事件：对齐 BFF /api/agent/stream。 */
sealed class AgentSseEvent {
    /** 工具进度：stage=thinking 或 tool:<name> */
    data class Stage(val stage: String, val tool: String?) : AgentSseEvent()
    data class Delta(val delta: String) : AgentSseEvent()
    data class Done(
        val answer: String,
        val cards: List<AgentActionCard>,
        val engine: String?,
        val suggestions: List<String>,
        val rev: String?,
        val traceId: String?
    ) : AgentSseEvent()
    data class Error(val message: String, val traceId: String?) : AgentSseEvent()
}

/**
 * SSE 流式读取 POST /api/kimi/vision/stream。
 *
 * 协议：每条约 `event: <name>\ndata: <json>\n\n`，name ∈ stage/delta/done/error。
 *
 * 平台实现差异说明：
 *  - Android(OkHttp 引擎)：响应体按行流式可读，本实现直接生效。
 *  - iOS(Darwin/NSURLSession 引擎)：默认会缓冲整个响应；Ktor 2.x Darwin 引擎基于
 *    NSURLSession dataTask 流式回调，可逐行读取，但若遇到不刷新问题，需在
 *    HttpClient engine 配置中关闭缓存或改用 Ktor CIO/自定义 NSURLSession 封装。
 *  - 图片仅在内存：imageBase64 随请求体发送，不落盘、不入日志。
 */
class SseClient(private val bff: BffClient) {

    fun visionStream(request: KimiVisionRequest): Flow<SseEvent> = flow {
        bff.http.preparePost("${bff.baseUrl}/api/kimi/vision/stream") {
            contentType(ContentType.Application.Json)
            accept(ContentType.Text.EventStream)
            setBody(request)
        }.execute { response ->
            val channel: ByteReadChannel = response.bodyAsChannel()
            var eventName = ""
            val dataLines = StringBuilder()
            while (!channel.isClosedForRead) {
                val line = channel.readUTF8Line() ?: break
                when {
                    line.startsWith("event:") -> eventName = line.removePrefix("event:").trim()
                    line.startsWith("data:") -> dataLines.append(line.removePrefix("data:").trim())
                    line.isBlank() -> {
                        if (dataLines.isNotEmpty()) {
                            parseEvent(eventName, dataLines.toString())?.let { emit(it) }
                        }
                        eventName = ""
                        dataLines.clear()
                    }
                }
            }
        }
    }

    private fun parseEvent(name: String, data: String): SseEvent? = runCatching {
        val obj = Json.parseToJsonElement(data).jsonObject
        when (name) {
            "stage" -> SseEvent.Stage(obj["stage"]?.jsonPrimitive?.content ?: "")
            "delta" -> SseEvent.Delta(obj["delta"]?.jsonPrimitive?.content ?: "")
            "done" -> SseEvent.Done(
                result = Json { ignoreUnknownKeys = true }
                    .decodeFromJsonElement(KimiResultDto.serializer(), obj["result"]!!),
                model = obj["model"]?.jsonPrimitive?.content,
                traceId = obj["traceId"]?.jsonPrimitive?.content
            )
            "error" -> SseEvent.Error(
                message = obj["error"]?.jsonPrimitive?.content ?: "unknown",
                traceId = obj["traceId"]?.jsonPrimitive?.content
            )
            else -> null
        }
    }.getOrNull()

    /**
     * SSE 流式问店：POST /api/agent/stream {question}。
     * 事件：stage(thinking/tool) → delta(逐字) → done({answer,cards,engine,suggestions,rev}) / error。
     */
    fun agentStream(question: String): Flow<AgentSseEvent> = flow {
        bff.http.preparePost("${bff.baseUrl}/api/agent/stream") {
            contentType(ContentType.Application.Json)
            accept(ContentType.Text.EventStream)
            setBody(mapOf("question" to question))
        }.execute { response ->
            val channel: ByteReadChannel = response.bodyAsChannel()
            var eventName = ""
            val dataLines = StringBuilder()
            while (!channel.isClosedForRead) {
                val line = channel.readUTF8Line() ?: break
                when {
                    line.startsWith("event:") -> eventName = line.removePrefix("event:").trim()
                    line.startsWith("data:") -> dataLines.append(line.removePrefix("data:").trim())
                    line.isBlank() -> {
                        if (dataLines.isNotEmpty()) {
                            parseAgentEvent(eventName, dataLines.toString())?.let { emit(it) }
                        }
                        eventName = ""
                        dataLines.clear()
                    }
                }
            }
        }
    }

    private fun parseAgentEvent(name: String, data: String): AgentSseEvent? = runCatching {
        val obj = Json.parseToJsonElement(data).jsonObject
        when (name) {
            "stage" -> AgentSseEvent.Stage(
                stage = obj["stage"]?.jsonPrimitive?.contentOrNull ?: "",
                tool = obj["tool"]?.jsonPrimitive?.contentOrNull
            )
            "delta" -> AgentSseEvent.Delta(obj["delta"]?.jsonPrimitive?.contentOrNull ?: "")
            "done" -> {
                val json = Json { ignoreUnknownKeys = true }
                val cards = (obj["cards"] as? JsonElement)?.jsonArray
                    ?.mapNotNull { el ->
                        runCatching {
                            json.decodeFromJsonElement(AgentActionCard.serializer(), el)
                        }.getOrNull()
                    } ?: emptyList()
                val suggestions = obj["suggestions"]?.jsonArray
                    ?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList()
                AgentSseEvent.Done(
                    answer = obj["answer"]?.jsonPrimitive?.contentOrNull ?: "",
                    cards = cards,
                    engine = obj["engine"]?.jsonPrimitive?.contentOrNull,
                    suggestions = suggestions,
                    rev = obj["rev"]?.jsonPrimitive?.contentOrNull,
                    traceId = obj["traceId"]?.jsonPrimitive?.contentOrNull
                )
            }
            "error" -> AgentSseEvent.Error(
                message = obj["error"]?.jsonPrimitive?.contentOrNull ?: "unknown",
                traceId = obj["traceId"]?.jsonPrimitive?.contentOrNull
            )
            else -> null
        }
    }.getOrNull()
}
