package com.openteam.android.navigation

import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

data class ChatTarget(val conversationId: String, val messageId: String? = null)

object DeepLinkRouter {
    fun parse(raw: String?): ChatTarget? {
        val uri = raw?.let { runCatching { URI(it) }.getOrNull() } ?: return null
        if (uri.scheme != "openteam") return null
        val segments = buildList {
            uri.host?.let(::add)
            addAll(uri.path.orEmpty().split('/').filter(String::isNotBlank))
        }
        val chatIndex = segments.indexOfFirst { it in setOf("chat", "conversation", "channel") }
        val conversationId = segments.getOrNull(chatIndex + 1)?.takeIf(String::isNotBlank) ?: return null
        val message = uri.rawQuery.orEmpty().split('&').firstNotNullOfOrNull { pair ->
            val parts = pair.split('=', limit = 2)
            if (parts.firstOrNull() == "message") {
                runCatching { URLDecoder.decode(parts.getOrElse(1) { "" }, StandardCharsets.UTF_8) }.getOrNull()
            } else null
        }
        return ChatTarget(conversationId, message?.takeIf(String::isNotBlank))
    }
}
