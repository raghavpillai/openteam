package com.openteam.android.qa

/** Synthetic, account-free data used by Android parity checks. */
data class ParityConversationFixture(
    val id: String,
    val title: String,
    val messages: List<String>,
)

object ParityFixtures {
    val conversation = ParityConversationFixture(
        id = "qa-conversation",
        title = "QA conversation",
        messages = listOf(
            "A synthetic incoming message",
            "A synthetic reply with a stable client ID",
        ),
    )

    const val server = "https://qa.invalid.example"
    const val account = "qa-user"
    const val credential = "qa-input"
}
