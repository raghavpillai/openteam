package com.openteam.platform

import android.content.Intent
import android.content.Context
import android.net.Uri
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.util.Locale

data class AppLinkTarget(
    val server: String?, val botId: String?, val channelId: String?, val messageId: String?,
    val action: String? = null, val identifier: String? = null,
)

object AndroidAppLinks {
    fun parse(uri: Uri, configuredHost: String? = null): AppLinkTarget? {
        if (uri.scheme != "https" && uri.scheme != "openteam") return null
        if ((uri.scheme == "https" || uri.scheme == "http") && normalizeHost(uri.host) != normalizeHost(configuredHost)) return null
        if (uri.scheme == "openteam" && (uri.host == "chat" || uri.pathSegments.firstOrNull() == "chat")) {
            val channel = (if (uri.host == "chat") uri.pathSegments.firstOrNull() else uri.pathSegments.getOrNull(1))
                ?.takeIf(String::isNotBlank)
            if (channel != null) return AppLinkTarget(null, null, channel, uri.getQueryParameter("message"))
        }
        val bot = uri.getQueryParameter("bot") ?: uri.pathSegments.dropWhile { it != "bots" }.getOrNull(1)
        val channel = uri.getQueryParameter("channel") ?: uri.pathSegments.dropWhile { it != "channels" }.getOrNull(1)
        val message = uri.getQueryParameter("message")
        val action = if (uri.host == "app") {
            listOf("app").plus(uri.pathSegments).joinToString("/")
        } else if (uri.pathSegments.firstOrNull() == "app") {
            uri.pathSegments.joinToString("/")
        } else null
        val identifier = uri.getQueryParameter("id")
        if (bot == null && channel == null && message == null && action == null && identifier == null) return null
        return AppLinkTarget(uri.getQueryParameter("server"), bot, channel, message, action, identifier)
    }

    fun normalizeHost(raw: String?): String? {
        val host = raw?.trim()?.lowercase(Locale.ROOT)?.removeSuffix(".") ?: return null
        if (host.length > 253 || host.isEmpty() || host == "localhost" || host.endsWith(".local")) return null
        val labels = host.split('.')
        if (labels.size < 2 || labels.any { it.isEmpty() || it.length > 63 || !Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$").matches(it) }) return null
        return host
    }
}

object AndroidAppLinkConfiguration {
    private const val HOST_METADATA = "com.openteam.android.APP_LINK_HOST"

    fun host(context: Context): String? = runCatching {
        val info = context.packageManager.getApplicationInfo(context.packageName, android.content.pm.PackageManager.GET_META_DATA)
        AndroidAppLinks.normalizeHost(info.metaData?.getString(HOST_METADATA))
    }.getOrNull()
}

data class SharePayload(
    val text: String?,
    val stream: Uri?,
    val mimeType: String?,
    val streams: List<Uri> = stream?.let { listOf(it) } ?: emptyList(),
)

object AndroidSharesheet {
    fun read(intent: Intent): SharePayload? {
        if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return null
        val streams = if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
            val clipStreams = intent.clipData?.let { clip -> (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri } }.orEmpty()
            if (clipStreams.isNotEmpty()) clipStreams else {
                @Suppress("DEPRECATION")
                intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
            }
        } else {
            listOfNotNull(intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM) ?: intent.clipData?.getItemAt(0)?.uri)
        }
        val stream = streams.firstOrNull()
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)
        if (stream == null && text.isNullOrBlank()) return null
        return SharePayload(text, stream, intent.type, streams)
    }

    fun chooser(contextIntent: Intent, title: CharSequence = "Share with OpenTeam"): Intent =
        Intent.createChooser(contextIntent, title)
}

data class ShortcutTarget(val botId: String, val recordVoice: Boolean = false)

object AndroidShortcuts {
    const val ACTION_RECORD_VOICE = "com.openteam.android.action.RECORD_VOICE"
    const val EXTRA_BOT_ID = "botId"

