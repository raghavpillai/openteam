package com.openteam.features

import com.openteam.android.data.MobileFeatureApi
import com.openteam.mobile.core.HttpMethod
import com.openteam.mobile.core.mobileJson
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.net.URI
import java.net.URLEncoder
import java.net.URLDecoder

/**
 * Maps the feature contracts to the existing authenticated server API. The
 * request client owns tokens, redirects, file I/O, and error translation.
 */
class LiveFeatureGateway(private val client: MobileFeatureApi) : FeatureGateway {
    override suspend fun submitRichAction(messageId: String, actionId: String, values: Map<String, String>): Result<Unit> =
        runCatching {
            val route = values["_richType"] ?: actionId
            val cleanValues = values - "_richType"
            val (path, body) = when (route.lowercase()) {
                "user-form", "submit" -> "user-form" to buildJsonObject {
                    put("action", "submit")
                    put("values", cleanValues.toJson())
                    put("saveToVault", false)
                }
                "secret", "secret-request" -> "secret" to buildJsonObject { put("value", cleanValues["value"] ?: ""); put("clientId", clientId()) }
                "computer-handoff" -> "computer-handoff" to buildJsonObject { put("action", actionId); put("clientId", clientId()) }
                "external-draft" -> "external-draft" to buildJsonObject { put("action", actionId); put("edits", cleanValues.toJson()) }
                "imessage-send" -> "imessage-send" to buildJsonObject { put("action", actionId) }
                "bot-template" -> "bot-template" to buildJsonObject { put("action", actionId); put("clientId", clientId()) }
                "widget-dismiss" -> "widget-dismiss" to buildJsonObject { put("clientId", clientId()) }
                else -> "widget-response" to buildJsonObject {
                    put("value", cleanValues["value"] ?: if (cleanValues.isEmpty()) actionId else cleanValues.toJson().toString())
                    put("clientId", clientId())
                }
            }
            client.request(HttpMethod.POST, "/api/v0/channel-messages/${segment(messageId)}/$path", body)
        }.map { Unit }

    override suspend fun uploadAttachment(uri: String): Result<Attachment> = runCatching {
        client.upload("/api/v0/assets", uri).toAttachment()
    }

    override suspend fun downloadAttachment(attachmentId: String): Result<String> = runCatching {
        client.download("/api/v0/assets/${segment(attachmentId)}")
    }

    override suspend fun saveAttachment(attachmentId: String): Result<String> = runCatching {
        client.request(HttpMethod.POST, "/api/v0/assets/${segment(attachmentId)}/save").string("uri")
    }

    override suspend fun forwardAttachment(attachmentId: String, destinationId: String): Result<Unit> = runCatching {
        client.request(
            HttpMethod.POST,
            "/api/v0/assets/${segment(attachmentId)}/forward",
            buildJsonObject { put("destinationId", destinationId) },
        )
        Unit
    }

    override suspend fun mutateReaction(messageId: String, emoji: String): Result<List<Reaction>> = runCatching {
        val response = client.request(
            HttpMethod.POST,
            "/api/v0/channel-messages/${segment(messageId)}/reaction",
            buildJsonObject { put("emoji", emoji); put("clientId", clientId()) },
        )
        response.reactions()
    }

    override suspend fun mutateMessageAction(messageId: String, action: MessageAction): Result<Unit> = runCatching {
        submitRichAction(messageId, action.name.lowercase()).getOrThrow()
        Unit
    }

    override suspend fun listRoutines(ownerId: String): Result<List<Routine>> = runCatching {
        val owner = ownerId.ifBlank { firstBotId() }
        client.request(HttpMethod.GET, "/api/v0/bots/${segment(owner)}/routines").routineList()
    }

    override suspend fun saveRoutine(ownerId: String, routine: Routine): Result<Routine> = runCatching {
        val body = buildJsonObject {
            put("name", routine.name)
            put("prompt", routine.prompt)
            put("schedule", routine.schedule.serverSchedule())
            put("enabled", routine.enabled)
            put("expectedRevision", routine.revision)
            put("clientId", clientId())
        }
        val owner = ownerId.ifBlank { firstBotId() }
        val path = if (routine.id.isBlank()) "/api/v0/bots/${segment(owner)}/routines" else "/api/v0/routines/${segment(routine.id)}"
        client.request(if (routine.id.isBlank()) HttpMethod.POST else HttpMethod.PATCH, path, body).routineValue()
    }

