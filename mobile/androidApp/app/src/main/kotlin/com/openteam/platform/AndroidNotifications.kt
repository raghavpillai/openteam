package com.openteam.platform

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.withContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class FcmNotification(
    val kind: String,
    val scope: String,
    val channelId: String,
    val botId: String,
    val messageSequence: String?,
    val notificationSequence: String?,
    val threadMessageId: String?,
    val title: String,
    val body: String,
    val badgeCount: Int,
    val readStateJson: String?,
) {
    val isAlert: Boolean get() = kind == "message" || kind == "reaction"

    companion object {
        fun fromData(data: Map<String, String>): FcmNotification = FcmNotification(
            kind = data["kind"].orEmpty(), scope = data["notificationScope"].orEmpty(),
            channelId = data["channelId"].orEmpty(), botId = data["botId"].orEmpty(),
            messageSequence = data["messageSequence"], notificationSequence = data["notificationSequence"],
            threadMessageId = data["threadMessageId"], title = data["title"].orEmpty(),
            body = data["body"].orEmpty(), badgeCount = data["badgeCount"]?.toIntOrNull()?.coerceAtLeast(0) ?: 0,
            readStateJson = data["readState"],
        )
    }
}

fun FcmNotification.deepLinkUri(): Uri {
    val message = threadMessageId ?: messageSequence
    val query = message?.let { "?message=${Uri.encode(it)}" }.orEmpty()
    return Uri.parse("openteam://chat/${Uri.encode(channelId)}$query")
}

class NotificationChannels(context: Context) {
    companion object { const val AGENT = "agent"; const val REACTION = "reaction" }
    private val manager = context.getSystemService(NotificationManager::class.java)

    fun create() {
        manager.createNotificationChannels(listOf(
            NotificationChannel(AGENT, "Agent messages", NotificationManager.IMPORTANCE_HIGH),
            NotificationChannel(REACTION, "Reactions", NotificationManager.IMPORTANCE_DEFAULT),
        ))
    }
}

class AndroidNotificationPresenter(private val context: Context) {
    private val ids = AtomicInteger(1000)

    fun show(notification: FcmNotification, tapIntent: PendingIntent) {
        if (!notification.isAlert || notification.scope.isEmpty()) return
        val channel = if (notification.kind == "reaction") NotificationChannels.REACTION else NotificationChannels.AGENT
        val builder = NotificationCompat.Builder(context, channel)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(notification.title.ifEmpty { "OpenTeam" })
            .setContentText(notification.body)
            .setContentIntent(tapIntent)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setNumber(notification.badgeCount)
        NotificationManagerCompat.from(context).notify(notification.channelId.hashCode().coerceAtLeast(ids.incrementAndGet()), builder.build())
    }
}

interface PushDeviceRegistrar {
    suspend fun register(token: String, installationId: String, scope: String): Boolean
    suspend fun unregister(installationId: String): Boolean
}

class HttpPushDeviceRegistrar(
    private val baseUrl: String,
    private val bearerToken: String?,
) : PushDeviceRegistrar {
    override suspend fun register(token: String, installationId: String, scope: String): Boolean =
        request("POST", "/api/notification-devices", """
            {"installationId":"${jsonEscape(installationId)}","platform":"android","provider":"fcm","pushToken":"${jsonEscape(token)}","notificationScope":"${jsonEscape(scope)}"}
        """.trimIndent())

    override suspend fun unregister(installationId: String): Boolean =
        request("DELETE", "/api/notification-devices/${java.net.URLEncoder.encode(installationId, Charsets.UTF_8)}", null)

    private suspend fun request(method: String, path: String, body: String?): Boolean = withContext(Dispatchers.IO) {
        val connection = URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = 10_000
            connection.readTimeout = 10_000
            connection.setRequestProperty("Accept", "application/json")
            bearerToken?.takeIf { it.isNotBlank() }?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            connection.responseCode in 200..299
        } finally {
            connection.disconnect()
        }
    }

    private fun jsonEscape(value: String): String = buildString(value.length + 8) {
        value.forEach { char ->
            when (char) {
                '\\' -> append("\\\\")
                '"' -> append("\\\"")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> append(char)
            }
        }
    }
}

