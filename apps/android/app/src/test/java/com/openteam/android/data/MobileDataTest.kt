package com.openteam.android.data

import com.openteam.mobile.core.mobileJson
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import org.junit.Assert.assertNull
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
