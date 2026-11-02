package com.openteam.android.qa

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ParityFixtureTest {
    @Test
    fun fixtureIsSyntheticAndStable() {
        val fixture = ParityFixtures.conversation

        assertEquals("qa-conversation", fixture.id)
        assertEquals("QA conversation", fixture.title)
        assertEquals(2, fixture.messages.size)
        assertTrue(fixture.messages.all { it.contains("synthetic") })
        assertFalse(ParityFixtures.server.contains("@"))
        assertFalse(ParityFixtures.credential.contains("secret", ignoreCase = true))
    }
}
