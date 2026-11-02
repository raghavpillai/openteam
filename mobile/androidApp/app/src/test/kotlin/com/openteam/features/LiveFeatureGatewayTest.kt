package com.openteam.features

import com.openteam.mobile.core.HttpMethod
import com.openteam.android.data.MobileFeatureApi
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveFeatureGatewayTest {
    @Test
    fun richActionsUseTheServerWidgetContract() = runBlocking {
        val client = RecordingFeatureClient()
        val gateway = LiveFeatureGateway(client)

        gateway.submitRichAction("message-1", "approve", mapOf("name" to "Ada")).getOrThrow()

        assertEquals(HttpMethod.POST, client.lastMethod)
        assertEquals("/api/v0/channel-messages/message-1/widget-response", client.lastPath)
        assertTrue(client.lastBody?.get("value")?.jsonPrimitive?.content?.contains("Ada") == true)
        assertTrue(client.lastBody?.get("clientId")?.jsonPrimitive?.content?.isNotBlank() == true)
    }

    @Test
    fun routineListAndTogglePreserveRevisionAndUseScopedRoutes() = runBlocking {
        val client = RecordingFeatureClient(
            buildJsonObject {
                put("value", buildJsonArray {
                    add(buildJsonObject {
                        put("id", "routine-1")
                        put("name", "Morning")
                        put("prompt", "Plan the day")
                        put("schedule", "0 9 * * *")
                        put("timezone", "UTC")
                        put("enabled", true)
                        put("revision", 7)
                    })
                })
            },
        )
        val gateway = LiveFeatureGateway(client)
        val routine = gateway.listRoutines("bot-1").getOrThrow().single()
        assertEquals("routine-1", routine.id)
        assertEquals(7, routine.revision)

        gateway.setRoutineEnabled(routine.id, false, routine.revision).getOrThrow()

        assertEquals("/api/v0/routines/routine-1/pause", client.lastPath)
        assertEquals(7, client.lastBody?.get("expectedRevision")?.jsonPrimitive?.int)
    }

    @Test
    fun webProviderSavePassesSecretRemovalAsNull() = runBlocking {
        val client = RecordingFeatureClient(buildJsonObject {
            put("search", buildJsonObject {
                put("selected", "exa")
                put("providers", buildJsonObject {
                    put("exa", buildJsonObject {
                        put("secretSaved", false)
                        put("ready", false)
                    })
                })
            })
            put("fetch", buildJsonObject { put("selected", JsonNull); put("providers", buildJsonObject { }) })
        })
        val gateway = LiveFeatureGateway(client)

        gateway.saveWebProvider("search", "exa", "", selected = false).getOrThrow()

        assertEquals("/api/v0/server-settings/web-providers", client.lastPath)
        val fields = client.lastBody?.get("search")?.jsonObject?.get("providers")?.jsonObject?.get("exa")?.jsonObject
        assertTrue(fields?.containsKey("apiKey") == true)
        assertTrue(fields?.get("apiKey")?.toString() == "null")
    }

    @Test
    fun attachmentDownloadUsesAuthenticatedBinaryTransport() = runBlocking {
        val client = RecordingFeatureClient()
        val gateway = LiveFeatureGateway(client)

        assertEquals("/api/v0/assets/asset-1", gateway.downloadAttachment("asset-1").getOrThrow())
        assertEquals(HttpMethod.GET, client.lastMethod)
        assertEquals("/api/v0/assets/asset-1", client.lastPath)
        assertTrue(client.downloaded)
    }

    @Test
    fun oauthStartExposesBrowserUrlAndCancellationUsesTheReturnedState() = runBlocking {
        val client = RecordingFeatureClient(
            responsesByPath = mapOf(
                "/api/v0/plugin-connections/connection-1/authenticate" to buildJsonObject {
                    put("authorizationUrl", "https://provider.example/authorize?state=oauth-state")
                },
                "/api/v0/plugins" to buildJsonObject {
                    put("installs", buildJsonArray {
                        add(buildJsonObject {
                            put("pluginKey", "calendar")
                            put("name", "Calendar")
                            put("description", "Calendar provider")
                            put("version", "1.0.0")
                            put("connections", buildJsonArray {
                                add(buildJsonObject {
                                    put("id", "connection-1")
                                    put("name", "Calendar account")
                                    put("auth", "oauth")
                                    put("configured", false)
                                    put("setupPhase", "authorization_pending")
                                })
                            })
                        })
                    })
                },
            ),
        )
        val gateway = LiveFeatureGateway(client)

        val started = gateway.authorizePlugin("connection-1").getOrThrow()

        assertEquals("https://provider.example/authorize?state=oauth-state", started.authorizationUrl)
        assertEquals("oauth-state", started.authorizationState)
        assertEquals("connection-1", started.connectionId)

        gateway.cancelPluginAuthorization("connection-1", started.authorizationState!!).getOrThrow()

        assertEquals("/api/v0/plugin-connections/connection-1/authenticate/cancel", client.lastPath)
        assertEquals("oauth-state", client.lastBody?.get("state")?.jsonPrimitive?.content)
    }

    @Test
    fun assetUploadMapsTheServerAssetRefForMessageDelivery() = runBlocking {
        val client = RecordingFeatureClient(buildJsonObject {
            put("assetId", "a".repeat(64))
            put("fileName", "notes.txt")
            put("mimeType", "text/plain")
            put("byteSize", 42)
            put("kind", "text")
        })

        val attachment = LiveFeatureGateway(client).uploadAttachment("content://share/notes").getOrThrow()

        assertEquals("a".repeat(64), attachment.id)
        assertEquals("notes.txt", attachment.name)
        assertEquals("text", attachment.kind)
        assertEquals(42, attachment.sizeBytes)
    }

    @Test
    fun routineEditorSendsAStableCronSchedule() = runBlocking {
        val client = RecordingFeatureClient()
        val routine = Routine(
            id = "routine-1",
            name = "Weekdays",
            prompt = "Plan the day",
            schedule = RoutineSchedule(
                frequency = RoutineSchedule.Frequency.Weekdays,
                timeMinutes = 9 * 60 + 30,
                timeZone = "Asia/Singapore",
            ),
            revision = 4,
        )

        LiveFeatureGateway(client).saveRoutine("bot-1", routine).getOrThrow()

        assertEquals("/api/v0/routines/routine-1", client.lastPath)
        assertEquals("30 9 * * 1-5", client.lastBody?.get("schedule")?.jsonPrimitive?.content)
        assertEquals(4, client.lastBody?.get("expectedRevision")?.jsonPrimitive?.int)
    }

    @Test
    fun settingsLoadAndProviderDisconnectUseDedicatedServerOperations() = runBlocking {
        val client = RecordingFeatureClient(
            responsesByPath = mapOf(
                "/api/v0/time-zone" to buildJsonObject { put("timeZone", "Asia/Singapore") },
                "/api/v0/notification-preferences" to buildJsonObject { put("smartEnabled", false) },
            ),
        )
        val gateway = LiveFeatureGateway(client)

        val settings = gateway.loadSettings().getOrThrow()
        assertEquals("Asia/Singapore", settings.timeZone)
        assertTrue(!settings.notifications.messages)
        gateway.disconnectProvider("openai").getOrThrow()
        assertEquals("/api/v0/inference-providers/openai", client.lastPath)
        assertEquals(HttpMethod.DELETE, client.lastMethod)
    }

    @Test
    fun oauthCallbackUsesTheManualServerCompletionContract() = runBlocking {
        val client = RecordingFeatureClient()

        LiveFeatureGateway(client).completePluginAuthorization(
            "connection-1",
            "openteam://oauth/callback?code=abc&state=oauth-state",
        ).getOrThrow()

        assertEquals("/api/v0/plugin-connections/connection-1/authenticate/manual", client.lastPath)
        assertEquals("openteam://oauth/callback?code=abc&state=oauth-state", client.lastBody?.get("callbackUrl")?.jsonPrimitive?.content)
    }

    private class RecordingFeatureClient(
        private val response: JsonObject = JsonObject(emptyMap()),
        private val responsesByPath: Map<String, JsonObject> = emptyMap(),
    ) : MobileFeatureApi {
        var lastMethod: HttpMethod? = null
        var lastPath: String? = null
        var lastBody: JsonObject? = null
        var downloaded = false

        override suspend fun request(method: HttpMethod, path: String, body: JsonObject?): JsonObject {
            lastMethod = method
            lastPath = path
            lastBody = body
            return responsesByPath[path] ?: response
        }

        override suspend fun upload(path: String, localUri: String): JsonObject = response

        override suspend fun download(path: String): String {
            downloaded = true
            lastMethod = HttpMethod.GET
            lastPath = path
            return path
        }
    }
}
