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
}
