package com.openteam.android.data

import org.junit.Assert.assertEquals
import org.junit.Test

class LiveMessagingApiContractTest {
    @Test
    fun legacyHistoryDefaultsToFirstPage() {
        val gateway: MobileGateway = PreviewMobileGateway()

        assertEquals(3, kotlinx.coroutines.runBlocking { gateway.historyPage("bot-1").messages.size })
    }
}
