package com.openteam.android.shell

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.openteam.android.MainActivity
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PrimaryWorkflowTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun signInDirectoryOpenChatAndSend() {
        compose.onNodeWithTag("preview-workspace").performClick()

        compose.onNodeWithTag("directory-title").assertIsDisplayed()
        compose.onNodeWithTag("conversation-bot-1").performClick()
        compose.onNodeWithText("Good morning. What are we making progress on today?").assertIsDisplayed()

        compose.onNodeWithTag("message-composer").performTextInput("A quick update")
        compose.onNodeWithTag("send-message").performClick()
        compose.onNodeWithTag("message-composer").assertIsDisplayed()
    }

    @Test
    fun draftSurvivesLeavingAndReopeningConversation() {
        compose.onNodeWithTag("preview-workspace").performClick()
        compose.onNodeWithTag("conversation-bot-1").performClick()
        compose.onNodeWithTag("message-composer").performTextInput("Keep this note")

        compose.onNodeWithTag("back-to-conversations").performClick()
        compose.onNodeWithTag("conversation-bot-1").performClick()
        compose.onNodeWithText("Keep this note").assertIsDisplayed()
    }
}
