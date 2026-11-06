package com.openteam.mobile.core

/** Implement with Keychain/Keystore; implementations must never log session tokens. */
interface SecureSessionStore {
    suspend fun read(accountKey: String): Session?
    suspend fun write(accountKey: String, session: Session)
    suspend fun clear(accountKey: String)
}

/** Shared code receives time from the host to keep deterministic tests and native parity. */
interface MobileClock {
    fun nowUtc(): String
}

/** Persistence remains an adapter so common code has no database or OS dependency. */
interface MobileStateStore {
    suspend fun readCursor(accountKey: String): ClientCursor?
    suspend fun writeCursor(cursor: ClientCursor)

    suspend fun readDelivery(accountKey: String, clientId: String): DeliveryRecord? = null
    suspend fun writeDelivery(accountKey: String, record: DeliveryRecord) = Unit
}
