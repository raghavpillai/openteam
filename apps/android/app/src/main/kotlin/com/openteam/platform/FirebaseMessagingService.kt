package com.openteam.platform

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
        val expectedScope = getSharedPreferences(
            AndroidNotificationStorage.PREFERENCES,
            MODE_PRIVATE,
        ).getString(AndroidNotificationStorage.SCOPE, null).orEmpty()
        if (!notification.isForScope(expectedScope)) return
        NotificationChannels(this).create()
        val tap = AndroidNotificationTapIntent.create(this, com.openteam.android.MainActivity::class.java, notification)
        AndroidNotificationPresenter(this).show(notification, tap)
    }

    override fun onNewToken(token: String) {
        getSharedPreferences(AndroidNotificationStorage.PREFERENCES, MODE_PRIVATE)
            .edit()
            .putString(AndroidNotificationStorage.TOKEN, token)
            .apply()
        FcmPlatformRuntime.callbacks?.onToken(token)
    }
}
