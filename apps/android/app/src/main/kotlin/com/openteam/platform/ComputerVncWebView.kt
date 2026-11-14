package com.openteam.platform

import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import java.net.URI
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlin.coroutines.resume
import org.json.JSONArray
import org.json.JSONObject

sealed interface VncRendererState {
    data object Detached : VncRendererState
    data object LoadingAsset : VncRendererState
    data object Ready : VncRendererState
    data object Connecting : VncRendererState
    data object Connected : VncRendererState
    data class Reconnecting(val reason: String) : VncRendererState
    data class Failed(val message: String) : VncRendererState
}

interface VncAssetLoader {
    fun load(webView: WebView)
}

class AndroidVncAssetLoader(
    private val context: Context,
    private val assetPath: String = "openteam-vnc/index.html",
) : VncAssetLoader {
    override fun load(webView: WebView) {
        val html = context.assets.open(assetPath).bufferedReader().use { it.readText() }
        // Use a synthetic HTTP document origin so Android WebView can open ws://
        // connections without treating them as mixed content. The server maps this
        // origin to the same opaque/native origin used by iOS and packaged desktop.
        webView.loadDataWithBaseURL("http://openteam-vnc.invalid/", html, "text/html", "UTF-8", null)
    }
}

interface VncClipboardBridge {
    fun read(): String
    fun write(value: String)
}