    fun target(intent: Intent): ShortcutTarget? {
        if (intent.action != ACTION_RECORD_VOICE) return null
        val botId = intent.getStringExtra(EXTRA_BOT_ID)?.takeIf { it.isNotBlank() } ?: return null
        return ShortcutTarget(botId, recordVoice = true)
    }

    fun appActionIntent(botId: String): Intent = Intent(ACTION_RECORD_VOICE).putExtra(EXTRA_BOT_ID, botId)
}

data class SearchableItem(val id: String, val title: String, val subtitle: String, val content: String, val deepLink: Uri)

interface AndroidSearchIndex {
    suspend fun index(items: List<SearchableItem>)
    suspend fun remove(ids: List<String>)
    suspend fun clear()
}

class SearchIndexRegistry(private val index: AndroidSearchIndex) {
    private val items = linkedMapOf<String, SearchableItem>()
    suspend fun replace(values: List<SearchableItem>) {
        val next = values.associateBy { it.id }
        index.remove(items.keys.subtract(next.keys).toList())
        index.index(next.values.toList())
        items.clear()
        items.putAll(next)
    }
    suspend fun clear() { index.clear(); items.clear() }
}

/**
 * Account-scoped fallback used when device AppSearch is unavailable. It only
 * indexes the currently signed-in account and is cleared by the owner on sign-out.
 */
class AccountScopedSearchFallback(private val accountKey: String) : AndroidSearchIndex {
    private val items = linkedMapOf<String, SearchableItem>()

    override suspend fun index(items: List<SearchableItem>) {
        this.items.putAll(items.associateBy { it.id })
    }

    override suspend fun remove(ids: List<String>) {
        ids.forEach(items::remove)
    }

    override suspend fun clear() {
        items.clear()
    }

    fun query(value: String): List<SearchableItem> {
        val query = value.trim().lowercase()
        if (query.isEmpty()) return emptyList()
        return items.values.filter { item ->
            listOf(item.title, item.subtitle, item.content).any { it.contains(query, ignoreCase = true) }
        }
    }

    fun ownerKey(): String = accountKey
}

/** Durable account-scoped index used by system search when AppSearch is unavailable. */
class AndroidPersistentSearchIndex(context: Context) {
    private val helper = object : SQLiteOpenHelper(context.applicationContext, "openteam-search.db", null, 1) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL("CREATE TABLE items (account TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, subtitle TEXT NOT NULL, content TEXT NOT NULL, deep_link TEXT NOT NULL, PRIMARY KEY(account, id))")
            db.execSQL("CREATE INDEX items_search ON items(account, title, subtitle, content)")
        }
        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
            db.execSQL("DROP TABLE IF EXISTS items")
            onCreate(db)
        }
    }

    fun replace(accountKey: String, values: List<SearchableItem>) {
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            db.delete("items", "account = ?", arrayOf(accountKey))
            values.forEach { item ->
                db.execSQL(
                    "INSERT OR REPLACE INTO items(account,id,title,subtitle,content,deep_link) VALUES(?,?,?,?,?,?)",
                    arrayOf(accountKey, item.id, item.title, item.subtitle, item.content, item.deepLink.toString()),
                )
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun clear(accountKey: String) {
        helper.writableDatabase.delete("items", "account = ?", arrayOf(accountKey))
    }

    fun query(accountKey: String, query: String): List<SearchableItem> {
        val term = query.trim()
        if (term.isEmpty()) return emptyList()
        val result = mutableListOf<SearchableItem>()
        helper.readableDatabase.query(
            "items",
            arrayOf("id", "title", "subtitle", "content", "deep_link"),
            "account = ? AND (title LIKE ? OR subtitle LIKE ? OR content LIKE ?)",
            arrayOf(accountKey, "%$term%", "%$term%", "%$term%"),
            null,
            null,
            "title COLLATE NOCASE",
            "50",
        ).use { cursor ->
            while (cursor.moveToNext()) {
                result += SearchableItem(
                    cursor.getString(0), cursor.getString(1), cursor.getString(2), cursor.getString(3), Uri.parse(cursor.getString(4)),
                )
            }
        }
        return result
    }
}