    override suspend fun setRoutineEnabled(routineId: String, enabled: Boolean, expectedRevision: Int): Result<Routine> = runCatching {
        client.request(
            HttpMethod.POST,
            "/api/v0/routines/${segment(routineId)}/${if (enabled) "resume" else "pause"}",
            buildJsonObject { put("expectedRevision", expectedRevision); put("clientId", clientId()) },
        ).routineValue()
    }

    override suspend fun runRoutine(routineId: String): Result<Unit> = runCatching {
        client.request(HttpMethod.POST, "/api/v0/routines/${segment(routineId)}/test", buildJsonObject { put("clientId", clientId()) })
        Unit
    }

    override suspend fun deleteRoutine(routineId: String, expectedRevision: Int): Result<Unit> = runCatching {
        client.request(
            HttpMethod.DELETE,
            "/api/v0/routines/${segment(routineId)}",
            buildJsonObject { put("expectedRevision", expectedRevision); put("clientId", clientId()) },
        )
        Unit
    }

    override suspend fun loadAccountMemory(): Result<AccountMemoryState> = runCatching {
        val bootstrap = client.request(HttpMethod.GET, "/api/v0/client-bootstrap")
        val botId = bootstrap.array("bots").firstOrNull()?.jsonObjectOrNull()?.string("id")
        val memories = botId?.let { client.request(HttpMethod.GET, "/api/v0/bots/${segment(it)}/memories").array("memories") }.orEmpty()
        AccountMemoryState(
            profile = AccountProfile(
                displayName = "OpenTeam account",
                server = "Connected server",
                connected = true,
                version = "unknown",
            ),
            memories = memories.mapNotNull { it.jsonObjectOrNull()?.toMemory() },
        )
    }

    override suspend fun clearMemory(): Result<Unit> = runCatching {
        val botId = firstBotId()
        client.request(HttpMethod.DELETE, "/api/v0/bots/${segment(botId)}/memories")
        Unit
    }

    override suspend fun resetLocalData(): Result<Unit> = Result.success(Unit)

    override suspend fun signOut(): Result<Unit> = Result.success(Unit)

    override suspend fun loadSettings(): Result<AppSettings> = runCatching {
        val timeZone = client.request(HttpMethod.GET, "/api/v0/time-zone").string("timeZone", "timezone").ifBlank { "UTC" }
        val smartEnabled = client.request(HttpMethod.GET, "/api/v0/notification-preferences").boolean("smartEnabled", true)
        AppSettings(timeZone = timeZone, notifications = NotificationPreferences(smartEnabled, smartEnabled, smartEnabled))
    }

    override suspend fun saveSettings(settings: AppSettings): Result<AppSettings> = runCatching {
        client.request(HttpMethod.PATCH, "/api/v0/time-zone", buildJsonObject { put("timeZone", settings.timeZone) })
        client.request(HttpMethod.PATCH, "/api/v0/notification-preferences", buildJsonObject { put("smartEnabled", settings.notifications.messages || settings.notifications.mentions || settings.notifications.routineRuns) })
        settings
    }

    override suspend fun listProviderConnections(): Result<List<ProviderConnection>> = runCatching {
        client.request(HttpMethod.GET, "/api/v0/server-settings").providerList()
    }

