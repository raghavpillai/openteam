package com.openteam.android.features

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.assertDoesNotExist
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.openteam.android.data.ChatMessage
import com.openteam.android.ui.ChatContextSummary
import com.openteam.features.MarkdownMessage
import com.openteam.features.RichMessage
import com.openteam.features.RichMessageBlock
import com.openteam.features.RichFormField
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class RichMessageRendererTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun formActionExposesValuesToTheSharedActionCallback() {
        val submitted = mutableListOf<Map<String, String>>()
        compose.setContent {
            com.openteam.features.RichMessageCardScreen(
                message = RichMessage(
                    id = "message-1",
                    blocks = listOf(RichMessageBlock.Form("Profile", listOf(RichFormField("name", "Name")), com.openteam.features.RichMessageAction("submit", "Submit"))),
                ),
                onAction = { _, values -> submitted += values },
            )
        }

        compose.onNodeWithText("Name").assertExists()
        compose.onNodeWithText("Submit").performClick()

        assertEquals(1, submitted.size)
        assertEquals(null, submitted.single()["name"])
    }

    @Test
    fun widgetActionExposesSelectedValueToTheSharedActionCallback() {
        val submitted = mutableListOf<Map<String, String>>()
        compose.setContent {
            com.openteam.features.RichMessageCardScreen(
                message = RichMessage(
                    id = "message-2",
                    blocks = listOf(RichMessageBlock.Widget("Choose", listOf(com.openteam.features.RichWidgetOption("One", "one")))),
                ),
                onAction = { _, values -> submitted += values },
            )
        }

        compose.onNodeWithText("One").performClick()
        compose.onNodeWithText("Submit").performClick()

        assertEquals(1, submitted.size)
        assertEquals("one", submitted.last()["value"])
    }

    @Test
    fun threadContextRendererShowsBoundedAnchorContextAndTruncation() {
        compose.setContent {
            ChatContextSummary(
                messages = listOf(ChatMessage("context-1", "Orbit", "Earlier reply")),
                truncated = true,
            )
        }

        compose.onNodeWithTag("thread-context").assertExists()
        compose.onNodeWithTag("thread-context-title").assertExists()
        compose.onNodeWithTag("thread-context-truncated").assertExists()
        compose.onNodeWithText("Earlier reply").assertExists()
    }

    @Test
    fun markdownRendererStylesCommonBlocksWithoutShowingSyntaxMarkers() {
        compose.setContent {
            MarkdownMessage("# Heading\n\n- **First item**\n- `inline code`")
        }

        compose.onNodeWithText("Heading").assertExists()
        compose.onNodeWithText("First item").assertExists()
        compose.onNodeWithText("inline code", substring = true).assertExists()
        compose.onNodeWithText("# Heading", substring = true).assertDoesNotExist()
    }

    @Test
    fun markdownRendererRendersPipeTableAsAlignedCells() {
        compose.setContent {
            MarkdownMessage(
                "| Order | Amount |\n| :--- | ---: |\n| 2610210023 | 316.66 |",
            )
        }

        compose.onNodeWithText("Order").assertExists()
        compose.onNodeWithText("Amount").assertExists()
        compose.onNodeWithText("2610210023").assertExists()
        compose.onNodeWithText("316.66").assertExists()
        compose.onNodeWithText("| Order | Amount |", substring = true).assertDoesNotExist()
    }
}
