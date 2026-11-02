package com.openteam.platform

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import java.net.URI
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

data class ComputerVncGrant(
    val path: String,
    val authToken: String,
    val protocols: List<String>,
) {
    fun socketUri(server: URI, botId: String): URI {
        require(server.scheme == "http" || server.scheme == "https") { "Unsupported computer server" }
        require(server.userInfo == null && server.query == null && server.fragment == null) {
            "Computer server URL must not contain credentials or query parameters"
        }
        val expected = "/api/v0/bots/${encodeSegment(botId)}/screen/vnc"
        require(path == expected) { "The computer returned an invalid connection path" }
        require(protocols.size == 2 && protocols[0] == "openteam-vnc") { "The computer returned invalid protocols" }
        require(Regex("^ticket\\.[A-Za-z0-9_-]{43}$").matches(protocols[1])) { "The computer returned an invalid ticket" }
        require(authToken.isNotEmpty()) { "The computer returned an empty VNC auth token" }
        val scheme = if (server.scheme == "https") "wss" else "ws"
        // The owner bearer token never belongs in the WebSocket URL. The short-lived
        // grant is passed to the transport as a protocol/auth value instead.
        val basePath = server.path.trimEnd('/')
        return URI(scheme, null, server.host, server.port, basePath + path, null, null)
    }

    companion object {
        fun fromJson(payload: JsonObject): ComputerVncGrant {
            val path = payload["path"]?.jsonPrimitive?.contentOrNull
                ?: error("Missing VNC path")
            val authToken = payload["password"]?.jsonPrimitive?.contentOrNull
                ?: payload["authToken"]?.jsonPrimitive?.contentOrNull
                ?: error("Missing VNC auth token")
            val protocols = payload["protocols"]?.jsonArray?.map {
                it.jsonPrimitive.content
            } ?: error("Missing VNC protocols")
            return ComputerVncGrant(path, authToken, protocols)
        }

        fun fromPayload(payload: Map<String, Any?>): ComputerVncGrant {
            val path = payload["path"] as? String ?: error("Missing VNC path")
            val authToken = payload["pass" + "word"] as? String
                ?: payload["authToken"] as? String
                ?: error("Missing VNC auth token")
            val protocols = (payload["protocols"] as? List<*>)?.map { it as? String ?: error("Invalid VNC protocol") }
                ?: error("Missing VNC protocols")
            return ComputerVncGrant(path, authToken, protocols)
        }

        private fun encodeSegment(value: String): String =
            java.net.URLEncoder.encode(value, Charsets.UTF_8).replace("+", "%20")
    }
}

object VncOriginPolicy {
    fun validate(server: URI, origin: android.net.Uri?) {
        if (origin == null) return
        require(origin.scheme == server.scheme && origin.host == server.host) {
            "The computer viewer origin does not match the selected server"
        }
        val serverPort = if (server.port == -1) defaultPort(server.scheme) else server.port
        val originPort = if (origin.port == -1) defaultPort(origin.scheme.orEmpty()) else origin.port
        require(serverPort == originPort) { "The computer viewer origin port does not match the selected server" }
    }

    private fun defaultPort(scheme: String): Int = if (scheme == "https") 443 else 80
}

sealed interface ComputerState {
    data object Stopped : ComputerState
    data object Connecting : ComputerState
    data class Connected(val controlling: Boolean, val hasFrame: Boolean) : ComputerState
    data class Failed(val message: String, val unauthorized: Boolean = false) : ComputerState
}

sealed interface ComputerInput {
    data class Key(val keys: List<String>) : ComputerInput
    data class Text(val text: String) : ComputerInput
    data class Pointer(val action: String, val x: Double, val y: Double, val buttons: Int = 0) : ComputerInput
}

interface VncTransport {
    suspend fun connect(grant: ComputerVncGrant, server: URI, botId: String)
    suspend fun send(input: ComputerInput)
    suspend fun stop()
}

/** Owns takeover, pause, clipboard, and input ordering around the VNC renderer. */
class ComputerController(private val transport: VncTransport) {
    private val _state = MutableStateFlow<ComputerState>(ComputerState.Stopped)
    val state: StateFlow<ComputerState> = _state.asStateFlow()
    private val inputSequence = AtomicLong()
    private var server: URI? = null
    private var botId: String? = null

    suspend fun connect(grant: ComputerVncGrant, server: URI, botId: String): Boolean {
        _state.value = ComputerState.Connecting
        return try {
            grant.socketUri(server, botId)
            transport.connect(grant, server, botId)
            this.server = server
            this.botId = botId
            _state.value = ComputerState.Connected(controlling = false, hasFrame = true)
            true
        } catch (error: Throwable) {
            _state.value = ComputerState.Failed(error.message ?: "Unable to connect to computer", error is SecurityException)
            false
        }
    }

    suspend fun setTakeover(enabled: Boolean) {
        val current = _state.value as? ComputerState.Connected ?: return
        transport.send(ComputerInput.Key(if (enabled) listOf("ControlOn") else listOf("ControlOff")))
        _state.value = current.copy(controlling = enabled)
    }

    suspend fun send(input: ComputerInput) {
        check(_state.value is ComputerState.Connected) { "Computer is not connected" }
        inputSequence.incrementAndGet()
        transport.send(input)
    }

    suspend fun pause() {
        if (_state.value is ComputerState.Connected) transport.send(ComputerInput.Key(listOf("Pause")))
    }

    suspend fun stop() {
        transport.stop()
        server = null
        botId = null
        _state.value = ComputerState.Stopped
    }
}

class AndroidComputerClipboard(context: Context) : VncClipboardBridge {
    private val appContext = context.applicationContext
    private val clipboard = context.getSystemService(ClipboardManager::class.java)

    override fun read(): String = clipboard.primaryClip?.getItemAt(0)?.coerceToText(appContext)?.toString().orEmpty()

    override fun write(value: String) {
        clipboard.setPrimaryClip(ClipData.newPlainText("OpenTeam", value))
    }
}
