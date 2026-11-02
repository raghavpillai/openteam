package com.openteam.android.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.openteam.mobile.core.MobileRequest
import com.openteam.mobile.core.MobileResponse
import com.openteam.mobile.core.HttpMethod
import com.openteam.mobile.core.OpenTeamTransport
import com.openteam.mobile.core.SecureSessionStore
import com.openteam.mobile.core.Session
import com.openteam.mobile.core.mobileJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import java.security.MessageDigest
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import java.util.Locale

/** Keystore-backed session persistence for the shared repository boundary. */
class AndroidSecureSessionStore(context: Context) : SecureSessionStore {
    private val preferences = encryptedPreferences(context, "mobile-sessions")

    override suspend fun read(accountKey: String): Session? =
        preferences.getString(accountKey, null)?.let { runCatching { mobileJson.decodeFromString<Session>(it) }.getOrNull() }

    override suspend fun write(accountKey: String, session: Session) {
        preferences.edit()
            .putString(accountKey, mobileJson.encodeToString(session))
            .putString(ACTIVE_ACCOUNT_KEY, accountKey)
            .apply()
    }

    override suspend fun clear(accountKey: String) {
        preferences.edit().also { edit ->
            edit.remove(accountKey)
            if (preferences.getString(ACTIVE_ACCOUNT_KEY, null) == accountKey) edit.remove(ACTIVE_ACCOUNT_KEY)
        }.apply()
    }

    suspend fun readActive(): Session? {
        val accountKey = preferences.getString(ACTIVE_ACCOUNT_KEY, null) ?: return null
        return read(accountKey)
    }

    companion object {
        private const val ACTIVE_ACCOUNT_KEY = "__active_account_key__"
    }
}

/** Encrypted, account-scoped cursor and delivery persistence for shared sync. */
class AndroidMobileStateStore(context: Context) : com.openteam.mobile.core.MobileStateStore {
    private val preferences = encryptedPreferences(context, "mobile-sync-state")

    override suspend fun readCursor(accountKey: String): com.openteam.mobile.core.ClientCursor? =
        preferences.getString(cursorKey(accountKey), null)
            ?.let { runCatching { mobileJson.decodeFromString<com.openteam.mobile.core.ClientCursor>(it) }.getOrNull() }

    override suspend fun writeCursor(cursor: com.openteam.mobile.core.ClientCursor) {
        preferences.edit()
            .putString(cursorKey(cursor.accountKey), mobileJson.encodeToString(cursor))
            .apply()
    }

    override suspend fun readDelivery(
        accountKey: String,
        clientId: String,
    ): com.openteam.mobile.core.DeliveryRecord? =
        preferences.getString(deliveryKey(accountKey, clientId), null)
            ?.let { runCatching { mobileJson.decodeFromString<com.openteam.mobile.core.DeliveryRecord>(it) }.getOrNull() }

    override suspend fun writeDelivery(
        accountKey: String,
        record: com.openteam.mobile.core.DeliveryRecord,
    ) {
        preferences.edit()
            .putString(deliveryKey(accountKey, record.clientId), mobileJson.encodeToString(record))
            .apply()
    }

    private fun cursorKey(accountKey: String) = "cursor:${digest(accountKey)}"
    private fun deliveryKey(accountKey: String, clientId: String) =
        "delivery:${digest("$accountKey|$clientId")}"

    private fun digest(value: String): String =
        MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
}

/** Android owns socket, redirect, and timeout policy; the shared core owns request semantics. */
class AndroidOpenTeamTransport : OpenTeamTransport {
    override suspend fun execute(server: String, token: String?, request: MobileRequest): MobileResponse =
        withContext(Dispatchers.IO) {
            val normalizedServer = normalizeServer(server)
            val base = URI(normalizedServer)
            require(
                base.scheme in setOf("http", "https") && !base.host.isNullOrBlank() &&
                    base.rawUserInfo == null && base.rawQuery == null && base.rawFragment == null
            ) {
                "Use a server address with HTTP or HTTPS only; remove credentials, query, or fragment."
            }
            val connection = URI(normalizedServer.trimEnd('/') + request.path).toURL().openConnection() as HttpURLConnection
            try {
                connection.instanceFollowRedirects = false
                connection.connectTimeout = 15_000
                connection.readTimeout = 35_000
                connection.requestMethod = request.method.name
                connection.setRequestProperty("Accept", "application/json")
                token?.takeIf(String::isNotBlank)?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
                request.headers.forEach(connection::setRequestProperty)
                request.body?.let { body ->
                    connection.doOutput = true
                    if (request.headers.keys.none { it.equals("Content-Type", ignoreCase = true) }) {
                        connection.setRequestProperty("Content-Type", "application/json")
                    }
                    connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }
                val status = connection.responseCode
                val input = if (status in 200..299) connection.inputStream else connection.errorStream
                val body = input?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
                val headers = connection.headerFields
                    .filterKeys { it != null }
                    .mapKeys { it.key.lowercase() }
                    .mapValues { it.value.joinToString(",") }
                MobileResponse(status, headers, body)
            } finally {
                connection.disconnect()
            }
        }

