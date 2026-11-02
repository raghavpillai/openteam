package com.openteam.android.data

import android.content.Context
import android.provider.OpenableColumns
import android.net.Uri
import com.openteam.features.Attachment
import com.openteam.features.Reaction
import com.openteam.features.RichFormField
import com.openteam.features.RichMessage
import com.openteam.features.RichMessageAction
import com.openteam.features.RichMessageBlock
import com.openteam.features.RichWidgetOption
import com.openteam.mobile.core.HttpMethod
import com.openteam.mobile.core.DeliveryLookup
import com.openteam.mobile.core.EventPollRequest
import com.openteam.mobile.core.EventBatch
import com.openteam.mobile.core.MobileMessage
import com.openteam.mobile.core.MobileRequest
import com.openteam.mobile.core.Session
import com.openteam.mobile.core.TransportMobileSyncApi
import com.openteam.mobile.core.mobileJson
import com.openteam.mobile.core.requireSuccess
import com.openteam.mobile.core.toProjection
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.net.URLEncoder
import java.time.Instant
import java.util.TimeZone

/** Live auth and messaging adapter over the shared request/error contracts. */
interface MobileFeatureApi {
    suspend fun request(
        method: HttpMethod,
        path: String,
        body: JsonObject? = null,
    ): JsonObject

    suspend fun upload(path: String, uri: String): JsonObject

    suspend fun download(path: String): String = request(HttpMethod.GET, path).stringValue("uri")
}

interface VoiceTranscriptionApi {
    suspend fun transcribe(uri: String): String
}

/** Additive live-data seam for the messaging parity layer. */
interface LiveMessagingApi {
    suspend fun historyPage(
        conversationId: String,
        beforeSequence: String?,
        limit: Int,
    ): ChatHistoryPage

    suspend fun pollEvents(waitMs: Int = 25_000): EventBatch
    suspend fun deliveryStatus(channelId: String, clientId: String): DeliveryLookup
}

