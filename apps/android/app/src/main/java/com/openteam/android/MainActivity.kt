package com.openteam.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.openteam.android.ui.OpenTeamApp
import com.openteam.android.ui.OpenTeamTheme
import com.openteam.android.data.AndroidSecureSessionStore
import com.openteam.platform.AndroidPlatformRuntime
import java.security.MessageDigest
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.getValue

class MainActivity : ComponentActivity() {
    private val viewModel: AppViewModel by viewModels()
    private lateinit var platform: AndroidPlatformRuntime
    private var lastReadMarker: String? = null
    private var localUnreadSnapshot: Map<String, Int>? = null
    private var localNotificationSessionKey: String? = null
    private val sessionStore by lazy { AndroidSecureSessionStore(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        platform = AndroidPlatformRuntime(
            this,
            MainActivity::class.java,
            viewModel::acceptDeepLink,
            viewModel::acceptShare,
            viewModel::acceptVoiceShortcut,
        )
        lifecycle.addObserver(platform)
        platform.handle(intent)
        lifecycleScope.launch {
            repeatOnLifecycle(androidx.lifecycle.Lifecycle.State.STARTED) {
                launch {
                    viewModel.state.collect { state ->
                        platform.setActiveChannel(state.activeConversationId)
                        state.activeConversationId?.let { channelId ->
                            state.messages.lastOrNull()?.sequence?.takeIf(String::isNotBlank)?.let { sequence ->
                                val marker = "${state.session?.server}|$channelId|$sequence"
                                if (marker != lastReadMarker) {
                                    lastReadMarker = marker
                                    platform.markRead(channelId, sequence, null)
                                }
                            }
                        }
                    }
                }
                // Reading the Keystore-backed store is slow, so only rebind when the session
                // itself changes and keep the read off the main thread. Running it on every
                // state emission blocked frames during scrolling and navigation.
                viewModel.state.map { it.session }.distinctUntilChanged().collect { session ->
                    val saved = session?.let { withContext(Dispatchers.IO) { sessionStore.readActive() } }
                    if (session == null || saved == null) {
                        platform.clearSession()
                    } else {
                        platform.bindSession(saved.server, saved.token, notificationScope(saved.server, saved.userId))
                    }
                }
            }
        }
        lifecycleScope.launch {
            viewModel.state.collect { state ->
                if (state.session == null) {
                    localUnreadSnapshot = null
                    localNotificationSessionKey = null
                    return@collect
                }
                val sessionKey = "${state.session.server}|${state.session.accountName}"
                if (localNotificationSessionKey != sessionKey) {
                    localNotificationSessionKey = sessionKey
                    localUnreadSnapshot = null
                }
                val current = state.conversations.associate { it.id to it.unread }
                val previous = localUnreadSnapshot
                val notificationsEnabled = state.features.settings.notifications.messages ||
                    state.features.settings.notifications.mentions ||
                    state.features.settings.notifications.routineRuns
                if (previous != null && notificationsEnabled) {
                    state.conversations
                        .filter { it.id != state.activeConversationId && it.unread > (previous[it.id] ?: 0) }
                        .forEach { conversation ->
                            platform.showLocalNotification(
                                conversation.id,
                                conversation.title,
                                conversation.preview ?: "New activity",
                            )
                        }
                }
                localUnreadSnapshot = current
            }
        }
        setContent {
            val state by viewModel.state.collectAsStateWithLifecycle()
            OpenTeamTheme(state.features.settings.appearance, state.features.settings.accent) { OpenTeamApp(viewModel) }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        platform.handle(intent)
    }

    override fun onDestroy() {
        platform.close()
        super.onDestroy()
    }

    private fun notificationScope(server: String, userId: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest((server + "\n" + userId).toByteArray())
            .joinToString("") { "%02x".format(it) }
}