/** Android WebView/noVNC boundary. The noVNC bundle is supplied as an external asset. */
class AndroidVncWebViewRenderer(
    context: Context,
    private val assetLoader: VncAssetLoader = AndroidVncAssetLoader(context),
    private val clipboard: VncClipboardBridge = AndroidComputerClipboard(context),
) : VncTransport {
    private val _state = MutableStateFlow<VncRendererState>(VncRendererState.Detached)
    val state: StateFlow<VncRendererState> = _state.asStateFlow()
    private var webView: WebView? = null
    private var server: URI? = null
    private var assetReady = false
    private var pendingConnection: CompletableDeferred<Unit>? = null
    private val bridge = RendererBridge()

    fun attach(view: WebView) {
        detach()
        webView = view
        assetReady = false
        view.setBackgroundColor(Color.BLACK)
        view.settings.javaScriptEnabled = true
        view.settings.domStorageEnabled = true
        view.settings.allowFileAccess = false
        view.settings.allowContentAccess = false
        view.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        view.isVerticalScrollBarEnabled = false
        view.isHorizontalScrollBarEnabled = false
        view.addJavascriptInterface(bridge, "openTeamNative")
        view.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                if (webView === view && _state.value == VncRendererState.LoadingAsset) {
                    assetReady = true
                    _state.value = VncRendererState.Ready
                }
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: android.webkit.WebResourceError,
            ) {
                if (webView === view && request.isForMainFrame) {
                    onSocketError("The computer viewer could not be loaded: ${error.description}")
                }
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.url.scheme !in setOf("http", "https") || request.url.host != "openteam-vnc.invalid"
        }
        _state.value = VncRendererState.LoadingAsset
        runCatching { assetLoader.load(view) }
            .onFailure { _state.value = VncRendererState.Failed("The noVNC asset is unavailable: ${it.message}") }
    }

    fun detach() {
        pendingConnection?.cancel()
        pendingConnection = null
        webView?.removeJavascriptInterface("openTeamNative")
        webView?.stopLoading()
        webView = null
        server = null
        assetReady = false
        _state.value = VncRendererState.Detached
    }

    fun onResume() { webView?.onResume() }
    fun onPause() { webView?.onPause() }

    override suspend fun connect(grant: ComputerVncGrant, server: URI, botId: String) {
        grant.socketUri(server, botId)
        awaitReady()
        pendingConnection?.cancel()
        val connection = CompletableDeferred<Unit>()
        pendingConnection = connection
        this.server = server
        _state.value = VncRendererState.Connecting
        val session = JSONObject()
            .put("url", grant.socketUri(server, botId).toString())
            .put("protocols", JSONArray(grant.protocols))
            .put("password", grant.authToken)
        evaluate(
            """
            (() => {
              const viewer = window.openTeamVnc;
              if (!viewer?.connect) {
                window.openTeamNative?.failed?.("The computer viewer is unavailable");
                return true;
              }
              viewer.connect($session).catch(error => {
                window.openTeamNative?.failed?.(error?.message || "Computer connection failed");
              });
              return true;
            })()
            """.trimIndent(),
        )
        try {
            withTimeout(CONNECTION_TIMEOUT_MILLIS) { connection.await() }
        } catch (error: TimeoutCancellationException) {
            evaluate("window.openTeamVnc?.stop?.()")
            throw IllegalStateException("Computer connection timed out", error)
        } finally {
            if (pendingConnection === connection) pendingConnection = null
        }
    }

    override suspend fun send(input: ComputerInput) {
        check(_state.value == VncRendererState.Connected) { "The computer viewer is not connected" }
        val value = when (input) {
            is ComputerInput.Key -> JSONObject().put("type", "key").put("keys", input.keys)
            is ComputerInput.Text -> JSONObject().put("type", "text").put("text", input.text)
            is ComputerInput.Pointer -> JSONObject().put("type", "pointer").put("action", input.action)
                .put("x", input.x).put("y", input.y).put("buttons", input.buttons)
        }
        evaluate("window.openTeamVnc && window.openTeamVnc.input(${value});")
    }

    suspend fun setControl(active: Boolean) {
        evaluate("window.openTeamVnc && window.openTeamVnc.control(${active});")
    }

    override suspend fun stop() {
        pendingConnection?.cancel()
        pendingConnection = null
        evaluate("window.openTeamVnc && window.openTeamVnc.stop && window.openTeamVnc.stop();")
        server = null
        _state.value = if (webView == null) VncRendererState.Detached else VncRendererState.Ready
    }

    fun onSocketClosed(reason: String) {
        val error = IllegalStateException(reason.ifBlank { "Computer connection interrupted" })
        pendingConnection?.completeExceptionally(error)
        _state.value = VncRendererState.Reconnecting(error.message.orEmpty())
    }

    fun onSocketError(message: String) {
        val error = IllegalStateException(message.ifBlank { "Computer connection failed" })
        pendingConnection?.completeExceptionally(error)
        _state.value = VncRendererState.Failed(error.message.orEmpty())
    }

    fun prepareForReconnect() {
        if (webView != null && assetReady && _state.value is VncRendererState.Failed) {
            _state.value = VncRendererState.Ready
        }
    }

    fun validateViewerOrigin(origin: Uri?) {
        server?.let { VncOriginPolicy.validate(it, origin) }
    }

    private suspend fun awaitReady() {
        check(webView != null) { "The computer viewer is not attached" }
        when (val current = _state.value) {
            VncRendererState.Ready, is VncRendererState.Reconnecting -> return
            is VncRendererState.Failed -> throw IllegalStateException(current.message)
            else -> {
                val ready = state.first {
                    it == VncRendererState.Ready || it is VncRendererState.Reconnecting || it is VncRendererState.Failed
                }
                if (ready is VncRendererState.Failed) throw IllegalStateException(ready.message)
            }
        }
    }

    private suspend fun evaluate(script: String) {
        val view = webView ?: throw IllegalStateException("The computer viewer is not attached")
        withContext(Dispatchers.Main.immediate) {
            kotlinx.coroutines.suspendCancellableCoroutine<Unit> { continuation ->
                view.evaluateJavascript(script) {
                    if (continuation.isActive) continuation.resume(Unit)
                }
            }
        }
    }

    private inner class RendererBridge {
        @JavascriptInterface fun connected() {
            _state.value = VncRendererState.Connected
            pendingConnection?.complete(Unit)
        }
        @JavascriptInterface fun disconnected(reason: String?) { onSocketClosed(reason.orEmpty()) }
        @JavascriptInterface fun failed(message: String?) { onSocketError(message.orEmpty()) }
        @JavascriptInterface fun readClipboard(): String = clipboard.read()
        @JavascriptInterface fun writeClipboard(value: String?) { clipboard.write(value.orEmpty()) }
    }

    private companion object {
        const val CONNECTION_TIMEOUT_MILLIS = 15_000L
    }
}
