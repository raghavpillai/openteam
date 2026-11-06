package com.openteam.mobile.core

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

data class EventPollRequest(
    val server: String,
    val token: String?,
    val after: String,
    val waitMs: Int,
)

interface MobileSyncApi {
    suspend fun pollEvents(request: EventPollRequest): EventBatch
    suspend fun openEvents(server: String, token: String?, after: String): MobileResponse
    suspend fun readHistory(
        server: String,
        token: String?,
        channelId: String,
        beforeSequence: String?,
        limit: Int,
    ): HistoryPage

    suspend fun sendMessage(
        server: String,
        token: String?,
        channelId: String,
        content: String,
        clientId: String,
    ): MobileMessage

    suspend fun lookupDelivery(
        server: String,
        token: String?,
        channelId: String,
        clientId: String,
    ): DeliveryLookup
}

/** Request/response implementation shared by Android and iOS adapters. */
class TransportMobileSyncApi(
    private val transport: OpenTeamTransport,
    private val eventPath: String = "/api/v0/events/poll",
) : MobileSyncApi {
    override suspend fun pollEvents(request: EventPollRequest): EventBatch {
        val response = transport.execute(
            request.server,
            request.token,
            MobileRequest(
                HttpMethod.GET,
                "$eventPath?after=${request.after}&waitMs=${request.waitMs}",
            ),
        ).requireSuccess()
        return mobileJson.decodeFromString(response.body)
    }

    override suspend fun openEvents(
        server: String,
        token: String?,
        after: String,
    ): MobileResponse =
        transport.execute(
            server,
            token,
            MobileRequest(HttpMethod.GET, "/api/v0/events?after=${after.encodeURLPathSegment()}"),
        )

    override suspend fun readHistory(
        server: String,
        token: String?,
        channelId: String,
        beforeSequence: String?,
        limit: Int,
    ): HistoryPage {
        val query = buildString {
            append("?limit=").append(limit.coerceIn(1, 200))
            beforeSequence?.let { append("&before=").append(it) }
        }
        val response = transport.execute(
            server,
            token,
            MobileRequest(HttpMethod.GET, "/api/v0/channels/${segment(channelId)}/history$query"),
        ).requireSuccess()
        return mobileJson.decodeFromString(response.body)
    }

    override suspend fun sendMessage(
        server: String,
        token: String?,
        channelId: String,
        content: String,
        clientId: String,
    ): MobileMessage {
        val body = buildJsonObject {
            put("content", content)
            put("clientId", clientId)
            put("attachments", JsonArray(emptyList()))
        }
        val response = transport.execute(
            server,
            token,
            MobileRequest(
                HttpMethod.POST,
                "/api/v0/channels/${segment(channelId)}/messages",
                body = mobileJson.encodeToString(body),
            ),
        ).requireSuccess()
        val root = mobileJson.parseToJsonElement(response.body).jsonObject
        return mobileJson.decodeFromJsonElement(
            MobileMessage.serializer(),
            root["message"] ?: JsonObject(emptyMap()),
        )
    }

    override suspend fun lookupDelivery(
        server: String,
        token: String?,
        channelId: String,
        clientId: String,
    ): DeliveryLookup {
        val response = transport.execute(
            server,
            token,
            MobileRequest(
                HttpMethod.GET,
                "/api/v0/channels/${segment(channelId)}/message-deliveries/${segment(clientId)}",
            ),
        ).requireSuccess()
        return mobileJson.decodeFromString(response.body)
    }

    private fun segment(value: String): String =
        value.encodeURLPathSegment()
}

private fun String.encodeURLPathSegment(): String = buildString {
    for (byte in encodeToByteArray()) {
        val char = byte.toInt().and(0xff).toChar()
        if (char.isLetterOrDigit() || char in "-._~") append(char)
        else append('%').append(byte.toInt().and(0xff).toString(16).uppercase().padStart(2, '0'))
    }
}

class EventStreamParser {
    private var buffer = ""

    fun append(chunk: String): List<ProductEvent> {
        buffer += chunk.replace("\r\n", "\n")
        val events = mutableListOf<ProductEvent>()
        var boundary = buffer.indexOf("\n\n")
        while (boundary >= 0) {
            parseBlock(buffer.substring(0, boundary))?.let(events::add)
            buffer = buffer.substring(boundary + 2)
            boundary = buffer.indexOf("\n\n")
        }
        return events
    }

    fun finish(): List<ProductEvent> =
        parseBlock(buffer.trimEnd()).let(::listOfNotNull).also { buffer = "" }

    private fun parseBlock(block: String): ProductEvent? {
        if (block.isBlank()) return null
        var eventName = "message"
        val data = buildString {
            block.lineSequence().forEach { line ->
                when {
                    line.startsWith("event:") -> eventName = line.removePrefix("event:").trim()
                    line.startsWith("data:") -> {
                        if (isNotEmpty()) append('\n')
                        append(line.removePrefix("data:").trimStart())
                    }
                }
            }
        }
        if (eventName != "product" || data.isBlank()) return null
        return mobileJson.decodeFromString<ProductEvent>(data)
    }
}

data class ReconnectPolicy(
    val maxAttempts: Int = 5,
    val initialDelayMs: Long = 500,
    val maxDelayMs: Long = 15_000,
) {
    fun delayFor(attempt: Int): Long {
        if (attempt <= 0) return 0
        val exponent = (attempt - 1).coerceAtMost(30)
        return (initialDelayMs * (1L shl exponent)).coerceAtMost(maxDelayMs)
    }
}

