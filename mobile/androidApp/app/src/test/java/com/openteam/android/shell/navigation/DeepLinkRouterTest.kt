package com.openteam.android.shell.navigation

import com.openteam.android.navigation.ChatTarget
import com.openteam.android.navigation.DeepLinkRouter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeepLinkRouterTest {
    @Test
    fun parsesConversationAndMessageContext() {
        assertEquals(
            ChatTarget("channel-42", "message-9"),
            DeepLinkRouter.parse("openteam://chat/channel-42?message=message-9"),
        )
    }

    @Test
    fun rejectsUnknownSchemesAndIncompleteTargets() {
        assertNull(DeepLinkRouter.parse("https://chat/channel-42"))
        assertNull(DeepLinkRouter.parse("openteam://chat"))
        assertNull(DeepLinkRouter.parse(null))
    }
}
