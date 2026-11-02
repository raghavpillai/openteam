package com.openteam.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatHistoryPageTest {
    @Test
    fun mergeDeduplicatesAndKeepsSequenceOrder() {
        val existing = listOf(
            ChatMessage("2", "Bot", "Second", sequence = "2"),
            ChatMessage("3", "Bot", "Third", sequence = "3"),
        )
        val older = listOf(
            ChatMessage("1", "Bot", "First", sequence = "1"),
            ChatMessage("2", "Bot", "Updated second", sequence = "2"),
        )

        val merged = ChatHistoryPage.merge(existing, older)

        assertEquals(listOf("1", "2", "3"), merged.map(ChatMessage::id))
        assertEquals("Updated second", merged[1].body)
    }

    @Test
    fun pageCarriesOlderBoundary() {
        val page = ChatHistoryPage(
            beforeSequence = "40",
            hasMoreBefore = true,
        )

        assertTrue(page.hasMoreBefore)
        assertEquals("40", page.beforeSequence)
        assertFalse(page.hasMoreAfter)
    }
}
