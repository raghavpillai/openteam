package com.openteam.android.data

import com.openteam.features.Attachment
import com.openteam.features.Reaction
import com.openteam.features.RichMessage
import com.openteam.features.RichMessageBlock
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatProjectionTest {
    @Test
    fun chatMessageRetainsRichMetadataAssetsReactionsAndContext() {
        val message = ChatMessage(
            id = "message-1",
            author = "Orbit",
            body = "Choose a path",
            channelId = "channel-1",
            sequence = "90071992547409931234",
            metadata = kotlinx.serialization.json.buildJsonObject { put("type", "widget") },
            richMessage = RichMessage("message-1", listOf(RichMessageBlock.Markdown("Choose a path"))),
            attachments = listOf(Attachment("asset-1", "plan.pdf", "application/pdf", 42, kind = "pdf")),
            reactions = listOf(Reaction("👍", 2, selected = true)),
            replyToMessageId = "message-0",
            threadId = "thread-1",
            contextMessageId = "message-0",
        )

        assertEquals("90071992547409931234", message.sequence)
        assertEquals("asset-1", message.attachments.single().id)
        assertEquals(2, message.reactions.single().count)
        assertTrue(message.richMessage?.blocks?.single() is RichMessageBlock.Markdown)
        assertEquals("message-0", message.replyToMessageId)
        assertEquals("thread-1", message.threadId)
        assertEquals("widget", message.metadata["type"]?.toString()?.trim('"'))
        assertEquals("Choose a path", message.displayBody)
    }

    @Test
    fun historyContextIsBoundedAndMalformedMetadataGetsAReadableFallback() {
        val context = (0..25).map { index -> ChatMessage("context-$index", "Bot", "Context $index", sequence = index.toString()) }
        val page = ChatHistoryPage(
            messages = listOf(ChatMessage("message-1", "Bot", "Current", sequence = "26")),
            threadContext = context,
            threadContextTruncated = true,
        )
        assertEquals(20, page.boundedThreadContext().size)
        assertEquals("context-0", page.boundedThreadContext().first().id)
        assertEquals(listOf("context-24", "context-25", "message-1"), page.mergeAroundAnchor(emptyList(), limit = 3).map(ChatMessage::id))
        assertEquals("Unsupported message content", ChatMessage("bad", "Bot", "", metadata = kotlinx.serialization.json.buildJsonObject { put("type", "unknown") }).displayBody)
    }
}