    override suspend fun saveProvider(provider: ProviderConnection, apiKey: String?): Result<ProviderConnection> = runCatching {
        if (provider.authMode == AuthMode.OAuth && !provider.connected) {
            val started = client.request(HttpMethod.POST, "/api/v0/inference-providers/${segment(provider.id)}/auth-sessions", buildJsonObject { put("authType", "oauth") })
            provider.copy(authorizationUrl = started.string("authorizationUrl").ifBlank { null })
        } else if (!apiKey.isNullOrBlank()) {
            val auth = client.request(HttpMethod.POST, "/api/v0/inference-providers/${segment(provider.id)}/auth-sessions", buildJsonObject { put("authType", "api_key") })
            val sessionId = auth.string("id")
            val promptId = auth.objectAt("prompt").string("id")
            require(sessionId.isNotBlank() && promptId.isNotBlank()) { "The provider did not request an API key" }
            client.request(HttpMethod.POST, "/api/v0/inference-provider-auth-sessions/${segment(sessionId)}/respond", buildJsonObject { put("promptId", promptId); put("value", apiKey) })
            provider
        } else {
            client.request(HttpMethod.PATCH, "/api/v0/server-settings/inference", provider.toJson())
            provider
        }
    }

    override suspend fun disconnectProvider(providerId: String): Result<Unit> = runCatching {
        client.request(HttpMethod.DELETE, "/api/v0/inference-providers/${segment(providerId)}")
        Unit
    }

    override suspend fun loadWebProviders(): Result<WebProvidersState> = runCatching {
        client.request(HttpMethod.GET, "/api/v0/server-settings/web-providers").webProviders()
    }

    override suspend fun saveWebProvider(tool: String, providerId: String, apiKey: String?, selected: Boolean): Result<WebProvidersState> = runCatching {
        val provider = buildJsonObject {
            if (selected) put("selected", providerId) else put("selected", JsonNull)
            if (apiKey != null) {
                if (apiKey.isEmpty()) put("apiKey", JsonNull) else put("apiKey", apiKey)
            }
        }
        client.request(HttpMethod.PATCH, "/api/v0/server-settings/web-providers", buildJsonObject { put(tool, buildJsonObject { put("selected", provider["selected"]!!); put("providers", buildJsonObject { put(providerId, provider) }) }) }).webProviders()
    }

    override suspend fun checkWebProvider(tool: String, providerId: String): Result<WebProviderCheck> = runCatching {
        client.request(HttpMethod.POST, "/api/v0/server-settings/web-providers/check", buildJsonObject { put("tool", tool); put("provider", providerId) }).webCheck()
    }

    override suspend fun listPlugins(): Result<List<Plugin>> = runCatching {
        client.request(HttpMethod.GET, "/api/v0/plugins").pluginList()
    }

    override suspend fun installPlugin(pluginId: String): Result<Plugin> = runCatching {
        client.request(HttpMethod.POST, "/api/v0/plugins/install", buildJsonObject { put("pluginKey", pluginId) })
        listPlugins().getOrThrow().first { it.id == pluginId }
    }

    override suspend fun updatePlugin(pluginId: String): Result<Plugin> = runCatching {
        val packageView = client.request(HttpMethod.GET, "/api/v0/plugins/${segment(pluginId)}/package")
        val digest = packageView.string("digest", "packageDigest")
        require(digest.isNotBlank()) { "The server did not provide a plugin package digest" }
        client.request(HttpMethod.POST, "/api/v0/plugins/${segment(pluginId)}/update", buildJsonObject { put("digest", digest) })
        listPlugins().getOrThrow().first { it.id == pluginId }
    }

    override suspend fun rollbackPlugin(pluginId: String): Result<Plugin> = runCatching {
        client.request(HttpMethod.POST, "/api/v0/plugins/${segment(pluginId)}/rollback")
        listPlugins().getOrThrow().first { it.id == pluginId }
    }

    override suspend fun authorizePlugin(pluginId: String): Result<Plugin> = runCatching {
        val started = client.request(HttpMethod.POST, "/api/v0/plugin-connections/${segment(pluginId)}/authenticate", buildJsonObject { put("force", false) })
        val authorizationUrl = started.string("authorizationUrl")
        listPlugins().getOrThrow().firstOrNull { it.connectionId == pluginId }?.copy(
            authorizationUrl = authorizationUrl.ifBlank { null },
            authorizationState = authorizationUrl.takeIf(String::isNotBlank)?.let(::oauthState),
        ) ?: error("The server did not return the OAuth connection")
    }

