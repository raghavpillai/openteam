package com.openteam.android.data

import com.openteam.mobile.core.mobileJson
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class MobileDataTest {
    @Test
    fun pendingSendRoundTripsThroughOutboxJson() {
        val sends = listOf(
            PendingSend(
                id = "client-1",
                channelId = "channel-1",
                content = "hello",
                attachments = listOf(MessageAttachment("asset-1", "a.png", "image/png", 3L, "image")),
                failure = null,
            ),
        )

        val encoded = mobileJson.encodeToString(sends)

        assertEquals(sends, mobileJson.decodeFromString<List<PendingSend>>(encoded))
    }

    @Test
    fun pendingSendKeepsReplyTargetAndDecodesOldEntriesWithoutOne() {
        val reply = PendingSend("c-1", "channel-1", "hi", replyToMessageId = "message-9")
        assertEquals(reply, mobileJson.decodeFromString<PendingSend>(mobileJson.encodeToString(reply)))

        val legacy = """{"id":"c-2","channelId":"channel-1","content":"hi"}"""
        assertNull(mobileJson.decodeFromString<PendingSend>(legacy).replyToMessageId)
    }

    @Test
    fun automationChangedEventBecomesARoutineEvent() {
        val message = ChatMessage(
            "event-1", "System", "",
            metadata = buildJsonObject {
                put("type", "event")
                put("event", buildJsonObject {
                    put("type", "automation-changed")
                    put("action", "created")
                    put("automationId", "routine-1")
                    put("automationName", "Daily backup")
                })
            },
        )

        assertEquals(RoutineEvent("routine-1", "Daily backup", "created"), message.routineEvent)
        assertEquals("New routine “Daily backup”", message.displayBody)
        assertTrue(message.routineEvent!!.canOpen)
    }

    @Test
    fun deletedRoutineEventCannotBeOpenedAndUnknownActionsAreIgnored() {
        fun event(action: String) = ChatMessage(
            "event-2", "System", "",
            metadata = buildJsonObject {
                put("type", "event")
                put("event", buildJsonObject {
                    put("type", "automation-changed")
                    put("action", action)
                    put("automationId", "routine-1")
                    put("automationName", "Daily backup")
                })
            },
        )

        assertEquals(false, event("deleted").routineEvent!!.canOpen)
        assertNull(event("exploded").routineEvent)
    }

    @Test
    fun deletingSectionMovesConversationsToUnassigned() {
        val preferences = SidebarPreferences(
            sections = listOf(SidebarSection("work", "Work", collapsed = true)),
            sectionByChannel = mapOf("channel-1" to "work"),
            channelOrderByGroup = mapOf("work" to listOf("channel-1")),
            unassignedCollapsed = true,
        )

        val result = preferences.deleteSection("work")

        assertEquals(emptyList<SidebarSection>(), result.sections)
        assertFalse(result.sectionByChannel.containsKey("channel-1"))
        assertFalse(result.channelOrderByGroup.containsKey("work"))
        assertFalse(result.unassignedCollapsed)
    }
}
