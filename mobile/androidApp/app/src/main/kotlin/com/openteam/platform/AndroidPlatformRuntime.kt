package com.openteam.platform

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

data class AndroidPlatformIntent(
    val appLink: AppLinkTarget? = null,
    val share: SharePayload? = null,
    val shortcut: ShortcutTarget? = null,
)

/** Binds platform lifecycle and entry points without making the shell own transport details. */
class AndroidPlatformRuntime(
    private val context: Context,
    private val activityClass: Class<*>,
    private val onOpenDeepLink: (String) -> Unit,
    private val onShare: (SharePayload) -> Unit,
    private val onVoiceShortcut: (String) -> Unit,
    private val appLinkHost: String? = AndroidAppLinkConfiguration.host(context),
) : DefaultLifecycleObserver, FcmPlatformRuntime.Callbacks {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var presence: NotificationPresenceController? = null
    private var reads: NotificationReadController? = null
    private var session: PlatformSession? = null
    private var token: String? = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString(TOKEN, null)
    private var active = false

    init {
        NotificationChannels(context).create()
        FcmPlatformRuntime.callbacks = this
    }

    fun bindSession(server: String, bearerToken: String?, notificationScope: String) {
        if (session?.server == server && session?.bearerToken == bearerToken && session?.notificationScope == notificationScope) return
        presence?.close()
        session = PlatformSession(server, bearerToken, notificationScope)
        val current = session ?: return
        val presenceTransport = HttpNotificationPresenceTransport(current.server, current.bearerToken)
        presence = NotificationPresenceController(presenceTransport)
        reads = NotificationReadController(
            NotificationReadLedger(current.notificationScope),
            HttpNotificationReadTransport(current.server, current.bearerToken),
        )
        if (active) presence?.setActive(true)
        registerTokenIfAvailable()
    }

    fun clearSession() {
        presence?.close()
        presence = null
        reads = null
        session = null
    }

    fun close() {
        if (FcmPlatformRuntime.callbacks === this) FcmPlatformRuntime.callbacks = null
        clearSession()
        scope.cancel()
    }

    fun handle(intent: Intent?): AndroidPlatformIntent {
        val value = intent ?: return AndroidPlatformIntent()
        val share = AndroidSharesheet.read(value)
        if (share != null) onShare(share)
        val shortcut = AndroidShortcuts.target(value)
        shortcut?.let {
            if (it.recordVoice) onVoiceShortcut(it.botId)
            onOpenDeepLink("openteam://chat/${Uri.encode(it.botId)}")
        }
        val appLink = value.data?.let { AndroidAppLinks.parse(it, appLinkHost) }
        if (appLink != null) {
            val channel = appLink.channelId ?: appLink.botId
            if (channel != null) {
                val message = appLink.messageId?.let { "?message=${Uri.encode(it)}" }.orEmpty()
                onOpenDeepLink("openteam://chat/${Uri.encode(channel)}$message")
            }
        }
        return AndroidPlatformIntent(appLink, share, shortcut)
    }

    fun markRead(channelId: String, throughSequence: String?, throughNotificationSequence: String?) {
        reads?.let { controller ->
            scope.launch { controller.markRead(channelId, throughSequence, throughNotificationSequence) }
        }
    }

    override fun onStart(owner: LifecycleOwner) {
        active = true
        presence?.setActive(true)
    }

    override fun onStop(owner: LifecycleOwner) {
        active = false
        presence?.setActive(false)
    }

    override fun onMessage(data: Map<String, String>) {
        val current = session ?: return
        val ledger = reads?.ledger ?: NotificationReadLedger(current.notificationScope)
        val handler = FcmMessageHandler(
            AndroidNotificationPresenter(context), ledger, ::tapIntent,
        )
        handler.handle(data, foreground = active)
    }

    override fun onToken(token: String) {
        this.token = token
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putString(TOKEN, token).apply()
        registerTokenIfAvailable()
    }

    private fun registerTokenIfAvailable() {
        val current = session ?: return
        val token = token ?: return
        scope.launch {
            FcmRegistration(
                HttpPushDeviceRegistrar(current.server, current.bearerToken),
                AndroidInstallationIdStore(context).installationId,
            ).register(token, current.notificationScope)
        }
    }

    private fun tapIntent(notification: FcmNotification): PendingIntent {
        val intent = Intent(context, activityClass).setAction(Intent.ACTION_VIEW)
            .setData(notification.deepLinkUri())
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(
            context,
            notification.channelId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private data class PlatformSession(val server: String, val bearerToken: String?, val notificationScope: String)

    private companion object {
        const val PREFERENCES = "openteam-platform"
        const val TOKEN = "fcm-token"
    }
}
