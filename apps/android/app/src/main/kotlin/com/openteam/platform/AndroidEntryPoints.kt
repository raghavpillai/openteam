package com.openteam.platform

import android.content.Intent
import android.content.Context
import android.net.Uri
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import androidx.appsearch.app.AppSearchSchema
import androidx.appsearch.app.AppSearchSession
import androidx.appsearch.app.GenericDocument
import androidx.appsearch.app.PutDocumentsRequest
import androidx.appsearch.app.SearchSpec
import androidx.appsearch.app.SetSchemaRequest
import androidx.appsearch.localstorage.LocalStorage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.security.MessageDigest
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

data class ShortcutTarget(
    val botId: String? = null,
    val recordVoice: Boolean = false,
    val conversationId: String? = null,
    val routineId: String? = null,
    val query: String? = null,
    val action: String? = null,
)

object AndroidShortcuts {
    const val ACTION_RECORD_VOICE = "com.openteam.android.action.RECORD_VOICE"
    const val ACTION_OPEN_CONVERSATION = "com.openteam.android.action.OPEN_CONVERSATION"
    const val ACTION_OPEN_BOT = "com.openteam.android.action.OPEN_BOT"
    const val ACTION_SEND_BOT_TASK = "com.openteam.android.action.SEND_BOT_TASK"
    const val ACTION_FIND_MESSAGES = "com.openteam.android.action.FIND_MESSAGES"
    const val ACTION_RUN_ROUTINE = "com.openteam.android.action.RUN_ROUTINE"
    const val EXTRA_BOT_ID = "botId"

    fun target(intent: Intent): ShortcutTarget? {
        return when (intent.action) {
            ACTION_RECORD_VOICE -> ShortcutTarget(
                botId = intent.getStringExtra(EXTRA_BOT_ID)?.takeIf(String::isNotBlank),
                recordVoice = true,
            )
            ACTION_OPEN_CONVERSATION -> ShortcutTarget(
                conversationId = intent.getStringExtra(EXTRA_CONVERSATION_ID)?.takeIf(String::isNotBlank),
                action = ACTION_OPEN_CONVERSATION,
            )
            ACTION_OPEN_BOT -> ShortcutTarget(
                botId = intent.getStringExtra(EXTRA_BOT_ID)?.takeIf(String::isNotBlank),
                action = ACTION_OPEN_BOT,
            )
            ACTION_SEND_BOT_TASK -> ShortcutTarget(
                botId = intent.getStringExtra(EXTRA_BOT_ID)?.takeIf(String::isNotBlank),
                action = ACTION_SEND_BOT_TASK,
            )
            ACTION_FIND_MESSAGES -> ShortcutTarget(
                query = intent.getStringExtra(EXTRA_QUERY),
                action = ACTION_FIND_MESSAGES,
            )
            ACTION_RUN_ROUTINE -> ShortcutTarget(
                routineId = intent.getStringExtra(EXTRA_ROUTINE_ID)?.takeIf(String::isNotBlank),
                action = ACTION_RUN_ROUTINE,
            )
            else -> null
        }
    }

    fun appActionIntent(botId: String): Intent = Intent(ACTION_RECORD_VOICE).putExtra(EXTRA_BOT_ID, botId)

    fun openConversationIntent(context: Context, conversationId: String): Intent =
        Intent(context, com.openteam.android.MainActivity::class.java)
            .setAction(ACTION_OPEN_CONVERSATION)
            .putExtra(EXTRA_CONVERSATION_ID, conversationId)

    fun sendBotTaskIntent(context: Context, botId: String): Intent =
        Intent(context, com.openteam.android.MainActivity::class.java)
            .setAction(ACTION_SEND_BOT_TASK)
            .putExtra(EXTRA_BOT_ID, botId)

    fun openBotIntent(context: Context, botId: String): Intent =
        Intent(context, com.openteam.android.MainActivity::class.java)
            .setAction(ACTION_OPEN_BOT)
            .putExtra(EXTRA_BOT_ID, botId)

    fun findMessagesIntent(context: Context): Intent =
        Intent(context, com.openteam.android.MainActivity::class.java).setAction(ACTION_FIND_MESSAGES)

    fun runRoutineIntent(context: Context, routineId: String): Intent =
        Intent(context, com.openteam.android.MainActivity::class.java)
            .setAction(ACTION_RUN_ROUTINE)
            .putExtra(EXTRA_ROUTINE_ID, routineId)

    private const val EXTRA_CONVERSATION_ID = "conversationId"
    private const val EXTRA_ROUTINE_ID = "routineId"
    private const val EXTRA_QUERY = "query"
}

class AndroidLauncherShortcuts(private val context: Context) {
    private val manager: ShortcutManager? = context.getSystemService(ShortcutManager::class.java)

