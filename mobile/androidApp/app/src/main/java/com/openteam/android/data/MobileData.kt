package com.openteam.android.data

import com.openteam.features.Attachment
import com.openteam.features.Reaction
import com.openteam.features.RichMessage
import kotlinx.serialization.json.JsonObject
import java.util.UUID

data class Conversation(
    val id: String,
    val title: String,
    val subtitle: String,
    val unread: Int = 0,
    val avatarColor: String = "",
    val avatarUrl: String? = null,
    val botId: String? = null,
    val isBot: Boolean = false,
    val updatedLabel: String? = null,
)

data class ChatMessage(
    val id: String,
    val author: String,
    val body: String,
    val isMine: Boolean = false,
    val delivery: Delivery = Delivery.SENT,
    val clientId: String? = null,
    val sequence: String = "",
    val channelId: String = "",
    val sender: String = "",
    val senderBotId: String? = null,
    val sourceRunId: String? = null,
    val createdAt: String = "",
    /** The untouched server metadata is retained for forward-compatible renderers. */
    val metadata: JsonObject = JsonObject(emptyMap()),
    val richMessage: RichMessage? = null,
    val attachments: List<Attachment> = emptyList(),
    val reactions: List<Reaction> = emptyList(),
    val replyToMessageId: String? = null,
    val threadId: String? = null,
    val contextMessageId: String? = null,
) {
    /** A safe label for malformed or metadata-only messages. */
    val displayBody: String?
        get() = body.ifBlank { if (richMessage == null && metadata.isNotEmpty()) "Unsupported message content" else null }
}

enum class Delivery { SENDING, SENT, FAILED }

data class MobileSession(val server: String, val accountName: String)

data class ServerValidation(
    val server: String,
    val authenticationRequired: Boolean,
)

interface ServerValidationApi {
    suspend fun validateServer(server: String): Result<ServerValidation>
}

data class OutgoingShare(val uri: String, val mimeType: String, val fileName: String)

data class MessageAttachment(
    val assetId: String,
    val fileName: String,
    val mimeType: String,
    val byteSize: Long,
    val kind: String,
)

data class ChatHistoryPage(
    val messages: List<ChatMessage> = emptyList(),
    val threadContext: List<ChatMessage> = emptyList(),
    val threadContextTruncated: Boolean = false,
    val beforeSequence: String? = null,
    val afterSequence: String? = null,
    val hasMoreBefore: Boolean = false,
    val hasMoreAfter: Boolean = false,
    val revision: String = "",
) {
    fun boundedThreadContext(limit: Int = DEFAULT_CONTEXT_LIMIT): List<ChatMessage> =
        threadContext.take(limit.coerceAtLeast(0))

    fun mergeAroundAnchor(existing: List<ChatMessage>, limit: Int = DEFAULT_HISTORY_LIMIT): List<ChatMessage> =
        (existing + messages + threadContext)
            .distinctBy(ChatMessage::id)
            .sortedWith(messageSequenceComparator)
            .takeLast(limit.coerceAtLeast(1))

    companion object {
        const val DEFAULT_CONTEXT_LIMIT = 20
        const val DEFAULT_HISTORY_LIMIT = 200

        fun merge(existing: List<ChatMessage>, incoming: List<ChatMessage>): List<ChatMessage> =
            buildMap {
                existing.forEach { put(it.id, it) }
                incoming.forEach { put(it.id, it) }
            }.values
                .sortedWith(messageSequenceComparator)
                .takeLast(DEFAULT_HISTORY_LIMIT)
    }
}

private val messageSequenceComparator = Comparator<ChatMessage> { left, right ->
    val leftSequence = left.sequence.toBigIntegerOrNullCompat()
    val rightSequence = right.sequence.toBigIntegerOrNullCompat()
    when {
        leftSequence != null && rightSequence != null -> leftSequence.compareTo(rightSequence)
        leftSequence != null -> -1
        rightSequence != null -> 1
        else -> left.createdAt.compareTo(right.createdAt)
    }
}

private fun String.toBigIntegerOrNullCompat() =
    takeIf(String::isNotBlank)?.let { runCatching { java.math.BigInteger(it) }.getOrNull() }

interface MobileGateway {
    suspend fun restoreSession(): MobileSession? = null
    suspend fun signOut() = Unit
    suspend fun signIn(server: String, username: String, credential: String): Result<MobileSession>
    suspend fun conversations(): List<Conversation>
    suspend fun history(conversationId: String): List<ChatMessage>
    suspend fun historyPage(conversationId: String): ChatHistoryPage = ChatHistoryPage(history(conversationId))
    suspend fun historyPage(
        conversationId: String,
        beforeSequence: String?,
        limit: Int = 60,
    ): ChatHistoryPage = historyPage(conversationId)
    suspend fun messageContext(messageId: String, before: Int = 20, after: Int = 20): ChatHistoryPage =
        throw UnsupportedOperationException("Message context is unavailable")
    suspend fun send(
        conversationId: String,
        text: String,
        clientId: String,
        attachments: List<MessageAttachment> = emptyList(),
    ): Result<ChatMessage>
    suspend fun sendWithAttachments(
        conversationId: String,
        text: String,
        clientId: String,
        attachments: List<Attachment>,
    ): Result<ChatMessage> = send(conversationId, text, clientId)
}

/** UI adapter seam; replace with the shared mobile-core repository when available. */
class PreviewMobileGateway : MobileGateway {
    private val people = listOf(
        Conversation("bot-1", "Orbit", "Your planning partner", 2),
        Conversation("bot-2", "Moss", "Research and writing"),
        Conversation("channel-1", "Studio", "# product-design", 1),
    )

    override suspend fun signIn(server: String, username: String, credential: String): Result<MobileSession> {
        if (server.isBlank() || username.isBlank() || credential.isBlank()) {
            return Result.failure(IllegalArgumentException("Enter a server, username, and credential."))
        }
        return Result.success(MobileSession(server.trim(), username.trim()))
    }

    override suspend fun conversations() = people

    override suspend fun history(conversationId: String): List<ChatMessage> = listOf(
        ChatMessage("welcome", "Orbit", "Good morning. What are we making progress on today?"),
        ChatMessage("mine-1", "You", "Let's shape the first release plan.", isMine = true),
        ChatMessage("reply-1", "Orbit", "Great. I can help turn the goals into a clear sequence."),
    )

    override suspend fun send(conversationId: String, text: String, clientId: String, attachments: List<MessageAttachment>) =
        Result.success(ChatMessage(clientId, "You", text, isMine = true))
}

fun newClientId(): String = UUID.randomUUID().toString()
