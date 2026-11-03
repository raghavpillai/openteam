package com.openteam.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class MobileDataTest {
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
