package com.pandawufu.shared.network

import com.pandawufu.shared.model.KimiResultDto
import com.pandawufu.shared.model.KimiVisionRequest
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.utils.io.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** SSE 事件：对齐 BFF /api/kimi/vision/stream 的 event:stage/delta/done/error。 */
sealed class SseEvent {
    data class Stage(val stage: String) : SseEvent()
    data class Delta(val delta: String) : SseEvent()
    data class Done(val result: KimiResultDto, val model: String?, val traceId: String?) : SseEvent()
    data class Error(val message: String, val traceId: String?) : SseEvent()
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
}
