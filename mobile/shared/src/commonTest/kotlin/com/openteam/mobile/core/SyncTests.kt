package com.openteam.mobile.core

import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class SyncTests {
    @Test
    fun parsesChunkedSseAndIgnoresNonProductEvents() {
        val parser = EventStreamParser()

        assertTrue(
            parser.append(
                "event: product\ndata: {\"sequence\":\"90071992547409931234\",\"topic\":\"message.created\",\"payload\":"
            ).isEmpty(),
        )
        val events = parser.append(
            "{} }\n\nevent: heartbeat\ndata: {}\n\n".replace("} }", "}}"),
        )

        assertEquals(1, events.size)
        assertEquals("90071992547409931234", events.single().sequence)
        assertEquals("message.created", events.single().topic)
    }

    @Test
    fun synchronizerPersistsCursorAfterApplyingAndDeduplicatesReplay() {
        val store = FakeStateStore()
        val api = FakeSyncApi(
            events = EventBatch(
                listOf(
                    ProductEvent("12", "second"),
                    ProductEvent("11", "first"),
                    ProductEvent("11", "first-replay"),
                ),
            ),
        )
        val applied = mutableListOf<String>()
        val synchronizer = EventSynchronizer(
            accountKey = "https://server|user",
            server = "https://server",
            token = "secret",
            store = store,
            api = api,
            clock = FixedClock,
            applyEvent = { applied += it.topic },
        )

        kotlinx.coroutines.test.runTest {
            assertEquals(2, synchronizer.pollOnce(waitMs = 0))
            assertEquals(listOf("first", "second"), applied)
            assertEquals("12", store.cursors["https://server|user"]?.sequence)
            assertEquals(0, synchronizer.pollOnce(waitMs = 0))
            assertEquals(listOf("first", "second"), applied)
        }
    }

    @Test
    fun pagerPreservesServerBoundaryAndStopsAtLastPage() {
        val api = FakeSyncApi(
            historyPages = ArrayDeque(
                listOf(
                    HistoryPage("channel", listOf(message("20")), beforeSequence = "19", hasMore = true),
                    HistoryPage("channel", listOf(message("19")), beforeSequence = null, hasMore = false),
                ),
            ),
        )
        val pager = HistoryPager("account", "server", null, "channel", api)

        kotlinx.coroutines.test.runTest {
            assertEquals("19", pager.next()?.beforeSequence)
            assertFalse(pager.isExhausted)
            assertEquals("19", pager.next()?.messages?.single()?.sequence)
            assertTrue(pager.isExhausted)
            assertEquals(null, pager.next())
        }
    }

    @Test
    fun deliveryJournalMarksUnknownThenReconcilesFromServer() {
        val store = FakeStateStore()
        val api = FakeSyncApi(
            sendFailure = OpenTeamRequestException(
                OpenTeamError(0, "offline", "offline", retryable = true),
            ),
            lookup = DeliveryLookup("client-1", "accepted", message = message("42")),
        )
        val journal = DeliveryJournal("account", "server", null, store, api, FixedClock)

        kotlinx.coroutines.test.runTest {
            assertEquals(DeliveryStatus.UNKNOWN, journal.send("channel", "hello", "client-1").status)
            assertEquals(DeliveryStatus.ACCEPTED, journal.reconcile("channel", "client-1").status)
            assertEquals("message-42", store.deliveries["client-1"]?.messageId)
        }
    }

    @Test
    fun reconnectDelayIsBounded() {
        val policy = ReconnectPolicy(maxAttempts = 4, initialDelayMs = 500, maxDelayMs = 1_500)

        assertEquals(0, policy.delayFor(0))
        assertEquals(500, policy.delayFor(1))
        assertEquals(1_000, policy.delayFor(2))
        assertEquals(1_500, policy.delayFor(3))
        assertEquals(1_500, policy.delayFor(10))
    }

    @Test
    fun unauthorizedPollNotifiesSessionRecoveryHook() {
        val store = FakeStateStore()
        val api = FakeSyncApi(
            pollFailure = OpenTeamRequestException(OpenTeamError(401, "unauthorized", "expired")),
        )
        var recovered = false
        val synchronizer = EventSynchronizer(
            "account",
            "server",
            "token",
            store,
            api,
            FixedClock,
            applyEvent = {},
            onUnauthorized = { recovered = true },
        )

        kotlinx.coroutines.test.runTest {
            assertFailsWith<OpenTeamRequestException> { synchronizer.pollOnce(0) }
            assertTrue(recovered)
        }
    }

    @Test
    fun synchronizerAcceptsSseEventsThroughTheSameDurableCursor() {
        val store = FakeStateStore()
        val api = FakeSyncApi()
        val applied = mutableListOf<String>()
        val synchronizer = EventSynchronizer(
            "account",
            "server",
            null,
            store,
            api,
            FixedClock,
            applyEvent = { applied += it.topic },
        )
        val parser = EventStreamParser()

        kotlinx.coroutines.test.runTest {
            assertEquals(
                1,
                synchronizer.acceptSseChunk(
                    parser,
                    "event: product\ndata: {\"sequence\":\"1\",\"topic\":\"created\",\"payload\":{}}\n\n",
                ),
            )
            assertEquals(0, synchronizer.acceptSseEnd(parser))
            assertEquals(listOf("created"), applied)
            assertEquals("1", store.cursors["account"]?.sequence)
        }
    }

    private fun message(sequence: String) = MobileMessage(
        id = "message-$sequence",
        sequence = sequence,
        channelId = "channel",
        sender = "user",
        content = sequence,
        metadata = JsonObject(emptyMap()),
        createdAt = "2026-01-01T00:00:00Z",
    )
}

private object FixedClock : MobileClock {
    override fun nowUtc() = "2026-01-01T00:00:00Z"
}

private class FakeStateStore : MobileStateStore {
    val cursors = mutableMapOf<String, ClientCursor>()
    val deliveries = mutableMapOf<String, DeliveryRecord>()

    override suspend fun readCursor(accountKey: String) = cursors[accountKey]
    override suspend fun writeCursor(cursor: ClientCursor) {
        cursors[cursor.accountKey] = cursor
    }

    override suspend fun readDelivery(accountKey: String, clientId: String) = deliveries[clientId]
    override suspend fun writeDelivery(accountKey: String, record: DeliveryRecord) {
        deliveries[record.clientId] = record
    }
}

private class FakeSyncApi(
    private val events: EventBatch = EventBatch(),
    private val historyPages: ArrayDeque<HistoryPage> = ArrayDeque(),
    private val pollFailure: Throwable? = null,
    private val sendFailure: Throwable? = null,
    private val lookup: DeliveryLookup = DeliveryLookup("client-1", "pending"),
) : MobileSyncApi {
    override suspend fun pollEvents(request: EventPollRequest): EventBatch {
        pollFailure?.let { throw it }
        return events
    }

    override suspend fun openEvents(server: String, token: String?, after: String) =
        MobileResponse(200, body = "")

    override suspend fun readHistory(
        server: String,
        token: String?,
        channelId: String,
        beforeSequence: String?,
        limit: Int,
    ) = historyPages.removeFirst()

    override suspend fun sendMessage(
        server: String,
        token: String?,
        channelId: String,
        content: String,
        clientId: String,
    ): MobileMessage {
        sendFailure?.let { throw it }
        return MobileMessage(clientId, clientId, "1", channelId, "user", content = content, createdAt = "")
    }

    override suspend fun lookupDelivery(
        server: String,
        token: String?,
        channelId: String,
        clientId: String,
    ) = lookup
}
