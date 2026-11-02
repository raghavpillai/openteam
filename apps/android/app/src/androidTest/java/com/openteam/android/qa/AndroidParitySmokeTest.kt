package com.openteam.android.qa

import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.openteam.android.MainActivity
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Small, deterministic UI checks corresponding to the iOS MessageParity and
 * QAAudit schemes. Keep live-server and device-only checks in the QA plan.
 */
@RunWith(AndroidJUnit4::class)
class AndroidParitySmokeTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun signInSurfaceExposesAccessibleControls() {
        compose.onNodeWithTag("login-welcome-title").assertIsDisplayed()
        compose.onNodeWithTag("get-started").assertIsDisplayed().assertHasClickAction()
        compose.onNodeWithTag("preview-workspace").assertIsDisplayed().assertHasClickAction()
    }

    @Test
    fun primaryConversationFlowKeepsComposerAndDeliveryVisible() {
        compose.onNodeWithTag("preview-workspace").performClick()

        compose.onNodeWithTag("directory-title").assertIsDisplayed()
        compose.onNodeWithTag("conversation-bot-1").performClick()
        compose.onNodeWithText("Good morning. What are we making progress on today?").assertIsDisplayed()

        compose.onNodeWithTag("message-composer").performTextInput("A parity smoke message")
        compose.onNodeWithTag("send-message").assertHasClickAction().performClick()
        val messageTag = "message-row-${"A parity smoke message".hashCode()}"
        val statusTag = "delivery-status-${"A parity smoke message".hashCode()}"
        compose.waitUntil(timeoutMillis = 5_000) {
            compose.onAllNodesWithTag(messageTag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag(messageTag, useUnmergedTree = true).assertIsDisplayed()
        compose.waitUntil(timeoutMillis = 5_000) {
            compose.onAllNodesWithTag(statusTag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag(statusTag, useUnmergedTree = true).assertIsDisplayed()
    }
}
