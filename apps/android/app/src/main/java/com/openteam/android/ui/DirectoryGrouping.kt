package com.openteam.android.ui

import com.openteam.android.data.Conversation
import com.openteam.android.data.SidebarPreferences
import com.openteam.android.data.SidebarSection

/** One sidebar section together with the conversations shown under it. */
data class SectionGroup(
    val section: SidebarSection,
    val conversations: List<Conversation>,
)

/** The conversation list split into the pinned row, user sections, and the unassigned tail. */
data class DirectoryGrouping(
    val pinned: List<Conversation>,
    val sections: List<SectionGroup>,
    val unassigned: List<Conversation>,
    val showUnassignedHeading: Boolean,
)

/**
 * Splits conversations for the directory screen. A pinned conversation is shown only in
 * [pinned] (never repeated in a section), sections follow the stored order, and anything not
 * filed into an existing section lands in [unassigned].
 */
fun groupConversations(rows: List<Conversation>, sidebar: SidebarPreferences): DirectoryGrouping {
    val rowsById = rows.associateBy(Conversation::id)
    val pinnedIds = sidebar.pinnedIds.toSet()
    val sectionIds = sidebar.sections.map { it.id }.toSet()

    fun members(sectionId: String?): List<Conversation> {
        val candidates = rows.filter { row ->
            if (row.id in pinnedIds) return@filter false
            val assigned = sidebar.sectionByChannel[row.id]
            if (sectionId == null) {
                assigned == null || assigned !in sectionIds
            } else {
                assigned == sectionId
            }
        }
        val order = sidebar.channelOrderByGroup[sectionId ?: "unassigned"].orEmpty()
        return candidates.sortedWith(
            compareBy<Conversation> { candidate ->
                order.indexOf(candidate.id).let { index -> if (index < 0) Int.MAX_VALUE else index }
            }
                .thenByDescending { it.updatedAt.orEmpty() }
                .thenBy { it.id },
        )
    }

    val unassigned = members(null)
    val sections = sidebar.sections.mapNotNull { section ->
        members(section.id).takeIf { it.isNotEmpty() }?.let { SectionGroup(section, it) }
    }

    return DirectoryGrouping(
        pinned = sidebar.pinnedIds.mapNotNull(rowsById::get),
        sections = sections,
        unassigned = unassigned,
        showUnassignedHeading = sidebar.sections.isNotEmpty() && unassigned.isNotEmpty(),
    )
}
