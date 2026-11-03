package com.openteam.android

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.openteam.android.data.ChatMessage
import com.openteam.android.data.ChatHistoryPage
import com.openteam.android.data.Conversation
import com.openteam.android.data.Delivery
import com.openteam.android.data.DraftStore
import com.openteam.android.data.HttpMobileGateway
import com.openteam.android.data.LiveMessagingApi
import com.openteam.android.data.MobileGateway
import com.openteam.android.data.MobileFeatureApi
import com.openteam.android.data.MessageAttachment
import com.openteam.android.data.MobileSession
import com.openteam.android.data.OutgoingShare
import com.openteam.android.data.OutboxStore
import com.openteam.android.data.PendingSend
import com.openteam.android.data.PreviewMobileGateway
import com.openteam.android.data.ServerValidationApi
import com.openteam.android.data.SidebarPreferences
import com.openteam.android.data.VoiceTranscriptionApi
import com.openteam.android.data.SearchResult
import com.openteam.android.data.newClientId
import com.openteam.android.navigation.ChatTarget
import com.openteam.android.navigation.DeepLinkRouter
import com.openteam.features.AccountMemoryState
import com.openteam.features.Attachment
import com.openteam.features.AppSettings
import com.openteam.features.FeatureGateway
import com.openteam.features.FeatureLoadState
import com.openteam.features.FeatureOperationState
import com.openteam.features.LiveFeatureGateway
import com.openteam.features.Plugin
import com.openteam.features.ProviderConnection
import com.openteam.features.Routine
import com.openteam.features.RoutineSchedule
import com.openteam.features.WebProvider
import com.openteam.features.WebProvidersState
import com.openteam.features.UnsupportedFeatureGateway
import com.openteam.platform.SharePayload
import com.openteam.platform.AndroidPersistentSearchIndex
import com.openteam.platform.AndroidAppSearchIndex
import com.openteam.platform.AndroidLauncherShortcuts
import com.openteam.platform.SearchableItem
import com.openteam.platform.AndroidVoiceCapture
import com.openteam.platform.ComputerVncGrant
import com.openteam.platform.VoiceRecordingController
import com.openteam.platform.VoiceRecordingState
import com.openteam.platform.VoiceTranscriber
import com.openteam.mobile.core.HttpMethod
import com.openteam.mobile.core.MobileMessage
import com.openteam.mobile.core.ProductEvent
import com.openteam.mobile.core.mobileJson
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.net.URI
import java.net.URLDecoder

data class AppState(
    val session: MobileSession? = null,
    val conversations: List<Conversation> = emptyList(),
    val hiddenConversations: List<Conversation> = emptyList(),
    val searchResults: List<SearchResult> = emptyList(),
    val searchLoading: Boolean = false,
    val searchError: String? = null,
    val sidebar: SidebarPreferences = SidebarPreferences(),
    val activeConversationId: String? = null,
    val activeMessageId: String? = null,
    val messages: List<ChatMessage> = emptyList(),
    val threadContext: List<ChatMessage> = emptyList(),
    val threadContextTruncated: Boolean = false,
    val historyBeforeSequence: String? = null,
    val hasMoreHistory: Boolean = false,
    val historyLoading: Boolean = false,
    val pendingAttachments: List<Attachment> = emptyList(),
    val draft: String = "",
    val error: String? = null,
    val loading: Boolean = false,
    val authChecking: Boolean = false,
    val validatedServer: String? = null,
    val pendingLink: ChatTarget? = null,
    val pendingVoiceShortcut: Boolean = false,
    val pendingShare: SharePayload? = null,
    val pendingExternalUrl: String? = null,
    val pendingSystemAction: String? = null,
    val pendingSystemIdentifier: String? = null,
    val pendingSystemPayload: String? = null,
    val pendingOutgoingShare: OutgoingShare? = null,
    val outbox: List<PendingSend> = emptyList(),
    val features: FeatureState = FeatureState(),
)

data class FeatureState(
    val routines: FeatureLoadState<List<Routine>> = FeatureLoadState.Loading,
    val account: FeatureLoadState<AccountMemoryState> = FeatureLoadState.Loading,
    val providers: FeatureLoadState<List<ProviderConnection>> = FeatureLoadState.Loading,
    val webProviders: FeatureLoadState<WebProvidersState> = FeatureLoadState.Loading,
    val plugins: FeatureLoadState<List<Plugin>> = FeatureLoadState.Loading,
    val settings: AppSettings = AppSettings(),
    val operation: FeatureOperationState = FeatureOperationState.Idle,
    val routineDraft: Routine? = null,
)