    override suspend fun cancelPluginAuthorization(pluginId: String, state: String, redirectUrl: String?): Result<Unit> = runCatching {
        client.request(
            HttpMethod.POST,
            "/api/v0/plugin-connections/${segment(pluginId)}/authenticate/cancel",
            buildJsonObject {
                put("state", state)
                if (!redirectUrl.isNullOrBlank()) put("redirectUrl", redirectUrl)
            },
        )
        Unit
    }

    override suspend fun completePluginAuthorization(pluginId: String, callbackUrl: String): Result<Unit> = runCatching {
        client.request(HttpMethod.POST, "/api/v0/plugin-connections/${segment(pluginId)}/authenticate/manual", buildJsonObject { put("callbackUrl", callbackUrl) })
        Unit
    }

    override suspend fun testPluginTool(pluginId: String, toolName: String, input: String): Result<String> = runCatching {
        client.request(HttpMethod.POST, "/api/v0/plugin-connections/${segment(pluginId)}/test", buildJsonObject { put("toolName", toolName); put("arguments", runCatching { mobileJson.parseToJsonElement(input) }.getOrDefault(JsonPrimitive(input))) }).string("result")
    }

    override suspend fun configurePlugin(pluginId: String, configuration: JsonObject): Result<Plugin> = runCatching {
        client.request(HttpMethod.PUT, "/api/v0/plugin-connections/${segment(pluginId)}/configuration", configuration)
        listPlugins().getOrThrow().first { (it.connectionId ?: it.id) == pluginId }
    }

    private fun clientId() = "android-${System.currentTimeMillis()}"

    private suspend fun firstBotId(): String = client.request(HttpMethod.GET, "/api/v0/client-bootstrap")
        .array("bots").firstOrNull()?.jsonObjectOrNull()?.string("id")
        ?.takeIf(String::isNotBlank) ?: error("No bot is available for this operation")

    private companion object {
        fun segment(value: String) = URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
    }
}

private fun Map<String, String>.toJson() = buildJsonObject { forEach { (key, value) -> put(key, value) } }

private fun ProviderConnection.toJson() = buildJsonObject {
    put("providerId", id)
    put("model", selectedModel.orEmpty())
    put("reasoning", selectedReasoning.orEmpty())
}

private fun AppSettings.toJson() = buildJsonObject {
    put("appearance", appearance.name.lowercase())
    put("accent", accent.name.lowercase())
    put("language", language.name.lowercase())
    put("timeZone", timeZone)
    put("haptics", haptics)
    put("notifications", buildJsonObject {
        put("messages", notifications.messages)
        put("mentions", notifications.mentions)
        put("routineRuns", notifications.routineRuns)
    })
}

private fun JsonObject.routineList(): List<Routine> = array("routines").ifEmpty { array("value") }.mapNotNull { it.jsonObjectOrNull()?.toRoutine() }
private fun JsonObject.routineValue(): Routine = (this["routine"]?.jsonObjectOrNull() ?: this).toRoutine()
private fun JsonObject.pluginList(): List<Plugin> = array("installs").flatMap { element ->
    val install = element.jsonObjectOrNull() ?: return@flatMap emptyList()
    val connections = install.array("connections").mapNotNull { it.jsonObjectOrNull() }
    if (connections.isEmpty()) listOf(install.toPlugin()) else connections.map { install.toPlugin(it) }
}.ifEmpty { array("plugins").mapNotNull { it.jsonObjectOrNull()?.toPlugin() } }
private fun JsonObject.pluginValue(): Plugin = (this["plugin"]?.jsonObjectOrNull() ?: this).toPlugin()

private fun JsonObject.toRoutine(): Routine {
    val timeZone = string("timezone", "timeZone").ifBlank { "UTC" }
    val execution = objectAt("latestExecution")
    return Routine(
        id = string("id"),
        name = string("name"),
        prompt = string("prompt"),
        schedule = parseSchedule(string("schedule"), timeZone),
        enabled = boolean("enabled", true),
        revision = int("revision"),
        nextRunAt = string("nextRunAt").ifBlank { null },
        executions = if (execution.isEmpty()) emptyList() else listOf(RoutineExecution(execution.string("id"), execution.string("status"), execution.string("createdAt"))),
    )
}

