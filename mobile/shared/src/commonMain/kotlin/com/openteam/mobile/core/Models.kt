package com.openteam.mobile.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

@Serializable
data class Session(
    val server: String,
    val token: String,
    val userId: String,
    val createdAt: String,
    val expiresAt: String? = null,
) {
    override fun toString(): String =
        "Session(server=$server, token=<redacted>, userId=$userId, createdAt=$createdAt, expiresAt=$expiresAt)"
}

@Serializable
data class ClientCursor(
    val accountKey: String,
    val sequence: String,
    val updatedAt: String,
)

@Serializable
data class MobileAsset(
    val assetId: String,
    val fileName: String,
    val mimeType: String,
    val byteSize: Long,
    val kind: String,
    val width: Int? = null,
    val height: Int? = null,
    val alt: String? = null,
)

@Serializable
data class MobileMessage(
    val id: String,
    val clientId: String? = null,
    val sequence: String,
    val channelId: String,
    val sender: String,
    val senderBotId: String? = null,
    val content: String,
    val createdAt: String,
    val metadata: JsonObject = JsonObject(emptyMap()),
)

/**
 * UI-neutral message shape for Android and iOS feature layers.
 *
 * Feature code should render this projection and keep the original metadata
 * available for forward-compatible rich message fields.
 */
data class MobileMessageProjection(
    val id: String,
    val clientId: String?,
    val channelId: String,
    val author: String,
    val body: String,
    val isMine: Boolean,
    val sequence: String,
    val createdAt: String,
    val metadata: JsonObject,
    val attachments: List<MobileAsset>,
    val replyToMessageId: String?,
    val reactions: Map<String, List<String>>,
    val richText: JsonObject?,
)

fun MobileMessage.toProjection(): MobileMessageProjection {
    val attachmentValues = metadata["attachments"]?.jsonArrayOrEmpty().orEmpty() +
        (metadata["attachment"]?.let(::singleJsonArray).orEmpty())
    val attachments = attachmentValues.mapNotNull {
        runCatching { mobileJson.decodeFromJsonElement(MobileAsset.serializer(), it) }.getOrNull()
    }.distinctBy { it.assetId }
    val reactions = metadata["reactions"]?.jsonObjectOrEmpty()
        ?.mapValues { (_, value) ->
            value.jsonArrayOrEmpty().orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }
        }
        .orEmpty()
    return MobileMessageProjection(
        id = id,
        clientId = clientId,
        channelId = channelId,
        author = sender,
        body = content,
        isMine = sender == "user" && senderBotId == null,
        sequence = sequence,
        createdAt = createdAt,
        metadata = metadata,
        attachments = attachments,
        replyToMessageId = metadata["replyTo"]?.jsonPrimitive?.contentOrNull,
        reactions = reactions,
        richText = metadata["richText"]?.jsonObjectOrEmpty(),
    )
}

private fun kotlinx.serialization.json.JsonElement.jsonArrayOrEmpty(): JsonArray? =
    runCatching { jsonArray }.getOrNull()

private fun kotlinx.serialization.json.JsonElement.jsonObjectOrEmpty(): JsonObject? =
    runCatching { jsonObject }.getOrNull()

private fun singleJsonArray(element: kotlinx.serialization.json.JsonElement): JsonArray =
    JsonArray(listOf(element))

@Serializable
data class ProductEvent(
    val sequence: String,
    val topic: String,
    val entityId: String? = null,
    val payload: JsonObject = JsonObject(emptyMap()),
    val createdAt: String? = null,
)

@Serializable
data class EventBatch(val events: List<ProductEvent> = emptyList())

@Serializable
enum class DeliveryStatus {
    PENDING,
    ACCEPTED,
    REJECTED,
    UNKNOWN,
}

@Serializable
data class DeliveryRecord(
    val clientId: String,
    val channelId: String,
    val status: DeliveryStatus,
    val messageId: String? = null,
    val createdAt: String,
    val updatedAt: String,
)

@Serializable
data class HistoryPage(
    val channelId: String,
    val messages: List<MobileMessage> = emptyList(),
    val threadContext: List<MobileMessage> = emptyList(),
    val threadContextTruncated: Boolean = false,
    val beforeSequence: String? = null,
    val hasMore: Boolean = false,
    val revision: String = "",
)

@Serializable
data class DeliveryLookup(
    val clientId: String,
    val status: String,
    val acceptedAtMs: Long? = null,
    val message: MobileMessage? = null,
    val code: String? = null,
    val messageText: String? = null,
)
