package com.openteam.android.ui

import com.openteam.android.data.Conversation
import com.openteam.android.data.SidebarPreferences
import com.openteam.android.data.SidebarSection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DirectoryGroupingTest {
    private fun conversation(id: String, updatedAt: String? = null, subtitle: String = "") =
        Conversation(id = id, title = id, subtitle = subtitle, updatedAt = updatedAt)

    @Test
    fun pinnedConversationsAppearOnlyInTheTopRowInPinOrder() {
        val rows = listOf(
            conversation("a", "2026-01-01T00:00:00Z"),
            conversation("b", "2026-01-02T00:00:00Z"),
            conversation("c", "2026-01-03T00:00:00Z"),
        )
        val sidebar = SidebarPreferences(
            pinnedIds = listOf("c", "a"),
            sections = listOf(SidebarSection("s1", "Work")),
            sectionByChannel = mapOf("c" to "s1", "b" to "s1"),
        )
        val grouped = groupConversations(rows, sidebar)

        assertEquals(listOf("c", "a"), grouped.pinned.map(Conversation::id))
        // Pinned ids are removed from every section; only "b" remains in Work.
        assertEquals(listOf("b"), grouped.sections.single().conversations.map(Conversation::id))
        assertTrue(grouped.unassigned.isEmpty())
    }

    @Test
    fun sectionsWithOnlyPinnedConversationsAreHidden() {
        val rows = listOf(conversation("duoduo"))
        val sidebar = SidebarPreferences(
            pinnedIds = listOf("duoduo"),
            sections = listOf(SidebarSection("supervisor", "Supervisor Group")),
            sectionByChannel = mapOf("duoduo" to "supervisor"),
        )

        val grouped = groupConversations(rows, sidebar)

        assertEquals(listOf("duoduo"), grouped.pinned.map(Conversation::id))
        assertTrue(grouped.sections.isEmpty())
        assertFalse(grouped.showUnassignedHeading)
    }

    @Test
    fun unassignedHoldsRowsWithNoExistingSectionAndHeadingsShowOnlyWithSections() {
        val rows = listOf(conversation("a"), conversation("b"))
        val legacyAssignment = SidebarPreferences(
            sections = listOf(SidebarSection("s1", "Work")),
            sectionByChannel = mapOf("a" to "missing-section"),
        )
        val grouped = groupConversations(rows, legacyAssignment)
        assertEquals(listOf("a", "b"), grouped.unassigned.map(Conversation::id))
        assertTrue(grouped.showUnassignedHeading)

        val flat = groupConversations(rows, SidebarPreferences())
        assertFalse(flat.showUnassignedHeading)
        assertEquals(listOf("a", "b"), flat.unassigned.map(Conversation::id))
    }

    @Test
    fun explicitGroupOrderWinsOverRecencyThenFallsBackToRecency() {
        val rows = listOf(
            conversation("a", "2026-01-01T00:00:00Z"),
            conversation("b", "2026-01-05T00:00:00Z"),
            conversation("c", "2026-01-03T00:00:00Z"),
        )
        val sidebar = SidebarPreferences(
            sections = listOf(SidebarSection("s1", "Work")),
            sectionByChannel = mapOf("a" to "s1", "b" to "s1", "c" to "s1"),
            channelOrderByGroup = mapOf("s1" to listOf("c")),
        )
        val ordered = groupConversations(rows, sidebar).sections.single().conversations.map(Conversation::id)
        // "c" is pinned to the front by the saved order; the rest fall back to newest first.
        assertEquals(listOf("c", "b", "a"), ordered)
    }

    @Test
    fun conversationPreviewFallsBackToSubtitle() {
        assertEquals("latest", Conversation("a", "A", "desc", latestPreview = "latest").preview)
        assertEquals("desc", Conversation("a", "A", "desc").preview)
        assertTrue(Conversation("a", "A", "").preview == null)
    }

    @Test
    fun sidebarPreferenceMutationsMatchClientContract() {
        val base = SidebarPreferences(sections = listOf(SidebarSection("s1", "Work", collapsed = false)))
        assertEquals(listOf("a"), base.togglePin("a").pinnedIds)
        assertTrue(base.togglePin("a").togglePin("a").pinnedIds.isEmpty())
        assertEquals("s1", base.moveToSection("a", "s1").sectionIdFor("a"))
        assertTrue(base.moveToSection("a", "s1").moveToSection("a", null).sectionByChannel.isEmpty())
        assertTrue(base.toggleSection("s1").sections.single().collapsed)
        assertTrue(base.toggleSection(null).unassignedCollapsed)
    }
}