private fun RoutineSchedule.serverSchedule(): String {
    val minutes = timeMinutes.coerceIn(0, 23 * 60 + 59)
    val minute = minutes % 60
    val hour = minutes / 60
    return when (frequency) {
        RoutineSchedule.Frequency.Hourly -> "%d * * * *".format(minute)
        RoutineSchedule.Frequency.Daily -> "%d %d * * *".format(minute, hour)
        RoutineSchedule.Frequency.Weekdays -> "%d %d * * 1-5".format(minute, hour)
        RoutineSchedule.Frequency.Weekly -> "%d %d * * %d".format(minute, hour, dayOfWeek.coerceIn(1, 7))
        RoutineSchedule.Frequency.Monthly -> "%d %d %d * *".format(minute, hour, dayOfMonth.coerceIn(1, 31))
        RoutineSchedule.Frequency.Interval -> "@every ${intervalAmount.coerceAtLeast(1)}${intervalUnit.name.first().lowercaseChar()}"
    }
}

private fun parseSchedule(value: String, timeZone: String): RoutineSchedule {
    if (value.startsWith("@every")) {
        val match = Regex("@every\\s+(\\d+)\\s*([mhdw])").find(value)
        if (match != null) {
            val unit = when (match.groupValues[2]) {
                "m" -> RoutineSchedule.IntervalUnit.Minutes
                "h" -> RoutineSchedule.IntervalUnit.Hours
                "w" -> RoutineSchedule.IntervalUnit.Weeks
                else -> RoutineSchedule.IntervalUnit.Days
            }
            return RoutineSchedule(RoutineSchedule.Frequency.Interval, intervalAmount = match.groupValues[1].toInt(), intervalUnit = unit, timeZone = timeZone)
        }
    }
    val fields = value.trim().split(Regex("\\s+"))
    val minute = fields.getOrNull(0)?.toIntOrNull()
    val hour = fields.getOrNull(1)?.toIntOrNull()
    if (fields.size == 5 && minute != null && fields[1] == "*") {
        return RoutineSchedule(RoutineSchedule.Frequency.Hourly, timeMinutes = minute, timeZone = timeZone)
    }
    if (fields.size == 5 && minute != null && hour != null) {
        val frequency = when {
            fields[4] == "1-5" -> RoutineSchedule.Frequency.Weekdays
            fields[4] != "*" -> RoutineSchedule.Frequency.Weekly
            fields[2] != "*" -> RoutineSchedule.Frequency.Monthly
            else -> RoutineSchedule.Frequency.Daily
        }
        return RoutineSchedule(frequency, hour * 60 + minute, timeZone, fields[4].toIntOrNull() ?: 1, fields[2].toIntOrNull() ?: 1)
    }
    return RoutineSchedule(timeZone = timeZone)
}

private fun JsonObject.toMemory() = MemoryItem(string("id"), string("title", "name"), string("content", "text"), string("updatedAt"))
private fun JsonObject.toPlugin(connection: JsonObject? = null): Plugin {
    val source = connection ?: this
    val pluginKey = string("pluginKey").ifBlank { string("key", "id") }
    val authorizationUrl = source.string("authorizationUrl").ifBlank { null }
    return Plugin(
        id = pluginKey,
        name = source.string("name").ifBlank { string("name") },
        description = string("description"),
        installedVersion = string("installedVersion", "version").ifBlank { null },
        latestVersion = string("latestVersion").ifBlank { null },
        requiresOAuth = source.string("auth") == "oauth" || boolean("requiresOAuth"),
        configured = source.boolean("configured") || boolean("configured"),
        busy = source.boolean("busy"),
        error = source.string("error").ifBlank { null },
        pluginKey = pluginKey,
        connectionId = source.string("id").ifBlank { null },
        authorizationUrl = authorizationUrl,
        authorizationState = authorizationUrl?.let(::oauthState),
        authorizationRedirectUrl = source.string("oauthRedirectUrl").ifBlank { null },
        oauthCallbackMode = source.string("oauthCallbackMode").ifBlank { null },
        setupPhase = source.string("setupPhase").ifBlank { null },
    )
}
private fun JsonObject.toAttachment() = Attachment(
    id = string("id", "assetId"),
    name = string("name", "fileName"),
    mimeType = string("mimeType"),
    sizeBytes = long("sizeBytes", "byteSize"),
    localUri = string("uri").ifBlank { null },
    kind = string("kind").ifBlank { "file" },
)

