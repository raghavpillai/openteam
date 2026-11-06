package com.openteam.android

import com.openteam.mobile.core.ProductEvent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class AppViewModelEventsTest {
    private fun event(topic: String, payload: String = "{}") =
        ProductEvent("1", topic, payload = Json.parseToJsonElement(payload).jsonObject)

    @Test
    fun streamingNoiseDoesNotRefresh() {
        assertEquals(false, shouldRefreshForEvent(event("message.delta")))
        assertEquals(false, shouldRefreshForEvent(event("conversation.attached")))
        for (type in listOf("agentMessage", "reasoning", "plan")) {
            assertEquals(false, shouldRefreshForEvent(event("run_item.started", """{"item":{"type":"$type"}}""")))
            assertEquals(false, shouldRefreshForEvent(event("run_item.completed", """{"item":{"type":"$type"}}""")))
        }
    }

    @Test
    fun runLifecycleAndOtherItemsRefresh() {
        assertEquals(true, shouldRefreshForEvent(event("run.started")))
        assertEquals(true, shouldRefreshForEvent(event("run.completed")))
        assertEquals(true, shouldRefreshForEvent(event("channel.message.created")))
        assertEquals(true, shouldRefreshForEvent(event("run_item.started", """{"item":{"type":"commandExecution"}}""")))
        assertEquals(true, shouldRefreshForEvent(event("run_item.completed")))
    }

    @Test
    fun notificationCreatedIsAttributedToItsChannel() {
        val fromPayload = ProductEvent("1", "notification.created", "other", Json.parseToJsonElement("""{"channelId":"c1"}""").jsonObject)
        val fromEntity = ProductEvent("2", "notification.created", "c2")
        assertEquals("c1", eventChannelId(fromPayload))
        assertEquals("c2", eventChannelId(fromEntity))
        assertEquals(null, eventChannelId(ProductEvent("3", "run.started", "run-1")))
    }
}
