package com.openteam.android.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** Drafts are scoped to a conversation and encrypted at rest on this device. */
class DraftStore(context: Context) {
    private val preferences = EncryptedSharedPreferences.create(
        context,
        "conversation-drafts",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun get(accountScope: String, conversationId: String): String =
        preferences.getString(key(accountScope, conversationId), "").orEmpty()

    fun put(accountScope: String, conversationId: String, value: String) {
        preferences.edit().putString(key(accountScope, conversationId), value).apply()
    }

    fun clearAccount(accountScope: String) {
        val prefix = "$accountScope|"
        preferences.edit().also { edit ->
            preferences.all.keys.filter { it.startsWith(prefix) }.forEach { key -> edit.remove(key) }
        }.apply()
    }

    private fun key(accountScope: String, conversationId: String) = "$accountScope|$conversationId"
}
