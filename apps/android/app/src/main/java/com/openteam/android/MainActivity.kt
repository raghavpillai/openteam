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
import kotlinx.coroutines.flow.collect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.getValue

class MainActivity : ComponentActivity() {
    private val viewModel: AppViewModel by viewModels()
    private lateinit var platform: AndroidPlatformRuntime
    private var lastReadMarker: String? = null

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
                    val saved = AndroidSecureSessionStore(this@MainActivity).readActive()
                    if (state.session == null || saved == null) {
                        platform.clearSession()
                    } else {
                        platform.bindSession(saved.server, saved.token, notificationScope(saved.server, saved.userId))
                    }
                }
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