class EventSynchronizer(
    private val accountKey: String,
    private val server: String,
    private val token: String?,
    private val store: MobileStateStore,
    private val api: MobileSyncApi,
    private val clock: MobileClock,
    private val applyEvent: suspend (ProductEvent) -> Unit,
    private val onUnauthorized: suspend () -> Unit = {},
) {
    suspend fun pollOnce(waitMs: Int = 25_000): Int {
        val cursor = store.readCursor(accountKey)?.sequence?.takeIf { it.isDecimal() } ?: "0"
        val batch = try {
            api.pollEvents(EventPollRequest(server, token, cursor, waitMs))
        } catch (error: OpenTeamRequestException) {
            if (error.error.status == 401) onUnauthorized()
            throw error
        }
        var accepted = 0
        for (event in batch.events.sortedWith { left, right ->
            compareSequences(left.sequence, right.sequence)
        }) {
            if (accept(event)) accepted++
        }
        return accepted
    }

    suspend fun acceptSseChunk(parser: EventStreamParser, chunk: String): Int =
        acceptEvents(parser.append(chunk))

    suspend fun acceptSseEnd(parser: EventStreamParser): Int =
        acceptEvents(parser.finish())

    private suspend fun acceptEvents(events: List<ProductEvent>): Int {
        var accepted = 0
        for (event in events) {
            if (accept(event)) accepted++
        }
        return accepted
    }

    private suspend fun accept(event: ProductEvent): Boolean {
        val current = store.readCursor(accountKey)?.sequence
        if (current != null && compareSequences(event.sequence, current) <= 0) return false
        applyEvent(event)
        store.writeCursor(ClientCursor(accountKey, event.sequence, clock.nowUtc()))
        return true
    }
}

class HistoryPager(
    private val accountKey: String,
    private val server: String,
    private val token: String?,
    private val channelId: String,
    private val api: MobileSyncApi,
    private val limit: Int = 60,
) {
    private var beforeSequence: String? = null
    private var exhausted = false

    val isExhausted: Boolean get() = exhausted

    suspend fun next(): HistoryPage? {
        if (exhausted) return null
        val page = api.readHistory(server, token, channelId, beforeSequence, limit)
        beforeSequence = page.beforeSequence ?: page.messages.minOfOrNull { it.sequence }
        exhausted = !page.hasMore || beforeSequence == null
        return page
    }
}

class DeliveryJournal(
    private val accountKey: String,
    private val server: String,
    private val token: String?,
    private val store: MobileStateStore,
    private val api: MobileSyncApi,
    private val clock: MobileClock,
    private val onUnauthorized: suspend () -> Unit = {},
) {
    suspend fun begin(channelId: String, content: String, clientId: String): DeliveryRecord {
        val now = clock.nowUtc()
        val record = DeliveryRecord(clientId, channelId, DeliveryStatus.PENDING, createdAt = now, updatedAt = now)
        store.writeDelivery(accountKey, record)
        return record
    }

    suspend fun send(channelId: String, content: String, clientId: String): DeliveryRecord {
        val existing = store.readDelivery(accountKey, clientId)
            ?: begin(channelId, content, clientId)
        return try {
            val message = api.sendMessage(server, token, channelId, content, clientId)
            existing.copy(
                status = DeliveryStatus.ACCEPTED,
                messageId = message.id,
                updatedAt = clock.nowUtc(),
            ).also { store.writeDelivery(accountKey, it) }
        } catch (error: OpenTeamRequestException) {
            if (error.error.status == 401) {
                onUnauthorized()
                throw error
            }
            existing.copy(
                status = if (error.error.retryable == true) DeliveryStatus.UNKNOWN else DeliveryStatus.REJECTED,
                updatedAt = clock.nowUtc(),
            ).also { store.writeDelivery(accountKey, it) }
        } catch (_: Throwable) {
            existing.copy(status = DeliveryStatus.UNKNOWN, updatedAt = clock.nowUtc())
                .also { store.writeDelivery(accountKey, it) }
        }
    }

    suspend fun reconcile(channelId: String, clientId: String): DeliveryRecord {
        val existing = store.readDelivery(accountKey, clientId)
            ?: error("Delivery $clientId has not been journaled")
        val lookup = try {
            api.lookupDelivery(server, token, channelId, clientId)
        } catch (error: OpenTeamRequestException) {
            if (error.error.status == 401) onUnauthorized()
            throw error
        }
        val status = when (lookup.status.lowercase()) {
            "accepted" -> DeliveryStatus.ACCEPTED
            "pending", "processing" -> DeliveryStatus.PENDING
            "rejected", "failed" -> DeliveryStatus.REJECTED
            else -> DeliveryStatus.UNKNOWN
        }
        return existing.copy(
            status = status,
            messageId = lookup.message?.id ?: existing.messageId,
            updatedAt = clock.nowUtc(),
        ).also { store.writeDelivery(accountKey, it) }
    }
}

private fun String.isDecimal(): Boolean = isNotEmpty() && all(Char::isDigit)

private fun compareSequences(left: String, right: String): Int =
    when {
        left.length != right.length -> left.length.compareTo(right.length)
        else -> left.compareTo(right)
    }
