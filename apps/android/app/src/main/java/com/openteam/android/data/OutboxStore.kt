package com.openteam.android.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.openteam.mobile.core.mobileJson
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString

/** Durable, account-scoped user-message queue. Attachments are already uploaded before enqueueing. */
class OutboxStore(context: Context) {
    private val preferences = EncryptedSharedPreferences.create(
        context,
        "mobile-outbox",
        MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun read(accountKey: String): List<PendingSend> =
        preferences.getString(key(accountKey), null)
            ?.let { runCatching { mobileJson.decodeFromString<List<PendingSend>>(it) }.getOrNull() }
            .orEmpty()

    fun write(accountKey: String, sends: List<PendingSend>) {
        preferences.edit()
            .putString(key(accountKey), mobileJson.encodeToString(sends))
            .apply()
    }

    fun clear(accountKey: String) {
        preferences.edit().remove(key(accountKey)).apply()
    }

    private fun key(accountKey: String) = "outbox:$accountKey"
}
