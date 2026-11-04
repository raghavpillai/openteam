package com.openteam.platform

import android.content.ClipData
import android.content.Intent
import java.net.URI
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlatformAdaptersTest {
    @Test fun voiceDraftPreservesTypedText() {
        assertEquals("existing words spoken words", VoiceDraftComposer.merge("existing words ", " spoken words "))
        assertEquals("spoken words", VoiceDraftComposer.merge("", " spoken words "))
    }

    @Test fun vncGrantRejectsCrossOriginAndCredentialsInSocketUrl() {
        val grant = ComputerVncGrant(
            "/api/v0/bots/test-bot/screen/vnc", "one-use", listOf("openteam-vnc", "ticket." + "a".repeat(43)),
        )
        val uri = grant.socketUri(URI("https://example.test/team"), "test-bot")
        assertEquals("wss://example.test/team/api/v0/bots/test-bot/screen/vnc", uri.toString())
        assertFalse(uri.toString().contains("one-use"))
    }

    @Test fun vncGrantUsesPlainWebSocketForHttpServers() {
        val grant = ComputerVncGrant(
            "/api/v0/bots/test-bot/screen/vnc", "one-use", listOf("openteam-vnc", "ticket." + "a".repeat(43)),
        )
        assertEquals(
            "ws://192.168.1.20:8787/api/v0/bots/test-bot/screen/vnc",
            grant.socketUri(URI("http://192.168.1.20:8787"), "test-bot").toString(),
        )
    }

    @Test fun vncGrantParsesServerSessionPayload() {
        val grant = ComputerVncGrant.fromJson(Json.parseToJsonElement(
            """{"path":"/api/v0/bots/test-bot/screen/vnc","protocols":["openteam-vnc","ticket.${"a".repeat(43)}"],"password":"one-use"}"""
        ).jsonObject)
        assertEquals("/api/v0/bots/test-bot/screen/vnc", grant.path)
        assertEquals("one-use", grant.authToken)
        assertEquals(2, grant.protocols.size)
    }

    @Test fun vncOriginPolicyRejectsViewerOriginChanges() {
        val server = URI("https://example.test/team")
        VncOriginPolicy.validate(server, android.net.Uri.parse("https://example.test/viewer"))
        var rejected = false
        try {
            VncOriginPolicy.validate(server, android.net.Uri.parse("https://attacker.test/viewer"))
        } catch (_: IllegalArgumentException) {
            rejected = true
        }
        assertTrue(rejected)
    }

    @Test fun fcmPayloadAndReadLedgerUseIndependentMessageAndReactionCursors() {
        val ledger = NotificationReadLedger("a".repeat(64))
        ledger.merge(NotificationReadMarker("channel", "12", "8"))
        val message = FcmNotification.fromData(mapOf(
            "kind" to "message", "notificationScope" to "a".repeat(64), "channelId" to "channel", "messageSequence" to "12",
        ))
        val reaction = FcmNotification.fromData(mapOf(
            "kind" to "reaction", "notificationScope" to "a".repeat(64), "channelId" to "channel", "notificationSequence" to "9",
        ))
        assertTrue(ledger.hasRead(message))
        assertFalse(ledger.hasRead(reaction))
    }

    @Test fun appLinkAndShortcutTargetsAreAccountScopedByCaller() {
        val target = AndroidAppLinks.parse(android.net.Uri.parse("https://example.test/bots/bot-1?channel=channel-2&message=m-3"), "example.test")
        assertEquals("bot-1", target?.botId)
        assertEquals("channel-2", target?.channelId)
        val shortcut = AndroidShortcuts.target(AndroidShortcuts.appActionIntent("bot-1"))
        assertEquals(ShortcutTarget("bot-1", true), shortcut)
    }

    @Test fun launcherActionsPreserveTheirTargetIdentifiers() {
        val open = AndroidShortcuts.target(Intent(AndroidShortcuts.ACTION_OPEN_CONVERSATION).putExtra("conversationId", "channel-1"))
        assertEquals("channel-1", open?.conversationId)
        assertEquals(AndroidShortcuts.ACTION_OPEN_CONVERSATION, open?.action)

        val routine = AndroidShortcuts.target(Intent(AndroidShortcuts.ACTION_RUN_ROUTINE).putExtra("routineId", "routine-1"))
        assertEquals("routine-1", routine?.routineId)
        assertEquals(AndroidShortcuts.ACTION_RUN_ROUTINE, routine?.action)
    }

    @Test fun verifiedAppLinksRejectUnconfiguredHostsAndMalformedHostValues() {
        val uri = android.net.Uri.parse("https://other.example/bots/bot-1")
        assertEquals(null, AndroidAppLinks.parse(uri, "example.test"))
        assertEquals(null, AndroidAppLinks.normalizeHost("https://example.test/path"))
        assertEquals("example.test", AndroidAppLinks.normalizeHost("EXAMPLE.TEST."))
    }

    @Test fun notificationDeepLinksAndCustomChatLinksPreserveMessageAnchors() {
        val link = AndroidAppLinks.parse(android.net.Uri.parse("openteam://chat/channel-1?message=message-9"))
        assertEquals("channel-1", link?.channelId)
        assertEquals("message-9", link?.messageId)

        val notification = FcmNotification.fromData(mapOf(
            "kind" to "message",
            "notificationScope" to "scope",
            "channelId" to "channel-1",
            "messageSequence" to "42",
        ))
        assertEquals("openteam://chat/channel-1?message=42", notification.deepLinkUri().toString())
    }

    @Test fun notificationsRejectPayloadsFromAnotherAccountScope() {
        val notification = FcmNotification.fromData(mapOf(
            "kind" to "message",
            "notificationScope" to "current-scope",
            "channelId" to "channel-1",
            "messageSequence" to "42",
        ))
        assertTrue(notification.isForScope("current-scope"))
        assertFalse(notification.isForScope("other-scope"))
        assertFalse(notification.isForScope(""))
    }

    @Test fun multipleSharesKeepEveryStreamForAuthenticatedUploadHandoff() {
        val first = android.net.Uri.parse("content://share/one")
        val second = android.net.Uri.parse("content://share/two")
        val intent = Intent(Intent.ACTION_SEND_MULTIPLE).setType("text/plain").apply {
            clipData = ClipData.newUri(null, "one", first).also { it.addItem(ClipData.Item(second)) }
        }

        val payload = AndroidSharesheet.read(intent)

        assertEquals(listOf(first, second), payload?.streams)
    }

    @Test fun accountScopedSearchFallbackDoesNotReturnAnotherAccountData() = runBlocking {
        val index = AccountScopedSearchFallback("account-a")
        index.index(listOf(
            SearchableItem("a", "Project A", "", "alpha", android.net.Uri.parse("openteam://chat/a")),
            SearchableItem("b", "Project B", "", "beta", android.net.Uri.parse("openteam://chat/b")),
        ))

        assertEquals(listOf("a"), index.query("alpha").map(SearchableItem::id))
        assertEquals("account-a", index.ownerKey())
        index.clear()
        assertTrue(index.query("alpha").isEmpty())
    }

    @Test fun presenceControllerOrdersReleaseAfterHeartbeatCancellation() = runBlocking {
        val updates = mutableListOf<NotificationPresencePayload>()
        val transport = object : NotificationPresenceTransport {
            override suspend fun update(payload: NotificationPresencePayload): NotificationRouting {
                updates += payload
                return NotificationRouting(true, 0, 0, 0)
            }
        }
        val controller = NotificationPresenceController(transport, this, heartbeatMs = 60_000)
        controller.setActive(true)
        yield()
        controller.close()
        yield()
        assertTrue(updates.last().active.not())
        assertTrue(updates.zipWithNext().all { it.first.sequence < it.second.sequence })
    }
}