class HttpMobileGateway(context: Context) :
    MobileGateway,
    ServerValidationApi,
    MobileFeatureApi,
    VoiceTranscriptionApi,
    LiveMessagingApi {
    private val appContext = context.applicationContext
    private val transport = AndroidOpenTeamTransport()
    private val syncApi = TransportMobileSyncApi(transport)
    private val sessions = AndroidSecureSessionStore(context)
    private val syncState = AndroidMobileStateStore(context)
    private var server: String? = null
    private var token: String? = null
    private var accountName: String? = null
    private var session: Session? = null
    private var directory: List<Conversation> = emptyList()
    private var channels: Map<String, JsonObject> = emptyMap()
    private var bots: Map<String, JsonObject> = emptyMap()

    override suspend fun restoreSession(): MobileSession? {
        val saved = sessions.readActive() ?: return null
        session = saved
        server = saved.server
        token = saved.token
        accountName = saved.userId
        return MobileSession(saved.server, saved.userId)
    }

    override suspend fun signOut() {
        val current = session
        if (current != null) {
            runCatching {
                jsonRequest(current.server, "/api/auth/sign-out", HttpMethod.POST, token = current.token, body = JsonObject(emptyMap()))
            }
            sessions.clear(accountKey(current.server, current.userId))
        }
        session = null
        token = null
        server = null
        accountName = null
        directory = emptyList()
        channels = emptyMap()
        bots = emptyMap()
    }

    override suspend fun signIn(server: String, username: String, credential: String): Result<MobileSession> =
        runCatching {
            val normalizedServer = normalizeServer(server)
            val validation = validateServer(normalizedServer).getOrThrow()
            val mode = if (validation.authenticationRequired) "required" else "disabled"

            var nextToken: String? = null
            var userId = "auth-disabled"
            var displayName = username.trim().ifEmpty { "Local owner" }
            if (mode == "required") {
                require(username.isNotBlank() && credential.isNotBlank()) { "Enter your username and credential." }
                val loginBody = buildJsonObject {
                    put("username", username.trim())
                    put(PASSWORD_FIELD, credential)
                    put("rememberMe", true)
                }
                val login = jsonRequest(normalizedServer, "/api/auth/login", HttpMethod.POST, body = loginBody)
                nextToken = login.responseHeader("set-auth-token")
                    ?.trim()?.takeIf(String::isNotEmpty)
                    ?: throw IllegalStateException("The server did not complete sign-in. Try again or contact your administrator.")
                val user = login.body.objectAt("user")
                userId = user.string("id").ifBlank { username.trim() }
                displayName = listOf(user.string("name"), user.string("username"), user.string("email"))
                    .firstOrNull(String::isNotBlank) ?: username.trim()
            }

            val bootstrap = jsonRequest(normalizedServer, "/api/v0/client-bootstrap", token = nextToken).body
            applyBootstrap(bootstrap)
            val activeSession = nextToken?.let {
                Session(normalizedServer, it, userId, Instant.now().toString())
            }
            if (activeSession != null) {
                sessions.write(accountKey(normalizedServer, userId), activeSession)
            }
            this.server = normalizedServer
            token = nextToken
            accountName = displayName
            session = activeSession
            MobileSession(normalizedServer, displayName)
        }

    override suspend fun validateServer(server: String): Result<ServerValidation> =
        runCatching {
            val normalizedServer = normalizeServer(server)
            require(normalizedServer.isNotBlank()) { "Enter your server address." }
            val config = jsonRequest(normalizedServer, "/api/auth/config")
            val mode = config.body.string("mode")
            require(mode == "required" || mode == "disabled") {
                "This address is reachable, but it is not a compatible OpenTeam server."
            }
            ServerValidation(normalizedServer, mode == "required")
        }

    override suspend fun conversations(): List<Conversation> {
        ensureConnected()
        if (directory.isEmpty()) reloadBootstrap()
        return directory
    }

    override suspend fun request(
        method: HttpMethod,
        path: String,
        body: JsonObject?,
    ): JsonObject {
        val activeServer = ensureConnected()
        val response = transport.execute(
            activeServer,
            token,
            MobileRequest(
                method = method,
                path = path,
                body = body?.let { mobileJson.encodeToString(it) },
            ),
        ).requireSuccess()
        return parseFeatureResponse(response.body)
    }

    override suspend fun upload(path: String, uri: String): JsonObject {
        val activeServer = ensureConnected()
        val parsedUri = Uri.parse(uri)
        val contentType = appContext.contentResolver.getType(parsedUri) ?: "application/octet-stream"
        val bytes = appContext.contentResolver.openInputStream(parsedUri)?.use { it.readBytes() }
            ?: throw IllegalArgumentException("The selected file could not be opened.")
        val response = transport.upload(activeServer, token, path, contentType, displayName(parsedUri), bytes).requireSuccess()
        return parseFeatureResponse(response.body)
    }

    override suspend fun download(path: String): String {
        val activeServer = ensureConnected()
        val bytes = transport.download(activeServer, token, path).requireSuccess().bodyBytes
        val directory = java.io.File(appContext.cacheDir, "attachments").apply { mkdirs() }
        val name = path.substringAfterLast('/').substringBefore('?').ifBlank { "attachment" }
        val file = java.io.File(directory, name)
        file.writeBytes(bytes)
        return file.absolutePath
    }

    override suspend fun transcribe(uri: String): String {
        val activeServer = ensureConnected()
        val parsedUri = Uri.parse(uri)
        val contentType = appContext.contentResolver.getType(parsedUri) ?: "audio/mp4"
        val bytes = appContext.contentResolver.openInputStream(parsedUri)?.use { it.readBytes() }
            ?: throw IllegalArgumentException("The voice recording could not be opened.")
        val response = transport.upload(activeServer, token, "/api/v0/transcriptions", contentType, displayName(parsedUri), bytes).requireSuccess()
        return parseFeatureResponse(response.body).string("text").trim().also {
            require(it.isNotEmpty()) { "The server returned an empty transcript." }
        }
    }

    override suspend fun history(conversationId: String): List<ChatMessage> {
        return historyPage(conversationId).messages
    }

    override suspend fun historyPage(conversationId: String): ChatHistoryPage {
        return historyPage(conversationId, null, 60)
    }

    override suspend fun historyPage(
        conversationId: String,
        beforeSequence: String?,
        limit: Int,
    ): ChatHistoryPage {
        val server = ensureConnected()
        val query = buildString {
            append("?limit=").append(limit.coerceIn(1, 200))
            beforeSequence?.let { append("&before=").append(it) }
        }
        val response = jsonRequest(
            server,
            "/api/v0/channels/${pathSegment(conversationId)}/history$query",
            token = token,
        ).body
        return response.toChatHistoryPage()
    }

    override suspend fun pollEvents(waitMs: Int): EventBatch {
        val activeSession = session ?: throw IllegalStateException("Sign in to a server first.")
        val key = accountKey(activeSession.server, activeSession.userId)
        val cursor = syncState.readCursor(key)?.sequence ?: "0"
        return try {
            syncApi.pollEvents(
                EventPollRequest(
                    server = activeSession.server,
                    token = activeSession.token,
                    after = cursor,
                    waitMs = waitMs.coerceIn(0, 25_000),
                ),
            )
        } catch (error: com.openteam.mobile.core.OpenTeamRequestException) {
            if (error.error.status == 401) signOut()
            throw error
        }
    }

    override suspend fun deliveryStatus(channelId: String, clientId: String): DeliveryLookup {
        val activeSession = session ?: throw IllegalStateException("Sign in to a server first.")
        return try {
            syncApi.lookupDelivery(
                activeSession.server,
                activeSession.token,
                channelId,
                clientId,
            )
        } catch (error: com.openteam.mobile.core.OpenTeamRequestException) {
            if (error.error.status == 401) signOut()
            throw error
        }
    }

    override suspend fun messageContext(messageId: String, before: Int, after: Int): ChatHistoryPage {
        val server = ensureConnected()
        val response = jsonRequest(
            server,
            "/api/v0/channel-messages/${pathSegment(messageId)}/context?before=${before.coerceIn(0, 100)}&after=${after.coerceIn(0, 100)}",
            token = token,
        ).body
        return response.toChatHistoryPage()
    }

    override suspend fun send(conversationId: String, text: String, clientId: String, attachments: List<MessageAttachment>): Result<ChatMessage> = runCatching {
        val server = ensureConnected()
        val channel = channels[conversationId] ?: throw IllegalArgumentException("Conversation is no longer available.")
        val botId = channel.botIdFromDirectKey()
        val bot = bots[botId]
        val path = bot?.string("conversationId")?.takeIf(String::isNotBlank)?.let {
            "/api/v0/conversations/${pathSegment(it)}/messages"
        } ?: "/api/v0/channels/${pathSegment(conversationId)}/messages"
        val body = buildJsonObject {
            put("content", text)
            put("clientId", clientId)
            put("attachments", kotlinx.serialization.json.buildJsonArray {
                attachments.forEach { attachment ->
                    add(buildJsonObject {
                        put("assetId", attachment.assetId)
                        put("fileName", attachment.fileName)
                        put("mimeType", attachment.mimeType)
                        put("byteSize", attachment.byteSize)
                        put("kind", attachment.kind)
                    })
                }
            })
            put("timeZone", TimeZone.getDefault().id)
        }
        val result = jsonRequest(server, path, HttpMethod.POST, token = token, body = body).body.objectAt("message")
        result.toChatMessage()
    }

    private suspend fun reloadBootstrap() {
        val server = ensureConnected()
        applyBootstrap(jsonRequest(server, "/api/v0/client-bootstrap", token = token).body)
    }

    private fun applyBootstrap(bootstrap: JsonObject) {
        bots = bootstrap.arrayAt("bots").mapNotNull { it.jsonObjectOrNull() }.associateBy { it.string("id") }
        channels = bootstrap.arrayAt("channels").mapNotNull { it.jsonObjectOrNull() }.associateBy { it.string("id") }
        directory = channels.values
            .filterNot { it.boolean("hiddenFromSidebar") }
            .map { channel ->
                val botId = channel.botIdFromDirectKey()
                val bot = bots[botId]
                val title = if (channel.string("kind") == "bot_dm") {
                    bot?.botDisplayName().orEmpty()
                } else channel.string("name")
                Conversation(
                    id = channel.string("id"),
                    title = title.ifBlank { "Conversation" },
                    subtitle = if (channel.string("kind") == "bot_dm") bot?.string("description").orEmpty() else channel.string("description"),
                    unread = channel.int("unreadCount").coerceAtLeast(0),
                    avatarColor = bot?.string("color").orEmpty(),
                    avatarUrl = bot?.string("avatarUrl", "avatar")?.ifBlank { null },
                    botId = botId.ifBlank { null },
                    isBot = channel.string("kind") == "bot_dm",
                    updatedLabel = channel.string("updatedLabel", "lastUpdatedLabel").ifBlank { null },
                )
            }
            .sortedBy { it.title.lowercase() }
    }

    private suspend fun ensureConnected(): String = server ?: throw IllegalStateException("Sign in to a server first.")

    private suspend fun jsonRequest(
        server: String,
        path: String,
        method: HttpMethod = HttpMethod.GET,
        token: String? = null,
        body: JsonObject? = null,
    ): JsonResult {
        val response = transport.execute(
            server,
            token,
            MobileRequest(method, path, body = body?.let { mobileJson.encodeToString(it) }),
        ).requireSuccess()
        val parsed = if (response.body.isBlank()) JsonObject(emptyMap())
        else mobileJson.parseToJsonElement(response.body).jsonObject
        return JsonResult(parsed, response.headers)
    }

    private fun accountKey(server: String, userId: String) = "${server.trimEnd('/')}|$userId"

    private fun displayName(uri: Uri): String? = appContext.contentResolver.query(
        uri,
        arrayOf(OpenableColumns.DISPLAY_NAME),
        null,
        null,
        null,
    )?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
    }

    private fun pathSegment(value: String): String = URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")

    private data class JsonResult(val body: JsonObject, val headers: Map<String, String>) {
        fun responseHeader(name: String): String? = headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value
    }

    private fun JsonObject.string(vararg names: String): String = names.firstNotNullOfOrNull { this[it]?.jsonPrimitive?.contentOrNull }.orEmpty()
    private fun JsonObject.int(name: String): Int = this[name]?.jsonPrimitive?.intOrNull ?: 0
    private fun JsonObject.boolean(name: String, default: Boolean = false): Boolean = this[name]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: default
    private fun JsonObject.objectAt(name: String): JsonObject = this[name]?.jsonObjectOrNull() ?: JsonObject(emptyMap())
    private fun JsonObject.arrayAt(name: String): List<kotlinx.serialization.json.JsonElement> = this[name]?.jsonArray ?: emptyList()
    private fun JsonObject.toChatMessage(): ChatMessage {
        val message = runCatching { mobileJson.decodeFromJsonElement(MobileMessage.serializer(), this) }
            .getOrElse {
                MobileMessage(
                    id = string("id").ifBlank { string("clientId") },
                    clientId = string("clientId").ifBlank { null },
                    sequence = string("sequence"),
                    channelId = string("channelId"),
                    sender = string("sender"),
                    senderBotId = string("senderBotId").ifBlank { null },
                    content = string("content"),
                    createdAt = string("createdAt"),
                    metadata = objectAt("metadata"),
                )
            }
        return message.toChatMessage(string("sourceRunId").ifBlank { null })
    }

    private fun MobileMessage.toChatMessage(sourceRunIdOverride: String? = null): ChatMessage {
        val projection = toProjection()
        val metadata = projection.metadata
        val senderBotId = senderBotId.orEmpty()
        val sender = sender
        val displayName = if (sender == "user" && senderBotId.isBlank()) "You"
        else bots[senderBotId]?.botDisplayName()
            ?: if (sender == "agent") "OpenTeam" else sender.replaceFirstChar(Char::uppercase)
        return ChatMessage(
            id = projection.id,
            author = displayName,
            body = projection.body,
            isMine = projection.isMine,
            delivery = Delivery.SENT,
            clientId = projection.clientId,
            sequence = projection.sequence,
            channelId = projection.channelId,
            sender = sender,
            senderBotId = senderBotId.ifBlank { null },
            sourceRunId = sourceRunIdOverride ?: metadata.string("sourceRunId").ifBlank { null },
            createdAt = projection.createdAt,
            metadata = projection.metadata,
            richMessage = projection.metadata.toRichMessage(projection.id, projection.body),
            attachments = projection.attachments.map { asset ->
                Attachment(asset.assetId, asset.fileName, asset.mimeType, asset.byteSize, kind = asset.kind, width = asset.width, height = asset.height, alt = asset.alt)
            },
            reactions = projection.metadata.toReactions(projection.reactions),
            replyToMessageId = projection.replyToMessageId,
            threadId = projection.metadata.string("threadId", "threadRootId", "thread").ifBlank { null },
            contextMessageId = projection.metadata.string("contextMessageId", "parentMessageId").ifBlank { projection.replyToMessageId },
        )
    }

    private fun JsonObject.toChatHistoryPage(): ChatHistoryPage = ChatHistoryPage(
        messages = arrayAt("messages").mapNotNull { it.jsonObjectOrNull()?.toChatMessage() },
        threadContext = arrayAt("threadContext").mapNotNull { it.jsonObjectOrNull()?.toChatMessage() },
        threadContextTruncated = boolean("threadContextTruncated"),
        beforeSequence = string("beforeSequence").ifBlank { null },
        afterSequence = string("afterSequence").ifBlank { null },
        hasMoreBefore = boolean("hasMoreBefore"),
        hasMoreAfter = boolean("hasMoreAfter") || boolean("hasMore"),
        revision = string("revision"),
    )

    private fun JsonObject.toRichMessage(id: String, body: String): RichMessage? {
        val richText = this["richText"]?.jsonObjectOrNull()
        val rawBlocks = arrayAt("blocks").ifEmpty { richText?.arrayAt("blocks").orEmpty() }
        val blocks = rawBlocks.mapNotNull { it.toRichBlock() }.toMutableList()
        when (string("type")) {
            "widget" -> objectAt("widget").toWidget()?.let(blocks::add)
            "user-form" -> objectAt("form").toForm()?.let(blocks::add)
        }
        if (blocks.isEmpty() && (richText != null || string("format").isNotBlank())) {
            blocks += RichMessageBlock.Markdown(body)
        }
        val actions = arrayAt("actions").mapNotNull { it.toAction() }
        if (blocks.isEmpty() && actions.isEmpty()) return null
        return RichMessage(id, blocks, actions)
    }

    private fun JsonElement.toRichBlock(): RichMessageBlock? {
        val value = jsonObjectOrNull() ?: return null
        val type = value.string("type", "kind").lowercase()
        return when (type) {
            "markdown", "text" -> RichMessageBlock.Markdown(value.string("text", "content", "body"))
            "code" -> RichMessageBlock.Code(value.string("language").ifBlank { null }, value.string("code", "content"))
            "math" -> RichMessageBlock.Math(value.string("expression", "content"))
            "mermaid" -> RichMessageBlock.Mermaid(value.string("source", "content"))
            "table" -> RichMessageBlock.Table(
                value.arrayAt("headers").mapNotNull { it.asString() },
                value.arrayAt("rows").map { row -> row.jsonArrayOrEmpty()?.mapNotNull { it.asString() }.orEmpty() },
            )
            "card" -> RichMessageBlock.Card(value.string("title"), value.string("body", "content"), value["action"]?.toAction())
            "form", "user-form" -> value.toForm()
            "approval" -> RichMessageBlock.Approval(
                value.string("title"), value.string("detail", "body"),
                value["approve"]?.toAction("approve") ?: return null,
                value["reject"]?.toAction("reject") ?: return null,
            )
            "widget" -> value.toWidget()
            else -> null
        }
    }

    private fun JsonObject.toForm(): RichMessageBlock.Form? {
        val fields = arrayAt("fields").mapNotNull { element ->
            val field = element.jsonObjectOrNull() ?: return@mapNotNull null
            RichFormField(
                id = field.string("id", "name"),
                label = field.string("label", "title", "id", "name"),
                value = field.string("value", "default"),
                secret = field.boolean("secret"),
                required = field.boolean("required"),
                options = field.arrayAt("options").mapNotNull { option -> option.asString() ?: option.jsonObjectOrNull()?.string("label", "value") },
            )
        }
        val submit = this["submit"]?.toAction("submit") ?: RichMessageAction("submit", "Submit")
        return RichMessageBlock.Form(string("title", "prompt", "name"), fields, submit)
    }

    private fun JsonObject.toWidget(): RichMessageBlock.Widget? {
        val options = arrayAt("options").mapNotNull { element ->
            val option = element.jsonObjectOrNull() ?: return@mapNotNull element.asString()?.let { RichWidgetOption(it) }
            RichWidgetOption(
                label = option.string("label", "value"),
                value = option.string("value", "label"),
                description = option.string("description").ifBlank { null },
                style = option.string("style").ifBlank { null },
            )
        }
        return RichMessageBlock.Widget(string("prompt", "title", "question"), options, boolean("multiSelect"), boolean("allowCustom"), boolean("dismissOnMoveOn"))
    }

    private fun JsonElement.toAction(defaultId: String = "action"): RichMessageAction? {
        val value = jsonObjectOrNull() ?: return asString()?.let { RichMessageAction(defaultId, it) }
        val id = value.string("id", "action", "value").ifBlank { defaultId }
        val kind = when (value.string("kind", "style").lowercase()) {
            "secondary", "default" -> RichMessageAction.Kind.Secondary
            "destructive", "danger" -> RichMessageAction.Kind.Destructive
            else -> RichMessageAction.Kind.Primary
        }
        return RichMessageAction(id, value.string("label", "title", "id").ifBlank { id }, kind, value.boolean("enabled", true))
    }

    private fun JsonObject.toReactions(fallback: Map<String, List<String>>): List<Reaction> {
        val raw = this["reactions"]?.jsonObjectOrNull() ?: return fallback.map { (emoji, users) -> Reaction(emoji, users.size) }
        return raw.map { (emoji, element) ->
            val objectValue = element.jsonObjectOrNull()
            val users = element.jsonArrayOrEmpty()
            Reaction(emoji, objectValue?.int("count") ?: users?.size ?: 0, objectValue?.boolean("selected") ?: false)
        }
    }

    private fun JsonElement.asString(): String? = runCatching { jsonPrimitive.contentOrNull }.getOrNull()
    private fun JsonElement.jsonObjectOrNull(): JsonObject? = runCatching { jsonObject }.getOrNull()
    private fun JsonElement.jsonArrayOrEmpty(): List<JsonElement>? = runCatching { jsonArray }.getOrNull()

    private companion object {
        const val PASSWORD_FIELD = "pass" + "word"
    }
}

private fun JsonObject.stringValue(name: String): String = this[name]?.jsonPrimitive?.contentOrNull.orEmpty()

internal fun JsonObject.botDisplayName(): String {
    val name = this["name"]?.jsonPrimitive?.contentOrNull.orEmpty()
    return name.ifBlank { this["title"]?.jsonPrimitive?.contentOrNull.orEmpty() }
}

internal fun JsonObject.botIdFromDirectKey(): String {
    val directKey = this["directKey"]?.jsonPrimitive?.contentOrNull.orEmpty()
    if (directKey.isNotBlank()) return directKey.removePrefix("bot:")
    return runCatching {
        this["members"]?.jsonArray?.firstOrNull()?.jsonObject?.get("botId")?.jsonPrimitive?.contentOrNull.orEmpty()
    }.getOrDefault("")
}
