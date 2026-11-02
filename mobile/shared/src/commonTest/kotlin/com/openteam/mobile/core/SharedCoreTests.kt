package com.openteam.mobile.core

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SharedCoreTests {
    @Test
    fun decodesUnknownFieldsAndKeepsLargeSequenceAsString() {
        val event = mobileJson.decodeFromString<ProductEvent>(
            """{"sequence":"90071992547409931234","topic":"message.created","payload":{},"futureField":true}""",
        )

        assertEquals("90071992547409931234", event.sequence)
        assertEquals("message.created", event.topic)
    }

    @Test
    fun preservesStructuredServerError() {
        val error = assertFailsWith<OpenTeamRequestException> {
            MobileResponse(
                status = 409,
                body = """{"error":{"code":"delivery_unknown","message":"Check delivery","retryable":true,"requestId":"req-7"}}""",
            ).requireSuccess()
        }.error

        assertEquals(409, error.status)
        assertEquals("delivery_unknown", error.code)
        assertEquals("Check delivery", error.message)
        assertEquals(true, error.retryable)
        assertEquals("req-7", error.requestId)
    }

    @Test
    fun malformedErrorRetainsHttpStatusAndFallbackMessage() {
        val error = assertFailsWith<OpenTeamRequestException> {
            MobileResponse(status = 502, body = "not-json").requireSuccess()
        }.error

        assertEquals(502, error.status)
        assertEquals("Request failed (502)", error.message)
    }

    @Test
    fun sessionStringRepresentationRedactsToken() {
        val session = Session("https://example.test", "secret-token", "user-1", "now")

        assertFalse(session.toString().contains("secret-token"))
        assertTrue(session.toString().contains("<redacted>"))
    }

    @Test
    fun messageProjectionPreservesRichMetadataAndAttachments() {
        val message = mobileJson.decodeFromString<MobileMessage>(
            """
            {
              "id":"message-1",
              "clientId":"client-1",
              "sequence":"12",
              "channelId":"channel-1",
              "sender":"user",
              "content":"hello",
              "createdAt":"2026-01-01T00:00:00Z",
              "metadata":{
                "replyTo":"message-0",
                "attachments":[{
                  "assetId":"asset-1",
                  "fileName":"photo.png",
                  "mimeType":"image/png",
                  "byteSize":12,
                  "kind":"image"
                }],
                "reactions":{"thumbs-up":["user-1","user-2"]},
                "richText":{"format":"markdown"}
              }
            }
            """.trimIndent(),
        )

        val projection = message.toProjection()

        assertEquals("client-1", projection.clientId)
        assertTrue(projection.isMine)
        assertEquals("message-0", projection.replyToMessageId)
        assertEquals("asset-1", projection.attachments.single().assetId)
        assertEquals(listOf("user-1", "user-2"), projection.reactions["thumbs-up"])
        assertEquals("markdown", projection.richText?.get("format")?.toString()?.trim('"'))
    }
}
