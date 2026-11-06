package com.openteam.android.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class HttpMobileGatewayTest {
    @Test
    fun botIdFromDirectKeyStripsTheServerBotPrefix() {
        val channel = Json.parseToJsonElement("""{"directKey":"bot:bot-123"}""").jsonObject

        assertEquals("bot-123", channel.botIdFromDirectKey())
    }

    @Test
    fun botIdFromDirectKeyFallsBackToTheFirstMember() {
        val channel = Json.parseToJsonElement("""{"members":[{"botId":"bot-456"}]}""").jsonObject

        assertEquals("bot-456", channel.botIdFromDirectKey())
    }

    @Test
    fun botDisplayNamePrefersProfileNameOverRoleTitle() {
        val bot = Json.parseToJsonElement("""{"name":"Research Bot","title":"Assistant"}""").jsonObject

        assertEquals("Research Bot", bot.botDisplayName())
    }

    @Test
    fun botDisplayNameFallsBackToRoleTitleWhenNameIsMissing() {
        val bot = Json.parseToJsonElement("""{"title":"Assistant"}""").jsonObject

        assertEquals("Assistant", bot.botDisplayName())
    }

    @Test
    fun workingChannelsComeFromActiveRunsAndExecutingTasks() {
        val bootstrap = Json.parseToJsonElement(
            """
            {
              "activeRuns": [
                {"channelId":"a","status":"running"},
                {"channelId":"b","status":"queued"},
                {"channelId":"c","status":"completed"},
                {"channelId":null,"status":"running"}
              ],
              "subagents": [
                {"parentChannelId":"d","status":"provisioning"},
                {"parentChannelId":"e","status":"waiting"},
                {"parentChannelId":"f","status":"failed"}
              ]
            }
            """.trimIndent(),
        ).jsonObject

        assertEquals(setOf("a", "b", "d"), workingChannelIds(bootstrap))
    }

    @Test
    fun workingChannelsAreEmptyWhenBootstrapHasNoActivity() {
        assertEquals(emptySet<String>(), workingChannelIds(Json.parseToJsonElement("{}").jsonObject))
    }

    private fun activity(json: String) =
        channelActivityFrom("c1", Json.parseToJsonElement(json).jsonObject)

    @Test
    fun activityIsNullWhenNothingRunsInTheChannel() {
        assertEquals(null, activity("""{"runs":[{"id":"r1","channelId":"other","status":"running"},{"id":"r2","channelId":"c1","status":"completed"}]}"""))
    }

    @Test
    fun activityDefaultsToThinkingForAnActiveRunWithoutItems() {
        assertEquals(ChannelActivity.Thinking, activity("""{"runs":[{"id":"r1","channelId":"c1","status":"queued"}]}"""))
    }

    @Test
    fun activityFollowsTheNewestUnfinishedItemOfTheRunningRun() {
        val state = """
            {
              "runs":[{"id":"r0","channelId":"c1","status":"queued"},{"id":"r1","channelId":"c1","status":"running"}],
              "runItems":[
                {"runId":"r1","kind":"reasoning","status":"completed","createdAt":"3","updatedAt":"3"},
                {"runId":"r1","kind":"tool","status":"completed","title":"Shell","createdAt":"2","updatedAt":"2"},
                {"runId":"r1","kind":"tool","status":"running","content":{"tool":"SendToUser"},"createdAt":"1","updatedAt":"1"},
                {"runId":"r0","kind":"command","status":"running","createdAt":"9","updatedAt":"9"}
              ]
            }
        """.trimIndent()
        assertEquals(ChannelActivity.Typing, activity(state))
    }

    @Test
    fun activityMapsKindsAndToolNames() {
        fun item(kind: String, tool: String = "") =
            """{"runs":[{"id":"r","channelId":"c1","status":"running"}],"runItems":[{"runId":"r","kind":"$kind","status":"running","title":"$tool","createdAt":"1","updatedAt":"1"}]}"""
        assertEquals(ChannelActivity.RunningCommands, activity(item("command")))
        assertEquals(ChannelActivity.DraftingFile, activity(item("file_change")))
        assertEquals(ChannelActivity.SearchingWeb, activity(item("tool", "WebSearch")))
        assertEquals(ChannelActivity.Working, activity(item("tool", "Unknown")))
        assertEquals(ChannelActivity.Thinking, activity(item("agent_message")))
    }

    @Test
    fun activityFallsBackToBackgroundTasks() {
        assertEquals(ChannelActivity.Background, activity("""{"runs":[],"subagents":[{"parentChannelId":"c1","status":"running"}]}"""))
        assertEquals(null, activity("""{"runs":[],"subagents":[{"parentChannelId":"c1","status":"waiting"}]}"""))
    }
}