class AppViewModel @JvmOverloads constructor(
    application: Application,
    private val gateway: MobileGateway = HttpMobileGateway(application),
    private val previewGateway: MobileGateway = PreviewMobileGateway(),
    private val drafts: DraftStore = DraftStore(application),
    private val outboxStore: OutboxStore = OutboxStore(application),
    private val featureGateway: FeatureGateway? = null,
) : AndroidViewModel(application) {
    private val settingsPreferences = application.getSharedPreferences("openteam-settings", 0)
    private val systemSearch = AndroidPersistentSearchIndex(application)
    private val appSearch = AndroidAppSearchIndex(application)
    private val launcherShortcuts = AndroidLauncherShortcuts(application)
    private var activeGateway: MobileGateway = gateway
    private var activeFeatureGateway: FeatureGateway = featureGateway
        ?: (gateway as? MobileFeatureApi)?.let(::LiveFeatureGateway)
        ?: UnsupportedFeatureGateway
    private var searchGeneration = 0L
    private var syncJob: Job? = null
    private var outboxJob: Job? = null
    private var indexedAccount: String? = null
    private val mutableState = MutableStateFlow(AppState())
    val state: StateFlow<AppState> = mutableState.asStateFlow()
    private val voiceController = VoiceRecordingController(
        AndroidVoiceCapture(application),
        VoiceTranscriber { uri ->
            (activeGateway as? VoiceTranscriptionApi)?.transcribe(uri.toString())
                ?: error("Voice transcription is only available on a connected server.")
        },
        viewModelScope,
    )
    val voiceState: StateFlow<VoiceRecordingState> = voiceController.state

    init {
        viewModelScope.launch {
            runCatching { gateway.restoreSession() }.getOrNull()?.let { session ->
                activeGateway = gateway
                indexedAccount = accountScope(session)
                mutableState.update {
                    it.copy(session = session, outbox = outboxStore.read(accountScope(session)))
                }
                loadDirectory()
                loadFeatureData()
                startLiveSync()
                flushOutbox()
            }
        }
    }

    fun acceptDeepLink(raw: String?) {
        val actionUri = raw?.let { runCatching { URI(it) }.getOrNull() }
        if (actionUri?.scheme == "openteam" && actionUri.host == "action") {
            mutableState.update {
                it.copy(
                    pendingSystemAction = actionUri.path.orEmpty().trim('/').ifBlank { null },
                    pendingSystemIdentifier = actionUri.getQueryParameterCompat("id"),
                    pendingSystemPayload = actionUri.getQueryParameterCompat("text"),
                )
            }
            return
        }
        val target = DeepLinkRouter.parse(raw) ?: return
        mutableState.update { it.copy(pendingLink = target) }
        if (mutableState.value.session != null) openConversation(target.conversationId, target.messageId)
    }

    fun acceptVoiceShortcut(botId: String) {
        mutableState.update { it.copy(pendingVoiceShortcut = true) }
        acceptDeepLink("openteam://chat/${Uri.encode(botId)}")
    }

    fun consumeDeepLink() {
        mutableState.update { it.copy(pendingLink = null) }
    }

    fun consumeVoiceShortcut() {
        mutableState.update { it.copy(pendingVoiceShortcut = false) }
    }

    fun consumeExternalUrl() {
        mutableState.update { it.copy(pendingExternalUrl = null) }
    }

    fun consumeSystemAction() {
        mutableState.update { it.copy(pendingSystemAction = null, pendingSystemIdentifier = null, pendingSystemPayload = null) }
    }

    fun acceptShare(payload: SharePayload) {
        mutableState.update { it.copy(pendingShare = payload, error = null) }
    }

    fun selectShareTarget(conversationId: String) {
        val share = mutableState.value.pendingShare ?: return
        val text = share.text?.trim().orEmpty()
        val streams = share.streams.ifEmpty { listOfNotNull(share.stream) }
        if (streams.isNotEmpty() && activeFeatureGateway === UnsupportedFeatureGateway) {
            mutableState.update { it.copy(error = "File sharing requires a connected server that supports attachments.") }
            return
        }
        val session = mutableState.value.session
        mutableState.update {
            it.copy(
                pendingShare = null,
                activeConversationId = conversationId,
                activeMessageId = null,
                draft = text,
                messages = emptyList(),
                error = null,
                loading = streams.isNotEmpty(),
            )
        }
        if (session != null) drafts.put(accountScope(session), conversationId, text)
        viewModelScope.launch {
            val history = runCatching { activeGateway.history(conversationId) }
            history.onSuccess { value -> mutableState.update { it.copy(messages = value) } }
                .onFailure { error -> mutableState.update { it.copy(error = error.message, loading = false) } }
            if (streams.isNotEmpty()) {
                val attachments = mutableListOf<Attachment>()
                var failure: Throwable? = null
                for (uri in streams) {
                    val result = activeFeatureGateway.uploadAttachment(uri.toString())
                    if (result.isFailure) {
                        failure = result.exceptionOrNull()
                        break
                    }
                    attachments += result.getOrThrow()
                }
                if (failure != null) {
                    mutableState.update { it.copy(error = failure?.message ?: "Attachment upload failed.", loading = false) }
                } else {
                    val displayText = text.ifBlank { attachments.joinToString(", ") { it.name } }
                    val id = newClientId()
                    val optimistic = ChatMessage(id, "You", displayText, isMine = true, delivery = Delivery.SENDING, attachments = attachments)
                    val pending = PendingSend(
                        id = id,
                        channelId = conversationId,
                        content = text,
                        attachments = attachments.map(Attachment::messageRef),
                    )
                    mutableState.update {
                        it.copy(
                            messages = it.messages + optimistic,
                            draft = "",
                            loading = false,
                            outbox = it.outbox + pending,
                        )
                    }
                    if (session != null) drafts.put(accountScope(session), conversationId, "")
                    persistOutbox()
                    flushOutbox()
                }
            }
        }
    }

    fun signIn(server: String, username: String, credential: String) {
        connect(gateway, server, username, credential)
    }

    fun signInPreview(server: String, username: String, credential: String) {
        connect(
            previewGateway,
            server.ifBlank { "sample.local" },
            username.ifBlank { "Sample user" },
            credential.ifBlank { "sample" },
        )
    }

    fun checkServer(server: String) {
        val validator = gateway as? ServerValidationApi
        if (validator == null) {
            mutableState.update {
                it.copy(authChecking = false, validatedServer = server.trim(), error = null)
            }
            return
        }
        mutableState.update { it.copy(authChecking = true, validatedServer = null, error = null) }
        viewModelScope.launch {
            validator.validateServer(server).fold(
                onSuccess = { validation ->
                    mutableState.update {
                        it.copy(
                            authChecking = false,
                            validatedServer = validation.server,
                            error = null,
                        )
                    }
                },
                onFailure = { error ->
                    mutableState.update {
                        it.copy(authChecking = false, validatedServer = null, error = error.message)
                    }
                },
            )
        }
    }

    fun clearServerValidation() {
        mutableState.update { it.copy(validatedServer = null, error = null) }
    }

    private fun connect(target: MobileGateway, server: String, username: String, credential: String) {
        mutableState.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            target.signIn(server, username, credential).fold(
                onSuccess = { session ->
                    indexedAccount?.takeIf { it != accountScope(session) }?.let(systemSearch::clear)
                    indexedAccount = accountScope(session)
                    activeGateway = target
                    activeFeatureGateway = featureGateway
                        ?: (target as? MobileFeatureApi)?.let(::LiveFeatureGateway)
                        ?: UnsupportedFeatureGateway
                    mutableState.update { it.copy(session = session, loading = false) }
                    loadDirectory()
                    loadFeatureData()
                    mutableState.update { it.copy(outbox = outboxStore.read(accountScope(session))) }
                    startLiveSync()
                    flushOutbox()
                },
                onFailure = { error -> mutableState.update { it.copy(loading = false, error = error.message) } },
            )
        }
    }

    fun loadDirectory() {
        viewModelScope.launch {
            runCatching { activeGateway.conversations() }
                .onSuccess { rows ->
                    mutableState.update { it.copy(conversations = rows) }
                    val searchItems = rows.map { row ->
                        SearchableItem(row.id, row.title, row.subtitle, row.preview.orEmpty(), android.net.Uri.parse("openteam://chat/${android.net.Uri.encode(row.id)}"))
                    }
                    mutableState.value.session?.let { session ->
                        viewModelScope.launch { appSearch.replace(accountScope(session), searchItems) }
                    }
                    launcherShortcuts.publish(rows, currentRoutines())
                    mutableState.value.session?.let { session ->
                        systemSearch.replace(accountScope(session), rows.map { row ->
                            SearchableItem(row.id, row.title, row.subtitle, row.preview.orEmpty(), android.net.Uri.parse("openteam://chat/${android.net.Uri.encode(row.id)}"))
                        })
                    }
                }
                .onFailure { error -> mutableState.update { it.copy(error = error.message) } }
            // Load pins and grouping after the directory so both requests settle in order.
            runCatching { activeGateway.sidebarPreferences() }
                .onSuccess { preferences -> mutableState.update { it.copy(sidebar = preferences) } }
            runCatching { activeGateway.hiddenConversations() }
                .onSuccess { hidden -> mutableState.update { it.copy(hiddenConversations = hidden) } }
        }
    }

    fun search(query: String, category: String) {
        val normalized = query.trim()
        val generation = ++searchGeneration
        if (normalized.isBlank()) {
            mutableState.update { it.copy(searchResults = emptyList(), searchLoading = false, searchError = null) }
            return
        }
        mutableState.update { it.copy(searchLoading = true, searchError = null) }
        viewModelScope.launch {
            runCatching { activeGateway.search(normalized, category) }
                .onSuccess { results ->
                    if (generation != searchGeneration) return@onSuccess
                    mutableState.update {
                        it.copy(searchResults = results, searchLoading = false, searchError = null)
                    }
                    mutableState.value.session?.let { session ->
                        systemSearch.replace(
                            accountScope(session),
                            mutableState.value.conversations.map { row ->
                                SearchableItem(row.id, row.title, row.subtitle, row.preview.orEmpty(), android.net.Uri.parse("openteam://chat/${android.net.Uri.encode(row.id)}"))
                            } + page.messages.map { message ->
                                SearchableItem("message:${message.id}", message.author, message.channelId, message.displayBody.orEmpty(), android.net.Uri.parse("openteam://chat/${android.net.Uri.encode(conversationId)}?message=${android.net.Uri.encode(message.id)}"))
                            },
                        )
                    }
                }
                .onFailure { error ->
                    if (generation != searchGeneration) return@onFailure
                    mutableState.update {
                        it.copy(searchResults = emptyList(), searchLoading = false, searchError = error.message)
                    }
                }
        }
    }

    fun clearSearch() {
        searchGeneration += 1
        mutableState.update { it.copy(searchResults = emptyList(), searchLoading = false, searchError = null) }
    }

    /** Refreshes server-stored pins and section grouping for the conversation list. */
    fun loadSidebar() {
        viewModelScope.launch {
            runCatching { activeGateway.sidebarPreferences() }
                .onSuccess { preferences -> mutableState.update { it.copy(sidebar = preferences) } }
        }
    }

    fun togglePinned(conversationId: String) {
        saveSidebar(mutableState.value.sidebar.togglePin(conversationId))
    }

    fun moveToSection(conversationId: String, sectionId: String?) {
        saveSidebar(mutableState.value.sidebar.moveToSection(conversationId, sectionId))
    }

    fun toggleSection(sectionId: String?) {
        saveSidebar(mutableState.value.sidebar.toggleSection(sectionId))
    }

    fun renameSection(sectionId: String, name: String) {
        if (name.trim().isEmpty() || name.length > 120) return
        saveSidebar(mutableState.value.sidebar.renameSection(sectionId, name))
    }

    fun deleteSection(sectionId: String) {
        saveSidebar(mutableState.value.sidebar.deleteSection(sectionId))
    }

    fun loadHiddenConversations() {
        viewModelScope.launch {
            runCatching { activeGateway.hiddenConversations() }
                .onSuccess { hidden -> mutableState.update { it.copy(hiddenConversations = hidden) } }
                .onFailure { error -> mutableState.update { it.copy(error = error.message) } }
        }
    }

    /** Applies a sidebar change optimistically, then persists it to the server. */
    private fun saveSidebar(next: SidebarPreferences) {
        val previous = mutableState.value.sidebar
        mutableState.update { it.copy(sidebar = next) }
        viewModelScope.launch {
            runCatching { activeGateway.saveSidebarPreferences(next) }
                .onSuccess { saved -> mutableState.update { it.copy(sidebar = saved) } }
                .onFailure { mutableState.update { it.copy(sidebar = previous, error = it.error ?: "无法保存排序设置。") } }
        }
    }

    fun openConversation(id: String, messageId: String? = null) {
        val session = mutableState.value.session
        mutableState.update {
            it.copy(
                activeConversationId = id,
                activeMessageId = messageId,
                draft = session?.let { drafts.get(accountScope(it), id) }.orEmpty(),
                messages = emptyList(),
                historyBeforeSequence = null,
                hasMoreHistory = false,
                historyLoading = false,
                error = null,
            )
        }
        viewModelScope.launch {
            runCatching { activeGateway.historyPage(id) }
                .onSuccess { page ->
                    mutableState.update {
                        it.copy(
                            messages = page.messages,
                            threadContext = page.threadContext,
                            threadContextTruncated = page.threadContextTruncated,
                            historyBeforeSequence = page.beforeSequence,
                            hasMoreHistory = page.hasMoreBefore,
                            historyLoading = false,
                        )
                    }
                    mutableState.value.session?.let { activeSession ->
                        viewModelScope.launch {
                            appSearch.upsert(
                                accountScope(activeSession),
                                searchableItems(emptyList(), page.messages),
                            )
                        }
                    }
                    markConversationRead(id, page.messages)
                }
                .onFailure { error -> mutableState.update { it.copy(error = error.message) } }
        }
    }

    fun loadOlderHistory() {
        val current = mutableState.value
        val conversationId = current.activeConversationId ?: return
        val before = current.historyBeforeSequence ?: return
        if (!current.hasMoreHistory || current.historyLoading) return
        mutableState.update { it.copy(historyLoading = true, error = null) }
        viewModelScope.launch {
            runCatching { activeGateway.historyPage(conversationId, before, 60) }
                .onSuccess { page ->
                    mutableState.update { state ->
                        state.copy(
                            messages = ChatHistoryPage.merge(state.messages, page.messages),
                            historyBeforeSequence = page.beforeSequence,
                            hasMoreHistory = page.hasMoreBefore,
                            historyLoading = false,
                        )
                    }
                }
                .onFailure { error ->
                    mutableState.update {
                        it.copy(historyLoading = false, error = error.message ?: "Could not load older messages.")
                    }
                }
        }
    }

    fun updateDraft(value: String) {
        val current = mutableState.value
        val id = current.activeConversationId ?: return
        val session = current.session ?: return
        drafts.put(accountScope(session), id, value)
        mutableState.update { it.copy(draft = value) }
    }

    fun sendDraft() {
        val current = mutableState.value
        val conversationId = current.activeConversationId ?: return
        val text = current.draft.trim()
        val attachments = current.pendingAttachments
        if (text.isEmpty() && attachments.isEmpty()) return
        val id = newClientId()
        val optimistic = ChatMessage(id, "You", text, isMine = true, delivery = Delivery.SENDING, attachments = attachments)
        val pending = PendingSend(
            id = id,
            channelId = conversationId,
            content = text,
            attachments = attachments.map(Attachment::messageRef),
        )
        mutableState.update {
            it.copy(
                messages = it.messages + optimistic,
                draft = "",
                pendingAttachments = emptyList(),
                outbox = it.outbox + pending,
                error = null,
            )
        }
        current.session?.let { drafts.put(accountScope(it), conversationId, "") }
        persistOutbox()
        flushOutbox()
    }

    fun retryMessage(messageId: String) {
        val current = mutableState.value
        val conversationId = current.activeConversationId ?: return
        val message = current.messages.firstOrNull { it.id == messageId && it.delivery == Delivery.FAILED } ?: return
        val queued = current.outbox.firstOrNull { it.id == messageId }
        if (queued != null) {
            mutableState.update { state ->
                state.copy(
                    outbox = state.outbox.map { if (it.id == messageId) it.copy(failure = null) else it },
                    messages = state.messages.map {
                        if (it.id == messageId) it.copy(delivery = Delivery.SENDING) else it
                    },
                    error = null,
                )
            }
            persistOutbox()
            flushOutbox()
            return
        }
        mutableState.update { state ->
            state.copy(
                messages = state.messages.map { if (it.id == messageId) it.copy(delivery = Delivery.SENDING) else it },
                error = null,
            )
        }
        deliver(conversationId, message.copy(delivery = Delivery.SENDING))
    }

    /** Retries an outbox item from the outbox screen, even when its conversation is closed. */
    fun retryQueuedMessage(messageId: String) {
        if (mutableState.value.outbox.none { it.id == messageId }) return
        mutableState.update { state ->
            state.copy(
                outbox = state.outbox.map { if (it.id == messageId) it.copy(failure = null) else it },
                messages = state.messages.map {
                    if (it.id == messageId) it.copy(delivery = Delivery.SENDING) else it
                },
                error = null,
            )
        }
        persistOutbox()
        flushOutbox()
    }

    fun discardQueuedMessage(messageId: String) {
        mutableState.update { state ->
            state.copy(
                outbox = state.outbox.filterNot { it.id == messageId },
                messages = state.messages.filterNot { it.id == messageId },
            )
        }
        persistOutbox()
    }

    private fun deliver(
        conversationId: String,
        message: ChatMessage,
        text: String = message.body,
        attachments: List<MessageAttachment> = message.attachments.map { it.messageRef() },
    ) {
        viewModelScope.launch {
            activeGateway.send(conversationId, text, message.id, attachments).fold(
                onSuccess = { accepted ->
                    mutableState.update { state ->
                        state.copy(messages = state.messages.map { if (it.id == message.id) accepted.copy(delivery = Delivery.SENT) else it })
                    }
                },
                onFailure = { error ->
                    mutableState.update { state ->
                        state.copy(
                            messages = state.messages.map { if (it.id == message.id) it.copy(delivery = Delivery.FAILED) else it },
                            error = error.message ?: "Message could not be sent. Retry when connected.",
                        )
                    }
                },
            )
        }
    }

    private fun persistOutbox() {
        val session = mutableState.value.session ?: return
        outboxStore.write(accountScope(session), mutableState.value.outbox)
    }

    private fun flushOutbox() {
        if (outboxJob?.isActive == true) return
        outboxJob = viewModelScope.launch {
            val live = activeGateway as? LiveMessagingApi ?: return@launch
            while (isActive) {
                val pending = mutableState.value.outbox.firstOrNull { it.failure == null } ?: return@launch
                val delivery = try {
                    live.deliveryStatus(pending.channelId, pending.id)
                } catch (_: Throwable) {
                    return@launch
                }
                val delivered = delivery?.message
                when {
                    delivered != null -> acceptQueuedMessage(pending.id, live.toChatMessage(delivered))
                    delivery?.status?.lowercase() in setOf("pending", "processing") -> return@launch
                    delivery?.status?.lowercase() in setOf("rejected", "failed") -> {
                        failQueuedMessage(pending.id, delivery.messageText ?: "The server rejected this message.")
                        return@launch
                    }
                    else -> {
                        activeGateway.send(
                            pending.channelId,
                            pending.content,
                            pending.id,
                            pending.attachments,
                        ).fold(
                            onSuccess = { acceptQueuedMessage(pending.id, it) },
                            onFailure = {
                                failQueuedMessage(
                                    pending.id,
                                    it.message ?: "Message could not be sent. Retry when connected.",
                                )
                                return@launch
                            },
                        )
                    }
                }
            }
        }
    }

    private fun acceptQueuedMessage(clientId: String, accepted: ChatMessage) {
        mutableState.update { state ->
            state.copy(
                outbox = state.outbox.filterNot { it.id == clientId },
                messages = state.messages.map { message ->
                    if (message.id == clientId || message.clientId == clientId) {
                        accepted.copy(delivery = Delivery.SENT)
                    } else {
                        message
                    }
                },
            )
        }
        persistOutbox()
    }

    private fun failQueuedMessage(clientId: String, failure: String) {
        mutableState.update { state ->
            state.copy(
                outbox = state.outbox.map { if (it.id == clientId) it.copy(failure = failure) else it },
                messages = state.messages.map {
                    if (it.id == clientId) it.copy(delivery = Delivery.FAILED) else it
                },
                error = failure,
            )
        }
        persistOutbox()
    }

    private fun startLiveSync() {
        syncJob?.cancel()
        val live = activeGateway as? LiveMessagingApi ?: return
        syncJob = viewModelScope.launch {
            var failureDelay = 500L
            while (isActive && mutableState.value.session != null) {
                try {
                    live.syncEvents(::handleProductEvent)
                    flushOutbox()
                    failureDelay = 500L
                } catch (_: Throwable) {
                    delay(failureDelay)
                    failureDelay = (failureDelay * 2).coerceAtMost(15_000L)
                }
            }
        }
    }

    private fun handleProductEvent(event: ProductEvent) {
        if (!event.topic.startsWith("channel.")) return
        val eventMessage = event.payload["message"]?.let { element ->
            runCatching { mobileJson.decodeFromJsonElement(MobileMessage.serializer(), element) }.getOrNull()
        }
        val channelId = event.payload["channelId"]?.jsonPrimitive?.contentOrNull
            ?.takeIf(String::isNotBlank)
            ?: eventMessage?.channelId?.takeIf(String::isNotBlank)
            ?: event.entityId?.takeIf { event.topic !in setOf("channel.message.created", "channel.message.accepted", "channel.message.updated", "channel.message.user_reaction") }
        loadDirectory()
        if (channelId != null && channelId == mutableState.value.activeConversationId) {
            mutableState.value.activeConversationId?.let(::refreshConversation)
        }
        if (event.topic == "channel.message.accepted") {
            val clientId = event.payload["clientId"]?.jsonPrimitive?.contentOrNull
                ?.takeIf(String::isNotBlank)
                ?: eventMessage?.clientId
            if (clientId != null && eventMessage != null) {
                acceptQueuedMessage(clientId, (activeGateway as? LiveMessagingApi)?.toChatMessage(eventMessage) ?: return)
            } else {
                flushOutbox()
            }
        }
    }

    private fun refreshConversation(conversationId: String) {
        viewModelScope.launch {
            runCatching { activeGateway.historyPage(conversationId) }
                .onSuccess { page ->
                    mutableState.update {
                        it.copy(
                            messages = page.messages,
                            threadContext = page.threadContext,
                            threadContextTruncated = page.threadContextTruncated,
                            historyBeforeSequence = page.beforeSequence,
                            hasMoreHistory = page.hasMoreBefore,
                            historyLoading = false,
                        )
                    }
                    mutableState.value.session?.let { session ->
                        val items = searchableItems(emptyList(), page.messages)
                        viewModelScope.launch { appSearch.upsert(accountScope(session), items) }
                    }
                    markConversationRead(conversationId, page.messages)
                }
        }
    }

    private fun markConversationRead(conversationId: String, messages: List<ChatMessage>) {
        val live = activeGateway as? LiveMessagingApi ?: return
        val through = messages.lastOrNull()?.sequence?.takeIf(String::isNotBlank) ?: return
        viewModelScope.launch {
            runCatching { live.markRead(conversationId, through) }
                .onSuccess {
                    mutableState.update { state ->
                        state.copy(
                            conversations = state.conversations.map {
                                if (it.id == conversationId) it.copy(unread = 0) else it
                            },
                            sidebar = state.sidebar.copy(unreadIds = state.sidebar.unreadIds - conversationId),
                        )
                    }
                }
        }
    }

    private fun searchableItems(conversations: List<Conversation>, messages: List<ChatMessage>): List<SearchableItem> =
        conversations.map { row ->
            SearchableItem(
                row.id,
                row.title,
                row.subtitle,
                row.preview.orEmpty(),
                android.net.Uri.parse("openteam://chat/${android.net.Uri.encode(row.id)}"),
            )
        } + messages.map { message ->
            SearchableItem(
                "message:${message.id}",
                message.author,
                message.channelId,
                message.displayBody.orEmpty(),
                android.net.Uri.parse("openteam://chat/${android.net.Uri.encode(message.channelId)}?message=${android.net.Uri.encode(message.id)}"),
            )
        }

    fun uploadChatAttachment(uri: String) {
        runFeatureOperation {
            activeFeatureGateway.uploadAttachment(uri)
                .onSuccess { attachment ->
                    mutableState.update { it.copy(pendingAttachments = it.pendingAttachments + attachment.copy(localUri = uri)) }
                }
                .onFailure(::reportFeatureFailure)
        }
    }

    fun downloadChatAttachment(messageId: String, attachment: Attachment) {
        if (!attachment.localUri.isNullOrBlank()) return
        runFeatureOperation {
            activeFeatureGateway.downloadAttachment(attachment.id)
                .onSuccess { uri -> updateMessageAttachment(messageId, attachment.id) { it.copy(localUri = uri) } }
                .onFailure(::reportFeatureFailure)
        }
    }

    fun saveChatAttachment(messageId: String, attachment: Attachment) {
        runFeatureOperation {
            activeFeatureGateway.saveAttachment(attachment.id)
                .onSuccess { uri -> updateMessageAttachment(messageId, attachment.id) { it.copy(localUri = uri) } }
                .onFailure(::reportFeatureFailure)
        }
    }

    fun shareChatAttachment(attachment: Attachment) {
        runFeatureOperation {
            val result = if (attachment.localUri.isNullOrBlank()) {
                activeFeatureGateway.downloadAttachment(attachment.id)
            } else {
                Result.success(attachment.localUri ?: error("Attachment URI is unavailable."))
            }
            result.onSuccess { uri ->
                mutableState.update {
                    it.copy(
                        pendingOutgoingShare = OutgoingShare(uri, attachment.mimeType, attachment.name),
                        features = it.features.copy(operation = FeatureOperationState.Succeeded("Ready to share")),
                    )
                }
            }.onFailure(::reportFeatureFailure)
        }
    }

    fun forwardChatAttachment(attachment: Attachment, destinationId: String) {
        runFeatureOperation {
            activeFeatureGateway.forwardAttachment(attachment.id, destinationId)
                .onSuccess {
                    mutableState.update {
                        it.copy(features = it.features.copy(operation = FeatureOperationState.Succeeded("Attachment forwarded")))
                    }
                }
                .onFailure(::reportFeatureFailure)
        }
    }

    fun consumeOutgoingShare() {
        mutableState.update { it.copy(pendingOutgoingShare = null) }
    }

    fun createBot(name: String, description: String, instructions: String, icon: String, color: String) {
        runConversationMutation {
            request(
                HttpMethod.POST,
                "/api/v0/bots",
                buildJsonObject {
                    put("clientRequestId", newClientId())
                    put("name", name.trim())
                    put("description", description)
                    put("instructions", instructions)
                    put("icon", icon)
                    put("color", color)
                },
            )
        }
    }

    fun createGroup(name: String, botIds: List<String>) {
        runConversationMutation {
            request(
                HttpMethod.POST,
                "/api/v0/channels",
                buildJsonObject {
                    put("name", name.trim())
                    put("botIds", kotlinx.serialization.json.buildJsonArray { botIds.forEach(::add) })
                },
            )
        }
    }

    fun updateBot(conversation: Conversation, name: String, description: String, instructions: String, icon: String, color: String) {
        val botId = conversation.botId ?: return
        runConversationMutation {
            request(
                HttpMethod.PATCH,
                "/api/v0/bots/${Uri.encode(botId)}",
                buildJsonObject {
                    put("name", name.trim())
                    put("description", description)
                    put("instructions", instructions)
                    put("icon", icon)
                    put("color", color)
                },
            )
        }
    }

    fun updateGroup(conversation: Conversation, name: String, description: String, botIds: List<String>) {
        runConversationMutation {
            request(
                HttpMethod.PATCH,
                "/api/v0/channels/${Uri.encode(conversation.id)}/profile",
                buildJsonObject {
                    put("name", name.trim())
                    put("description", description)
                    put("clientId", newClientId())
                },
            )
            request(
                HttpMethod.PUT,
                "/api/v0/channels/${Uri.encode(conversation.id)}/members",
                buildJsonObject {
                    put("botIds", kotlinx.serialization.json.buildJsonArray { botIds.forEach(::add) })
                    put("clientId", newClientId())
                },
            )
        }
    }

    fun setConversationHidden(conversation: Conversation, hidden: Boolean) {
        runConversationMutation(after = { loadHiddenConversations() }) {
            if (conversation.isBot && conversation.botId != null) {
                request(
                    HttpMethod.PATCH,
                    "/api/v0/bots/${Uri.encode(conversation.botId)}",
                    buildJsonObject { put("hiddenFromSidebar", hidden) },
                )
            } else {
                request(
                    HttpMethod.PATCH,
                    "/api/v0/channels/${Uri.encode(conversation.id)}/hidden",
                    buildJsonObject { put("hidden", hidden); put("clientId", newClientId()) },
                )
            }
        }
    }

    fun setBotNotifications(conversation: Conversation, enabled: Boolean) {
        val botId = conversation.botId ?: return
        runConversationMutation {
            request(
                HttpMethod.PATCH,
                "/api/v0/bots/${Uri.encode(botId)}",
                buildJsonObject { put("notificationsEnabled", enabled) },
            )
        }
    }

    fun deleteConversation(conversation: Conversation) {
        runConversationMutation {
            request(
                HttpMethod.DELETE,
                if (conversation.isBot && conversation.botId != null) "/api/v0/bots/${Uri.encode(conversation.botId)}"
                else "/api/v0/channels/${Uri.encode(conversation.id)}",
            )
        }
    }

    fun duplicateBot(conversation: Conversation) {
        val botId = conversation.botId ?: return
        runConversationMutation {
            request(
                HttpMethod.POST,
                "/api/v0/bots/${Uri.encode(botId)}/duplicate",
                buildJsonObject { put("clientRequestId", newClientId()) },
            )
        }
    }

    private suspend fun request(method: HttpMethod, path: String, body: JsonObject? = null): JsonObject {
        val api = activeGateway as? MobileFeatureApi
            ?: error("This action requires a connected server.")
        return api.request(method, path, body)
    }

    private fun runConversationMutation(after: suspend () -> Unit = {}, operation: suspend () -> Unit) {
        runFeatureOperation {
            operation()
            loadDirectory()
            after()
        }
    }

    fun submitChatAction(messageId: String, actionId: String, values: Map<String, String> = emptyMap()) {
        runFeatureOperation { activeFeatureGateway.submitRichAction(messageId, actionId, values).onFailure(::reportFeatureFailure) }
    }

    fun reactToChatMessage(messageId: String, emoji: String) {
        runFeatureOperation {
            activeFeatureGateway.mutateReaction(messageId, emoji)
                .onSuccess { reactions -> mutableState.update { state -> state.copy(messages = state.messages.map { if (it.id == messageId) it.copy(reactions = reactions) else it }) } }
                .onFailure(::reportFeatureFailure)
        }
    }

    fun mutateChatMessage(messageId: String, action: com.openteam.features.MessageAction) {
        runFeatureOperation { activeFeatureGateway.mutateMessageAction(messageId, action).onFailure(::reportFeatureFailure) }
    }

    fun loadMessageContext(messageId: String) {
        viewModelScope.launch {
            runCatching { activeGateway.messageContext(messageId) }
                .onSuccess { page ->
                    mutableState.update { state ->
                        val merged = (state.messages + page.messages + page.threadContext).distinctBy { it.id }.sortedWith(compareBy({ it.sequence.isBlank() }, { it.sequence }, { it.createdAt }))
                        state.copy(messages = merged, threadContext = page.threadContext, threadContextTruncated = page.threadContextTruncated, activeMessageId = messageId, error = null)
                    }
                }
                .onFailure { error -> mutableState.update { it.copy(error = error.message ?: "Could not load message context") } }
        }
    }

    private fun updateMessageAttachment(messageId: String, attachmentId: String, update: (Attachment) -> Attachment) {
        mutableState.update { state ->
            state.copy(messages = state.messages.map { message ->
                if (message.id != messageId) message else message.copy(attachments = message.attachments.map { attachment -> if (attachment.id == attachmentId) update(attachment) else attachment })
            })
        }
    }

    fun signOut() {
        mutableState.value.session?.let {
            drafts.clearAccount(accountScope(it))
            outboxStore.clear(accountScope(it))
            systemSearch.clear(accountScope(it))
            viewModelScope.launch { appSearch.clear(accountScope(it)) }
            indexedAccount = null
        }
        launcherShortcuts.clear()
        syncJob?.cancel()
        outboxJob?.cancel()
        viewModelScope.launch { runCatching { activeGateway.signOut() } }
        activeGateway = gateway
        mutableState.value = AppState()
    }

    fun startVoice() {
        if (activeGateway !is VoiceTranscriptionApi) {
            mutableState.update { it.copy(error = "Voice transcription requires a connected server with transcription configured.") }
            return
        }
        voiceController.start()
    }

    fun stopVoice() {
        voiceController.stopAndTranscribe(mutableState.value.draft, ::updateDraft)
    }

    fun retryVoice() {
        voiceController.retry(mutableState.value.draft, ::updateDraft)
    }

    fun cancelVoice() {
        voiceController.cancel()
    }

    override fun onCleared() {
        syncJob?.cancel()
        outboxJob?.cancel()
        voiceController.close()
        super.onCleared()
    }

    fun loadFeatureData() {
        loadRoutines()
        loadAccountMemory()
        loadSettings()
        loadProviders()
        loadWebProviders()
        loadPlugins()
    }

    suspend fun requestComputerGrant(botId: String): Result<ComputerVncGrant> = runCatching {
        val api = activeGateway as? MobileFeatureApi
            ?: error("Cloud computer viewing requires a connected server.")
        val path = "/api/v0/bots/${Uri.encode(botId)}/screen/vnc"
        ComputerVncGrant.fromJson(api.request(HttpMethod.POST, path))
    }

    suspend fun computerStatus(botId: String): Result<JsonObject> = runCatching {
        computerRequest(HttpMethod.GET, "/api/v0/bots/${Uri.encode(botId)}/screen")
    }

    suspend fun setComputerTakeover(botId: String, active: Boolean): Result<JsonObject> = runCatching {
        computerRequest(
            HttpMethod.POST,
            "/api/v0/bots/${Uri.encode(botId)}/screen/takeover",
            buildJsonObject { put("active", active) },
        )
    }

    suspend fun setComputerPaused(botId: String, paused: Boolean): Result<JsonObject> = runCatching {
        computerRequest(
            HttpMethod.POST,
            "/api/v0/bots/${Uri.encode(botId)}/screen/pause",
            buildJsonObject { put("paused", paused) },
        )
    }

    suspend fun sendComputerAction(botId: String, action: JsonObject): Result<JsonObject> = runCatching {
        computerRequest(HttpMethod.POST, "/api/v0/bots/${Uri.encode(botId)}/screen/actions", action)
    }

    suspend fun sendComputerClipboard(botId: String, text: String): Result<JsonObject> = runCatching {
        computerRequest(
            HttpMethod.POST,
            "/api/v0/bots/${Uri.encode(botId)}/screen/clipboard",
            buildJsonObject { put("action", "paste"); put("text", text) },
        )
    }

    private suspend fun computerRequest(method: HttpMethod, path: String, body: JsonObject? = null): JsonObject {
        val api = activeGateway as? MobileFeatureApi
            ?: error("Cloud computer control requires a connected server.")
        return api.request(method, path, body)
    }

    fun startRoutineEditor(routine: Routine? = null) {
        mutableState.update { it.copy(features = it.features.copy(routineDraft = routine ?: emptyRoutine())) }
    }

    fun updateRoutineDraft(routine: Routine) {
        mutableState.update { it.copy(features = it.features.copy(routineDraft = routine)) }
    }

    fun saveRoutine() {
        val routine = mutableState.value.features.routineDraft ?: return
        runFeatureOperation {
            activeFeatureGateway.saveRoutine("", routine).onSuccess {
                mutableState.update { it.copy(features = it.features.copy(routineDraft = null)) }
                loadRoutines()
            }.onFailure(::reportFeatureFailure)
        }
    }

    fun deleteRoutine() {
        val routine = mutableState.value.features.routineDraft ?: return
        runFeatureOperation {
            activeFeatureGateway.deleteRoutine(routine.id, routine.revision).onSuccess {
                mutableState.update { it.copy(features = it.features.copy(routineDraft = null)) }
                loadRoutines()
            }.onFailure(::reportFeatureFailure)
        }
    }

    fun toggleRoutine(routine: Routine) {
        runFeatureOperation {
            activeFeatureGateway.setRoutineEnabled(routine.id, !routine.enabled, routine.revision)
                .onSuccess { loadRoutines() }.onFailure(::reportFeatureFailure)
        }
    }

    fun runRoutine(routine: Routine) {
        runFeatureOperation {
            activeFeatureGateway.runRoutine(routine.id).onSuccess { loadRoutines() }.onFailure(::reportFeatureFailure)
        }
    }

    fun runRoutineById(routineId: String) {
        if (routineId.isBlank()) return
        runFeatureOperation {
            activeFeatureGateway.runRoutine(routineId).onSuccess { loadRoutines() }.onFailure(::reportFeatureFailure)
        }
    }

    fun clearMemory() {
        runFeatureOperation {
            activeFeatureGateway.clearMemory().onSuccess { loadAccountMemory() }.onFailure(::reportFeatureFailure)
        }
    }

    fun resetLocalData() {
        val session = mutableState.value.session
        if (session == null) {
            mutableState.update { it.copy(error = "Sign in before resetting local data.") }
            return
        }
        drafts.clearAccount(accountScope(session))
        outboxStore.clear(accountScope(session))
        mutableState.update { it.copy(outbox = emptyList(), draft = "", pendingAttachments = emptyList(), error = null) }
        runFeatureOperation { activeFeatureGateway.resetLocalData().onFailure(::reportFeatureFailure) }
    }

    fun saveSettings(settings: AppSettings) {
        settingsPreferences.edit()
            .putString("appearance", settings.appearance.name)
            .putString("accent", settings.accent.name)
            .putString("language", settings.language.name)
            .putString("timeZone", settings.timeZone)
            .putBoolean("haptics", settings.haptics)
            .putBoolean("notifications.messages", settings.notifications.messages)
            .putBoolean("notifications.mentions", settings.notifications.mentions)
            .putBoolean("notifications.routineRuns", settings.notifications.routineRuns)
            .apply()
        mutableState.update { it.copy(features = it.features.copy(settings = settings)) }
        runFeatureOperation {
            activeFeatureGateway.saveSettings(settings).onSuccess { saved ->
                mutableState.update { it.copy(features = it.features.copy(settings = saved)) }
            }.onFailure(::reportFeatureFailure)
        }
    }

    fun connectProvider(provider: ProviderConnection, apiKey: String? = null) {
        runFeatureOperation {
            activeFeatureGateway.saveProvider(provider, apiKey).onSuccess { saved ->
                saved.authorizationUrl?.takeIf(String::isNotBlank)?.let { url -> mutableState.update { it.copy(pendingExternalUrl = url) } }
                loadProviders()
            }.onFailure(::reportFeatureFailure)
        }
    }

    fun disconnectProvider(provider: ProviderConnection) {
        runFeatureOperation { activeFeatureGateway.disconnectProvider(provider.id).onSuccess { loadProviders() }.onFailure(::reportFeatureFailure) }
    }

    fun saveWebProvider(tool: String, provider: WebProvider, apiKey: String? = null) {
        runFeatureOperation {
            activeFeatureGateway.saveWebProvider(tool, provider.id, apiKey, provider.selected).onSuccess { value ->
                mutableState.update { it.copy(features = it.features.copy(webProviders = FeatureLoadState.Ready(value))) }
            }.onFailure(::reportFeatureFailure)
        }
    }

    fun selectWebProvider(tool: String, provider: WebProvider) = saveWebProvider(tool, provider.copy(selected = true))

    fun checkWebProvider(tool: String, provider: WebProvider) {
        runFeatureOperation { activeFeatureGateway.checkWebProvider(tool, provider.id).onSuccess { loadWebProviders() }.onFailure(::reportFeatureFailure) }
    }

    fun installPlugin(plugin: Plugin) {
        pluginOperation({ activeFeatureGateway.installPlugin(plugin.id) })
    }

    fun updatePlugin(plugin: Plugin) {
        pluginOperation({ activeFeatureGateway.updatePlugin(plugin.id) })
    }

    fun rollbackPlugin(plugin: Plugin) {
        pluginOperation({ activeFeatureGateway.rollbackPlugin(plugin.id) })
    }
    fun authorizePlugin(plugin: Plugin) = pluginOperation(
        { activeFeatureGateway.authorizePlugin(plugin.connectionId ?: plugin.id) },
        onSuccess = { authorized ->
            authorized.authorizationUrl?.takeIf(String::isNotBlank)?.let { url ->
                mutableState.update { it.copy(pendingExternalUrl = url) }
            }
        },
    )
    fun cancelPluginAuthorization(plugin: Plugin) {
        val state = plugin.authorizationState ?: return
        runFeatureOperation {
            activeFeatureGateway.cancelPluginAuthorization(plugin.connectionId ?: plugin.id, state, plugin.authorizationRedirectUrl)
                .onSuccess { loadPlugins() }
                .onFailure(::reportFeatureFailure)
        }
    }

    fun acceptPluginCallbackUrl(rawUrl: String?) {
        val callbackUrl = rawUrl?.takeIf(String::isNotBlank) ?: return
        val state = runCatching {
            URI(callbackUrl).rawQuery.orEmpty().split('&').map { it.split('=', limit = 2) }
                .firstOrNull { it.firstOrNull() == "state" }
                ?.getOrNull(1)?.let { URLDecoder.decode(it, "UTF-8") }
        }.getOrNull().orEmpty()
        val plugin = (mutableState.value.features.plugins as? FeatureLoadState.Ready<*>)?.value
            .let { value -> (value as? List<Plugin>)?.firstOrNull { it.authorizationState == state } }
        if (plugin == null) {
            mutableState.update { it.copy(error = "This plugin authorization link is expired or belongs to another session.") }
            return
        }
        runFeatureOperation {
            activeFeatureGateway.completePluginAuthorization(plugin.connectionId ?: plugin.id, callbackUrl)
                .onSuccess { loadPlugins() }
                .onFailure(::reportFeatureFailure)
        }
    }
    fun testPluginTool(plugin: Plugin) {
        pluginOperation({ activeFeatureGateway.testPluginTool(plugin.connectionId ?: plugin.id, "", "{}") })
    }

    fun configurePlugin(plugin: Plugin, configuration: JsonObject) {
        pluginOperation({ activeFeatureGateway.configurePlugin(plugin.connectionId ?: plugin.id, configuration) })
    }

    private fun loadRoutines() {
        viewModelScope.launch {
            mutableState.update { it.copy(features = it.features.copy(routines = FeatureLoadState.Loading)) }
            activeFeatureGateway.listRoutines("").onSuccess { value ->
                mutableState.update { it.copy(features = it.features.copy(routines = if (value.isEmpty()) FeatureLoadState.Empty("No routines yet") else FeatureLoadState.Ready(value))) }
                launcherShortcuts.publish(mutableState.value.conversations, value)
            }.onFailure { error -> mutableState.update { it.copy(features = it.features.copy(routines = FeatureLoadState.Failure(error.message ?: "Could not load routines"))) } }
        }
    }

    private fun currentRoutines(): List<Routine> =
        (mutableState.value.features.routines as? FeatureLoadState.Ready<List<Routine>>)?.value.orEmpty()

    private fun loadAccountMemory() {
        viewModelScope.launch {
            mutableState.update { it.copy(features = it.features.copy(account = FeatureLoadState.Loading)) }
            activeFeatureGateway.loadAccountMemory().onSuccess { value -> mutableState.update { it.copy(features = it.features.copy(account = FeatureLoadState.Ready(value))) } }
                .onFailure { error -> mutableState.update { it.copy(features = it.features.copy(account = FeatureLoadState.Failure(error.message ?: "Could not load account"))) } }
        }
    }

    private fun loadSettings() {
        viewModelScope.launch {
            activeFeatureGateway.loadSettings().onSuccess { value ->
                val appearance = when (settingsPreferences.getString("appearance", null)) {
                    AppSettings.Appearance.Light.name -> AppSettings.Appearance.Light
                    AppSettings.Appearance.Dark.name -> AppSettings.Appearance.Dark
                    else -> AppSettings.Appearance.System
                }
                val accent = runCatching { AppSettings.Accent.valueOf(settingsPreferences.getString("accent", null).orEmpty()) }.getOrDefault(value.accent)
                val language = when (settingsPreferences.getString("language", null)) {
                    AppSettings.Language.Chinese.name -> AppSettings.Language.Chinese
                    else -> AppSettings.Language.English
                }
                val notifications = value.notifications.copy(
                    messages = settingsPreferences.getBoolean("notifications.messages", value.notifications.messages),
                    mentions = settingsPreferences.getBoolean("notifications.mentions", value.notifications.mentions),
                    routineRuns = settingsPreferences.getBoolean("notifications.routineRuns", value.notifications.routineRuns),
                )
                mutableState.update {
                    it.copy(features = it.features.copy(settings = value.copy(
                        appearance = appearance,
                        accent = accent,
                        language = language,
                        timeZone = settingsPreferences.getString("timeZone", value.timeZone) ?: value.timeZone,
                        haptics = settingsPreferences.getBoolean("haptics", value.haptics),
                        notifications = notifications,
                    )))
                }
            }
        }
    }

    private fun loadProviders() {
        viewModelScope.launch {
            mutableState.update { it.copy(features = it.features.copy(providers = FeatureLoadState.Loading)) }
            activeFeatureGateway.listProviderConnections().onSuccess { value -> mutableState.update { it.copy(features = it.features.copy(providers = if (value.isEmpty()) FeatureLoadState.Empty("No providers configured") else FeatureLoadState.Ready(value))) } }
                .onFailure { error -> mutableState.update { it.copy(features = it.features.copy(providers = FeatureLoadState.Failure(error.message ?: "Could not load providers"))) } }
        }
    }

    private fun loadWebProviders() {
        viewModelScope.launch {
            mutableState.update { it.copy(features = it.features.copy(webProviders = FeatureLoadState.Loading)) }
            activeFeatureGateway.loadWebProviders().onSuccess { value -> mutableState.update { it.copy(features = it.features.copy(webProviders = FeatureLoadState.Ready(value))) } }
                .onFailure { error -> mutableState.update { it.copy(features = it.features.copy(webProviders = FeatureLoadState.Failure(error.message ?: "Could not load web providers"))) } }
        }
    }

    private fun loadPlugins() {
        viewModelScope.launch {
            mutableState.update { it.copy(features = it.features.copy(plugins = FeatureLoadState.Loading)) }
            activeFeatureGateway.listPlugins().onSuccess { value -> mutableState.update { it.copy(features = it.features.copy(plugins = if (value.isEmpty()) FeatureLoadState.Empty("No plugins available") else FeatureLoadState.Ready(value))) } }
                .onFailure { error -> mutableState.update { it.copy(features = it.features.copy(plugins = FeatureLoadState.Failure(error.message ?: "Could not load plugins"))) } }
        }
    }

    private fun runFeatureOperation(operation: suspend () -> Unit) {
        mutableState.update { it.copy(features = it.features.copy(operation = FeatureOperationState.Pending)) }
        viewModelScope.launch {
            runCatching { operation() }
                .onSuccess {
                    if (mutableState.value.features.operation == FeatureOperationState.Pending) {
                        mutableState.update { it.copy(features = it.features.copy(operation = FeatureOperationState.Succeeded())) }
                    }
                }
                .onFailure(::reportFeatureFailure)
        }
    }

    private fun reportFeatureFailure(error: Throwable) {
        mutableState.update { it.copy(features = it.features.copy(operation = FeatureOperationState.Failed(error.message ?: "Operation failed"))) }
    }

    private fun <T> pluginOperation(operation: suspend () -> Result<T>, onSuccess: (T) -> Unit = {}) {
        runFeatureOperation {
            operation().onSuccess { value -> onSuccess(value); loadPlugins() }.onFailure(::reportFeatureFailure)
        }
    }

    private fun emptyRoutine() = Routine("", "", "", RoutineSchedule(timeZone = java.util.TimeZone.getDefault().id))

    private fun accountScope(session: MobileSession) =
        "${session.server.trimEnd('/').lowercase()}|${session.accountName.lowercase()}"
}

private fun URI.getQueryParameterCompat(name: String): String? = rawQuery.orEmpty().split('&')
    .map { it.split('=', limit = 2) }
    .firstOrNull { it.firstOrNull() == name }
    ?.getOrNull(1)
    ?.let { runCatching { URLDecoder.decode(it, "UTF-8") }.getOrNull() }

private fun Attachment.messageRef() = MessageAttachment(
    assetId = id,
    fileName = name,
    mimeType = mimeType,
    byteSize = sizeBytes,
    kind = kind,
)