private fun oauthState(url: String): String? = runCatching {
    URI(url).rawQuery.orEmpty()
        .split('&')
        .asSequence()
        .map { it.split('=', limit = 2) }
        .firstOrNull { it.firstOrNull() == "state" }
        ?.getOrNull(1)
        ?.let { URLDecoder.decode(it, "UTF-8") }
}.getOrNull()

private fun JsonObject.providerList(): List<ProviderConnection> = array("providers").mapNotNull { it.jsonObjectOrNull()?.let { row ->
    val models = row.array("models").mapNotNull { model -> model.jsonObjectOrNull()?.string("modelId", "id", "name") ?: model.jsonPrimitive.contentOrNull }
    val reasoning = row.array("reasoningLevels").mapNotNull { level -> level.jsonObjectOrNull()?.string("id", "name") ?: level.jsonPrimitive.contentOrNull }
    ProviderConnection(row.string("id", "providerId"), row.string("name"), row.boolean("connected"), if (row.string("authType") == "oauth") AuthMode.OAuth else AuthMode.ApiKey, row.boolean("apiKeySaved"), models, row.string("model", "selectedModel").ifBlank { null }, reasoning, row.string("reasoning", "selectedReasoning").ifBlank { null }, row.string("error").ifBlank { null }, row.string("authorizationUrl").ifBlank { null })
} }

private fun JsonObject.webProviders(): WebProvidersState = WebProvidersState(webTool("search"), webTool("fetch"))
private fun JsonObject.webTool(name: String): List<WebProvider> {
    val tool = this[name]?.jsonObjectOrNull() ?: return emptyList()
    val selected = tool.string("selected")
    return tool["providers"]?.jsonObjectOrNull()?.map { (id, element) ->
        val state = element.jsonObjectOrNull() ?: JsonObject(emptyMap())
        WebProvider(id, id, state.string("description"), state.boolean("needsKey"), state.boolean("secretSaved"), state.boolean("ready"), id == selected, state["check"]?.jsonObjectOrNull()?.let { it.webCheck() })
    } ?: emptyList()
}

private fun JsonObject.webCheck() = WebProviderCheck(boolean("passed"), string("message"), string("checkedAt").ifBlank { null })
private fun JsonObject.reactions() = array("reactions").mapNotNull { element -> element.jsonObjectOrNull()?.let { Reaction(it.string("emoji"), it.int("count"), it.boolean("selected")) } }

private fun JsonObject.array(name: String): List<JsonElement> = this[name]?.jsonArray ?: emptyList()
private fun JsonObject.objectAt(name: String): JsonObject = this[name]?.jsonObjectOrNull() ?: JsonObject(emptyMap())
private fun JsonObject.string(vararg names: String): String = names.firstNotNullOfOrNull { this[it]?.jsonPrimitive?.contentOrNull }.orEmpty()
private fun JsonObject.boolean(name: String, default: Boolean = false): Boolean = this[name]?.jsonPrimitive?.contentOrNull?.toBooleanStrictOrNull() ?: default
private fun JsonObject.int(vararg names: String): Int = names.firstNotNullOfOrNull { this[it]?.jsonPrimitive?.intOrNull } ?: 0
private fun JsonObject.long(vararg names: String): Long = names.firstNotNullOfOrNull { this[it]?.jsonPrimitive?.contentOrNull?.toLongOrNull() } ?: 0
private fun JsonElement.jsonObjectOrNull(): JsonObject? = runCatching { jsonObject }.getOrNull()