    suspend fun upload(
        server: String,
        token: String?,
        path: String,
        contentType: String,
        fileName: String? = null,
        body: ByteArray,
    ): MobileResponse = withContext(Dispatchers.IO) {
        val normalizedServer = normalizeServer(server)
        val base = URI(normalizedServer)
        require(
            base.scheme in setOf("http", "https") && !base.host.isNullOrBlank() &&
                base.rawUserInfo == null && base.rawQuery == null && base.rawFragment == null
        ) {
            "Use a server address with HTTP or HTTPS only; remove credentials, query, or fragment."
        }
        val connection = URI(normalizedServer.trimEnd('/') + path).toURL()
            .openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15_000
            connection.readTimeout = 35_000
            connection.requestMethod = HttpMethod.POST.name
            connection.doOutput = true
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Content-Type", contentType)
            fileName?.takeIf(String::isNotBlank)?.let {
                connection.setRequestProperty("X-File-Name", URLEncoder.encode(it, Charsets.UTF_8.name()))
            }
            token?.takeIf(String::isNotBlank)
                ?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
            connection.outputStream.use { it.write(body) }
            val status = connection.responseCode
            val input = if (status in 200..299) connection.inputStream else connection.errorStream
            val responseBody = input?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            val headers = connection.headerFields
                .filterKeys { it != null }
                .mapKeys { it.key.lowercase() }
                .mapValues { it.value.joinToString(",") }
            MobileResponse(status, headers, responseBody)
        } finally {
            connection.disconnect()
        }
    }

    suspend fun download(
        server: String,
        token: String?,
        path: String,
    ): DownloadResponse = withContext(Dispatchers.IO) {
        val normalizedServer = normalizeServer(server)
        val base = URI(normalizedServer)
        require(
            base.scheme in setOf("http", "https") && !base.host.isNullOrBlank() &&
                base.rawUserInfo == null && base.rawQuery == null && base.rawFragment == null
        ) { "Use a server address with HTTP or HTTPS only; remove credentials, query, or fragment." }
        val connection = URI(normalizedServer.trimEnd('/') + path).toURL().openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15_000
            connection.readTimeout = 35_000
            connection.requestMethod = HttpMethod.GET.name
            connection.setRequestProperty("Accept", "*/*")
            token?.takeIf(String::isNotBlank)?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
            val status = connection.responseCode
            val input = if (status in 200..299) connection.inputStream else connection.errorStream
            val bytes = input?.use { it.readBytes() } ?: byteArrayOf()
            val headers = connection.headerFields
                .filterKeys { it != null }
                .mapKeys { it.key.lowercase() }
                .mapValues { it.value.joinToString(",") }
            DownloadResponse(status, headers, bytes)
        } finally {
            connection.disconnect()
        }
    }

    data class DownloadResponse(
        val status: Int,
        val headers: Map<String, String> = emptyMap(),
        val bodyBytes: ByteArray = byteArrayOf(),
    ) {
        fun requireSuccess(): DownloadResponse {
            require(status in 200..299) { "Attachment download failed ($status)" }
            return this
        }
    }
}

internal fun normalizeServer(raw: String): String {
    val value = raw.trim()
    if (value.isEmpty() || Regex("^[A-Za-z][A-Za-z0-9+.-]*://").containsMatchIn(value)) return value
    val authority = value.substringBefore('/').substringBefore('?').substringBefore('#')
    val host = authority.substringBefore(':').lowercase(Locale.ROOT)
    val localHost = host == "localhost" || host.endsWith(".local") || !host.contains('.') ||
        host.matches(Regex("^\\d{1,3}(?:\\.\\d{1,3}){3}$"))
    val hasNonTlsPort = authority.substringAfter(':', "").takeIf { ':' in authority }
        ?.toIntOrNull()?.let { it != 443 } == true
    return (if (localHost || hasNonTlsPort) "http://" else "https://") + value
}

private fun encryptedPreferences(context: Context, name: String) = EncryptedSharedPreferences.create(
    context,
    name,
    MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
)