    fun publish(conversations: List<com.openteam.android.data.Conversation>, routines: List<com.openteam.features.Routine>) {
        val shortcuts = buildList {
            conversations.filter { it.isBot }.take(3).forEach { conversation ->
                val botId = conversation.botId ?: return@forEach
                add(
                    ShortcutInfo.Builder(context, "bot:$botId")
                        .setShortLabel(conversation.title.take(25))
                        .setLongLabel("Send a task to ${conversation.title}".take(80))
                        .setIcon(Icon.createWithResource(context, com.openteam.android.R.mipmap.ic_launcher))
                        .setIntent(AndroidShortcuts.sendBotTaskIntent(context, botId))
                        .build(),
                )
            }
            conversations.filter { it.isBot }.take(2).forEach { conversation ->
                val botId = conversation.botId ?: return@forEach
                add(
                    ShortcutInfo.Builder(context, "open-bot:$botId")
                        .setShortLabel("Open ${conversation.title}".take(25))
                        .setIcon(Icon.createWithResource(context, com.openteam.android.R.mipmap.ic_launcher))
                        .setIntent(AndroidShortcuts.openBotIntent(context, botId))
                        .build(),
                )
            }
            conversations.take(3).forEach { conversation ->
                add(
                    ShortcutInfo.Builder(context, "conversation:${conversation.id}")
                        .setShortLabel(conversation.title.take(25))
                        .setLongLabel("Open ${conversation.title}".take(80))
                        .setIcon(Icon.createWithResource(context, com.openteam.android.R.mipmap.ic_launcher))
                        .setIntent(AndroidShortcuts.openConversationIntent(context, conversation.id))
                        .build(),
                )
            }
            add(
                ShortcutInfo.Builder(context, "find-messages")
                    .setShortLabel("Find messages")
                    .setIcon(Icon.createWithResource(context, com.openteam.android.R.mipmap.ic_launcher))
                    .setIntent(AndroidShortcuts.findMessagesIntent(context))
                    .build(),
            )
            routines.take(2).forEach { routine ->
                add(
                    ShortcutInfo.Builder(context, "routine:${routine.id}")
                        .setShortLabel("Run ${routine.name}".take(25))
                        .setIcon(Icon.createWithResource(context, com.openteam.android.R.mipmap.ic_launcher))
                        .setIntent(AndroidShortcuts.runRoutineIntent(context, routine.id))
                        .build(),
                )
            }
        }
        manager?.setDynamicShortcuts(shortcuts.take(manager.maxShortcutCountPerActivity))
    }

    fun clear() {
        manager?.removeAllDynamicShortcuts()
    }
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

/** Publishes the active account's searchable projection to Android AppSearch. */
class AndroidAppSearchIndex(context: Context) {
    private val appContext = context.applicationContext

    suspend fun replace(accountKey: String, values: List<SearchableItem>) = withContext(Dispatchers.IO) {
        withSession { session ->
            ensureSchema(session)
            val namespace = namespace(accountKey)
            session.removeAsync("", SearchSpec.Builder().addFilterNamespaces(namespace).build()).get()
            put(session, namespace, values)
        }
    }

    suspend fun upsert(accountKey: String, values: List<SearchableItem>) = withContext(Dispatchers.IO) {
        withSession { session ->
            ensureSchema(session)
            put(session, namespace(accountKey), values)
        }
    }

    suspend fun clear(accountKey: String) = withContext(Dispatchers.IO) {
        withSession { session ->
            ensureSchema(session)
            session.removeAsync("", SearchSpec.Builder().addFilterNamespaces(namespace(accountKey)).build()).get()
        }
    }

    private fun ensureSchema(session: AppSearchSession) {
        session.setSchemaAsync(
            SetSchemaRequest.Builder()
                .addSchemas(
                    listOf(
                    AppSearchSchema.Builder(SCHEMA)
                        .addProperty(AppSearchSchema.StringPropertyConfig.Builder("title").setCardinality(AppSearchSchema.PropertyConfig.CARDINALITY_OPTIONAL).setIndexingType(AppSearchSchema.StringPropertyConfig.INDEXING_TYPE_PREFIXES).build())
                        .addProperty(AppSearchSchema.StringPropertyConfig.Builder("subtitle").setCardinality(AppSearchSchema.PropertyConfig.CARDINALITY_OPTIONAL).setIndexingType(AppSearchSchema.StringPropertyConfig.INDEXING_TYPE_PREFIXES).build())
                        .addProperty(AppSearchSchema.StringPropertyConfig.Builder("content").setCardinality(AppSearchSchema.PropertyConfig.CARDINALITY_OPTIONAL).setIndexingType(AppSearchSchema.StringPropertyConfig.INDEXING_TYPE_PREFIXES).build())
                        .addProperty(AppSearchSchema.StringPropertyConfig.Builder("deepLink").setCardinality(AppSearchSchema.PropertyConfig.CARDINALITY_REQUIRED).setIndexingType(AppSearchSchema.StringPropertyConfig.INDEXING_TYPE_NONE).build())
                        .build(),
                    ),
                )
                .setSchemaTypeDisplayedBySystem(SCHEMA, true)
                .build(),
        ).get()
    }

    private fun put(session: AppSearchSession, namespace: String, values: List<SearchableItem>) {
        if (values.isEmpty()) return
        val request = PutDocumentsRequest.Builder().apply {
            values.forEach { item ->
                addGenericDocument(
                    GenericDocument.Builder(namespace, item.id, SCHEMA)
                        .setPropertyString("title", item.title)
                        .setPropertyString("subtitle", item.subtitle)
                        .setPropertyString("content", item.content)
                        .setPropertyString("deepLink", item.deepLink.toString())
                        .build(),
                )
            }
        }.build()
        session.putAsync(request).get()
    }

    private fun <T> withSession(block: (AppSearchSession) -> T): T {
        val session = LocalStorage.createSearchSessionAsync(
            LocalStorage.SearchContext.Builder(appContext)
                .setDatabaseName("openteam")
                .build(),
        ).get()
        return try {
            block(session)
        } finally {
            session.close()
        }
    }

    private fun namespace(accountKey: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(accountKey.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    private companion object {
        const val SCHEMA = "OpenTeamSearchItem"
    }
}