class HttpNotificationPresenceTransport(
    private val baseUrl: String,
    private val bearerToken: String?,
) : NotificationPresenceTransport {
    override suspend fun update(payload: NotificationPresencePayload): NotificationRouting {
        val response = PlatformHttp.request(baseUrl, bearerToken, "POST", "/api/notification-presence", """
            {"clientId":"${payload.clientId}","sequence":${payload.sequence},"platform":"android","active":${payload.active}}
        """.trimIndent())
        val json = org.json.JSONObject(response)
        return NotificationRouting(
            json.optBoolean("smartEnabled", true), json.optLong("serverTime"),
            json.optLong("iosActiveUntil"), json.optLong("macActiveUntil"),
        )
    }
}

class HttpNotificationReadTransport(
    private val baseUrl: String,
    private val bearerToken: String?,
) : NotificationReadTransport {
    override suspend fun markRead(channelId: String, throughSequence: String?, throughNotificationSequence: String?): Boolean {
        val body = buildString {
            append('{')
            throughSequence?.let { append("\"throughSequence\":\"$it\"") }
            if (throughSequence != null && throughNotificationSequence != null) append(',')
            throughNotificationSequence?.let { append("\"throughNotificationSequence\":\"$it\"") }
            append('}')
        }
        PlatformHttp.request(baseUrl, bearerToken, "POST", "/api/channels/${java.net.URLEncoder.encode(channelId, Charsets.UTF_8)}/read", body)
        return true
    }
}

private object PlatformHttp {
    suspend fun request(baseUrl: String, bearerToken: String?, method: String, path: String, body: String): String =
        kotlinx.coroutines.withContext(Dispatchers.IO) {
            val connection = java.net.URL(baseUrl.trimEnd('/') + path).openConnection() as java.net.HttpURLConnection
            try {
                connection.requestMethod = method
                connection.connectTimeout = 10_000
                connection.readTimeout = 10_000
                connection.setRequestProperty("Accept", "application/json")
                bearerToken?.takeIf { it.isNotBlank() }?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
                connection.setRequestProperty("Content-Type", "application/json")
                connection.doOutput = true
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                val status = connection.responseCode
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
                if (status !in 200..299) error("Platform request failed ($status)")
                text
            } finally {
                connection.disconnect()
            }
        }
}

class FcmRegistration(
    private val registrar: PushDeviceRegistrar,
    private val installationId: String = UUID.randomUUID().toString(),
) {
    suspend fun register(token: String, scope: String): Boolean =
        if (token.length < 20 || scope.length != 64 || !scope.matches(Regex("[a-fA-F0-9]{64}"))) false
        else registrar.register(token, installationId, scope)

    suspend fun unregister(): Boolean = registrar.unregister(installationId)
}

class AndroidInstallationIdStore(context: Context) {
    private val preferences = context.getSharedPreferences("openteam-platform", Context.MODE_PRIVATE)
    val installationId: String
        get() = preferences.getString("notification-installation-id", null) ?: UUID.randomUUID().toString().also {
            preferences.edit().putString("notification-installation-id", it).apply()
        }
}

interface NotificationPresenceTransport {
    suspend fun update(payload: NotificationPresencePayload): NotificationRouting
}

interface NotificationReadTransport {
    suspend fun markRead(channelId: String, throughSequence: String?, throughNotificationSequence: String?): Boolean
}

data class NotificationPresencePayload(
    val clientId: String,
    val sequence: Int,
    val active: Boolean,
    val idleSeconds: Int? = null,
    val platform: String = "android",
)

data class NotificationRouting(val smartEnabled: Boolean, val serverTime: Long, val iosActiveUntil: Long, val macActiveUntil: Long)

