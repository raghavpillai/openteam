package com.openteam.platform

import android.app.PendingIntent
import android.content.Intent
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Firebase is deliberately kept at this boundary. The shell supplies account-scoped
 * registration and notification routing; the service never persists or interprets a token.
 */
object FcmPlatformRuntime {
    interface Callbacks {
        fun onMessage(data: Map<String, String>)
        fun onToken(token: String)
    }

    @Volatile var callbacks: Callbacks? = null
}

class OpenTeamFirebaseMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val callbacks = FcmPlatformRuntime.callbacks
        if (callbacks != null) {
            callbacks.onMessage(message.data)
            return
        }
        val notification = FcmNotification.fromData(message.data)
        if (notification.scope.isEmpty()) return
        NotificationChannels(this).create()
        val intent = Intent(this, com.openteam.android.MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = notification.deepLinkUri()
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        val tap = PendingIntent.getActivity(this, notification.channelId.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        AndroidNotificationPresenter(this).show(notification, tap)
    }

    override fun onNewToken(token: String) {
        getSharedPreferences("openteam-platform", MODE_PRIVATE).edit().putString("fcm-token", token).apply()
        FcmPlatformRuntime.callbacks?.onToken(token)
    }
}