/** Android foreground presence uses the same lease protocol as iOS, with ordered heartbeats. */
class NotificationPresenceController(
    private val transport: NotificationPresenceTransport,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
    private val heartbeatMs: Long = 30_000,
) {
    private val clientId = UUID.randomUUID().toString()
    private var sequence = 0
    private var heartbeat: Job? = null

    fun setActive(active: Boolean) {
        sequence = (sequence + 1).coerceAtMost(Int.MAX_VALUE)
        heartbeat?.cancel()
        val current = sequence
        scope.launch { runCatching { transport.update(NotificationPresencePayload(clientId, current, active)) } }
        if (active) heartbeat = scope.launch {
            while (isActive) {
                delay(heartbeatMs)
                sequence = (sequence + 1).coerceAtMost(Int.MAX_VALUE)
                runCatching { transport.update(NotificationPresencePayload(clientId, sequence, true)) }
            }
        }
    }

    fun close() { setActive(false); heartbeat?.cancel() }
}

data class NotificationReadMarker(val channelId: String, val lastReadSequence: String, val lastReadNotificationSequence: String)

class NotificationReadLedger(private val scope: String) {
    private val markers = linkedMapOf<String, NotificationReadMarker>()

    fun merge(marker: NotificationReadMarker) {
        val old = markers[marker.channelId]
        markers[marker.channelId] = NotificationReadMarker(
            marker.channelId,
            maxSequence(old?.lastReadSequence, marker.lastReadSequence),
            maxSequence(old?.lastReadNotificationSequence, marker.lastReadNotificationSequence),
        )
    }

    fun hasRead(notification: FcmNotification): Boolean {
        if (notification.scope != scope || !notification.isAlert) return false
        val marker = markers[notification.channelId] ?: return false
        val value = if (notification.kind == "reaction") notification.notificationSequence else notification.messageSequence
        val read = if (notification.kind == "reaction") marker.lastReadNotificationSequence else marker.lastReadSequence
        return value != null && maxSequence(read, value) == read
    }

    fun snapshot(): List<NotificationReadMarker> = markers.values.toList()

    fun mergeSync(json: String?) {
        if (json.isNullOrBlank() || json == "null") return
        runCatching {
            val value = org.json.JSONObject(json)
            merge(NotificationReadMarker(
                value.optString("channelId"),
                value.optString("lastReadSequence", "0"),
                value.optString("lastReadNotificationSequence", "0"),
            ))
        }
    }

    private fun maxSequence(left: String?, right: String): String {
        val next = normalize(right) ?: return left ?: "0"
        val previous = left?.let(::normalize) ?: return next
        return when {
            previous.length != next.length -> if (previous.length > next.length) previous else next
            else -> maxOf(previous, next)
        }
    }

    private fun normalize(value: String): String? {
        if (value.isEmpty() || value.any { it !in '0'..'9' }) return null
        return value.dropWhile { it == '0' }.ifEmpty { "0" }
    }
}

class NotificationReadController(
    val ledger: NotificationReadLedger,
    private val transport: NotificationReadTransport,
) {
    suspend fun markRead(channelId: String, throughSequence: String?, throughNotificationSequence: String?): Boolean {
        if (throughSequence == null && throughNotificationSequence == null) return false
        ledger.merge(NotificationReadMarker(
            channelId,
            throughSequence ?: "0",
            throughNotificationSequence ?: "0",
        ))
        return transport.markRead(channelId, throughSequence, throughNotificationSequence)
    }
}

class FcmMessageHandler(
    private val presenter: AndroidNotificationPresenter,
    private val ledger: NotificationReadLedger,
    private val tapIntent: (FcmNotification) -> PendingIntent,
) {
    /** Returns false for stale, foreign-account, or foreground-read notifications. */
    fun handle(data: Map<String, String>, foreground: Boolean = false): Boolean {
        val notification = FcmNotification.fromData(data)
        if (notification.scope.isEmpty()) return false
        if (notification.kind == "badge-sync") {
            ledger.mergeSync(notification.readStateJson)
            return false
        }
        if (ledger.hasRead(notification)) return false
        if (foreground) return false
        if (notification.isAlert) presenter.show(notification, tapIntent(notification))
        return notification.isAlert
    }
}

/** Parses an FCM data payload without trusting notification text as routing state. */
fun Bundle.toFcmData(): Map<String, String> = keySet().associateWith { get(it)?.toString().orEmpty() }
