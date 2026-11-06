@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.openteam.android.ui

import android.Manifest
import android.os.Build
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.webkit.WebView
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.BackHandler
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.Image
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.fadeIn
import androidx.compose.animation.core.animateFloat
import com.openteam.android.data.ChannelActivity
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.scaleOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.navigation.NavBackStackEntry
import com.openteam.features.featureCardColors
import com.openteam.features.featureTopBarColors
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.ui.graphics.Brush
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AccessTime
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Button
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import kotlinx.coroutines.flow.drop
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.animation.core.Animatable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.draw.alpha
import com.openteam.android.data.RoutineEvent
import androidx.compose.ui.text.style.TextOverflow
import kotlin.math.roundToInt
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.openteam.android.AppViewModel
import com.openteam.android.data.ChatMessage
import com.openteam.android.data.Conversation
import com.openteam.android.data.SearchResult
import com.openteam.android.data.SidebarPreferences
import com.openteam.android.data.SidebarSection
import com.openteam.android.data.PendingSend
import com.openteam.features.Attachment
import com.openteam.features.AccountMemoryScreen
import com.openteam.features.FeatureOperationState
import com.openteam.features.FeatureLoadState
import com.openteam.features.MessageAction
import com.openteam.features.Plugin
import com.openteam.features.ReactionState
import com.openteam.features.ReactionsAndActionsRow
import com.openteam.features.RichMessageCardScreen
import com.openteam.features.isQuestion
import com.openteam.features.ChatAttachmentStrip
import com.openteam.features.rememberDecodedBitmap
import com.openteam.features.MarkdownMessage
import com.openteam.features.PluginsScreen
import com.openteam.features.ProviderSettingsScreen
import com.openteam.features.RoutineEditorScreen
import com.openteam.features.RoutinesScreen
import com.openteam.features.SettingsScreen
import com.openteam.features.WebProviderSettingsScreen
import com.openteam.features.LocalAppLanguage
import com.openteam.features.localizedText
import com.openteam.features.AppSettings
import com.openteam.platform.SharePayload
import com.openteam.platform.VoiceRecordingState
import com.openteam.platform.AndroidVncWebViewRenderer
import com.openteam.platform.ComputerVncGrant
import com.openteam.platform.VncRendererState
import com.openteam.platform.NativeAttachmentPreview
import java.net.URI
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val LOGIN = "login"
private const val DIRECTORY = "directory"
private const val CHAT = "chat/{conversationId}"
private const val BOT_DETAILS = "bot/{conversationId}/details"
private const val PROFILE = "conversation/{conversationId}/profile"
private const val CREATE = "conversation/create"
private const val COMPUTER = "bot/{conversationId}/computer"
private const val MARKETPLACE = "marketplace"
private const val ROUTINES = "routines"
private const val ROUTINE_EDITOR = "routines/editor"
private const val SETTINGS = "settings"
private const val PROVIDERS = "providers"
private const val WEB_PROVIDERS = "web-providers"
private const val PLUGINS = "plugins"
private const val OUTBOX = "outbox"
private const val ACCOUNT = "account"
private const val SIDEBAR = "sidebar"
private const val MESSAGE_SEARCH = "message-search"
private const val NAVIGATION_TRANSITION_DURATION_MILLIS = 280

private enum class SignInStep { WELCOME, ENDPOINT, CREDENTIALS }

private val NavigationSpec = tween<androidx.compose.ui.unit.IntOffset>(NAVIGATION_TRANSITION_DURATION_MILLIS, easing = FastOutSlowInEasing)

/** Settings is a left-edge panel: it opens from the left and closes back to the left. */
private fun AnimatedContentTransitionScope<NavBackStackEntry>.isSettingsOpening() =
    initialState.destination.route == DIRECTORY && targetState.destination.route == SETTINGS

private fun AnimatedContentTransitionScope<NavBackStackEntry>.isSettingsClosing() =
    initialState.destination.route == SETTINGS && targetState.destination.route == DIRECTORY

/** [forward] means content travels right-to-left (the normal push direction). */
private fun AnimatedContentTransitionScope<NavBackStackEntry>.slideNav(forward: Boolean) = slideIntoContainer(
    if (forward) AnimatedContentTransitionScope.SlideDirection.Left else AnimatedContentTransitionScope.SlideDirection.Right,
    animationSpec = NavigationSpec,
)

private fun AnimatedContentTransitionScope<NavBackStackEntry>.slideNavOut(forward: Boolean) = slideOutOfContainer(
    if (forward) AnimatedContentTransitionScope.SlideDirection.Left else AnimatedContentTransitionScope.SlideDirection.Right,
    animationSpec = NavigationSpec,
)

@Composable
fun OpenTeamApp(appViewModel: AppViewModel = viewModel()) {
    val state by appViewModel.state.collectAsStateWithLifecycle()
    val voiceState by appViewModel.voiceState.collectAsStateWithLifecycle()
    val navController = rememberNavController()
    val context = LocalContext.current
    val microphonePermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) appViewModel.startVoice()
    }
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}

    LaunchedEffect(state.session) {
        if (
            state.session != null &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    LaunchedEffect(state.pendingExternalUrl) {
        state.pendingExternalUrl?.let { url ->
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            appViewModel.consumeExternalUrl()
        }
    }

    val shareActionLabel = if (state.features.settings.language == AppSettings.Language.Chinese) "分享" else "Share"
    LaunchedEffect(state.pendingOutgoingShare) {
        state.pendingOutgoingShare?.let { share ->
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = share.mimeType.ifBlank { "application/octet-stream" }
                putExtra(Intent.EXTRA_STREAM, NativeAttachmentPreview.contentUri(context, share.uri))
                putExtra(Intent.EXTRA_TEXT, share.fileName)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(Intent.createChooser(intent, "$shareActionLabel ${share.fileName}"))
            appViewModel.consumeOutgoingShare()
        }
    }

    LaunchedEffect(state.pendingLink, state.pendingVoiceShortcut, state.session) {
        if (state.session == null) return@LaunchedEffect
        val target = state.pendingLink
        if (target != null) {
            navController.navigate("chat/${target.conversationId}") { launchSingleTop = true }
            appViewModel.openConversation(target.conversationId, target.messageId)
            appViewModel.consumeDeepLink()
            if (state.pendingVoiceShortcut) {
                appViewModel.consumeVoiceShortcut()
                microphonePermission.launch(Manifest.permission.RECORD_AUDIO)
            }
        } else if (navController.currentDestination?.route == LOGIN) {
            navController.navigate(DIRECTORY) { popUpTo(LOGIN) { inclusive = true } }
        }
    }
    LaunchedEffect(state.pendingSystemAction, state.pendingSystemIdentifier, state.session) {
        val action = state.pendingSystemAction ?: return@LaunchedEffect
        if (state.session == null) return@LaunchedEffect
        when {
            action == "run-routine" -> {
                state.pendingSystemIdentifier?.let(appViewModel::runRoutineById)
                navController.navigate(ROUTINES)
            }
            action == "send-bot-task" -> {
                val conversation = state.conversations.firstOrNull { it.botId == state.pendingSystemIdentifier }
                if (conversation != null) {
                    appViewModel.openConversation(conversation.id)
                    state.pendingSystemPayload?.takeIf(String::isNotBlank)?.let(appViewModel::updateDraft)
                    navController.navigate("chat/${conversation.id}")
                } else {
                    navController.navigate(DIRECTORY)
                }
            }
            action == "find-messages" -> navController.navigate(MESSAGE_SEARCH)
            action == "open-bot" -> {
                val conversation = state.conversations.firstOrNull { it.botId == state.pendingSystemIdentifier }
                if (conversation != null) navController.navigate("bot/${conversation.id}/details")
                else navController.navigate(DIRECTORY)
            }
            action.contains("routine", ignoreCase = true) -> navController.navigate(ROUTINES)
            action.contains("plugin", ignoreCase = true) -> navController.navigate(PLUGINS)
            action.contains("settings", ignoreCase = true) -> navController.navigate(SETTINGS)
            else -> state.pendingSystemIdentifier?.let { identifier ->
                appViewModel.openConversation(identifier)
                navController.navigate("chat/$identifier")
            }
                ?: appViewModel.acceptShare(SharePayload(action, null, "text/plain"))
        }
        appViewModel.consumeSystemAction()
    }

    // Navigation Compose owns the back callback here so Android predictive-back gestures
    // can seek through the same slide transition used by normal navigation.
    if (state.restoringSession) {
        // Hold the first frame until the saved session is known. The NavHost start
        // destination is fixed at first composition, so it must not be built earlier.
        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background))
        return
    }
    CompositionLocalProvider(LocalAppLanguage provides state.features.settings.language) {
        NavHost(
            navController = navController,
            startDestination = if (state.session != null) DIRECTORY else LOGIN,
            enterTransition = { slideNav(forward = !isSettingsOpening()) },
            exitTransition = { slideNavOut(forward = !isSettingsOpening()) },
            popEnterTransition = { slideNav(forward = isSettingsClosing()) },
            popExitTransition = { slideNavOut(forward = isSettingsClosing()) },
        ) {
        composable(LOGIN) {
            SignInScreen(
                loading = state.loading,
                checkingServer = state.authChecking,
                validatedServer = state.validatedServer,
                error = state.error,
                onCheckServer = appViewModel::checkServer,
                onClearValidation = appViewModel::clearServerValidation,
                onContinue = appViewModel::signIn,
                onPreview = appViewModel::signInPreview,
            )
        }
        composable(DIRECTORY) {
            DirectoryScreen(
                accountName = state.session?.accountName.orEmpty(),
                rows = state.conversations,
                searchResults = state.searchResults,
                searchLoading = state.searchLoading,
                searchError = state.searchError,
                sidebar = state.sidebar,
                share = state.pendingShare,
                onOpen = { conversation ->
                    appViewModel.openConversation(conversation.id)
                    navController.navigate("chat/${conversation.id}")
                },
                onShareTarget = { conversationId ->
                    appViewModel.selectShareTarget(conversationId)
                    navController.navigate("chat/$conversationId")
                },
                onRoutines = { navController.navigate(CREATE) },
                onOutbox = { navController.navigate(OUTBOX) },
                onSettings = { navController.navigate(SETTINGS) { launchSingleTop = true } },
                onSearch = appViewModel::search,
                onClearSearch = appViewModel::clearSearch,
                onOpenSearchResult = { result ->
                    result.channelId?.let { conversationId ->
                        appViewModel.openConversation(conversationId, result.messageId)
                        navController.navigate("chat/$conversationId")
                    }
                },
                onBotDetails = { conversation ->
                    navController.navigate("bot/${conversation.id}/details")
                },
                onTogglePin = appViewModel::togglePinned,
                onMoveToSection = { conversationId, sectionId ->
                    appViewModel.moveToSection(conversationId, sectionId)
                },
                onToggleSection = appViewModel::toggleSection,
            )
        }
        composable(BOT_DETAILS, arguments = listOf(navArgument("conversationId") { type = NavType.StringType })) { entry ->
            val id = entry.arguments?.getString("conversationId").orEmpty()
            val conversation = state.conversations.firstOrNull { it.id == id }
            val shareLabel = localizedText("Share bot", "分享机器人")
            BotDetailsScreen(
                conversation = conversation,
                onBack = { navController.popBackStack() },
                onOpenChat = {
                    appViewModel.openConversation(id)
                    navController.navigate("chat/$id")
                },
                onComputer = { navController.navigate("bot/$id/computer") },
                onRoutines = { navController.navigate(ROUTINES) },
                onEdit = { navController.navigate("conversation/$id/profile") },
                onHide = { appViewModel.setConversationHidden(it, true); navController.popBackStack() },
                onDelete = { appViewModel.deleteConversation(it); navController.navigate(DIRECTORY) { popUpTo(DIRECTORY) { inclusive = true } } },
                onDuplicate = { appViewModel.duplicateBot(it) },
                onNotifications = { row, enabled -> appViewModel.setBotNotifications(row, enabled) },
                onShare = {
                    conversation?.let {
                        context.startActivity(
                            Intent.createChooser(
                                Intent(Intent.ACTION_SEND).apply {
                                    type = "text/plain"
                                    putExtra(Intent.EXTRA_TEXT, it.title)
                                },
                                shareLabel,
                            ),
                        )
                    }
                },
            )
        }
        composable(CREATE) {
            CreateConversationScreen(
                bots = state.conversations.filter { it.isBot },
                onCreateBot = { name, description, instructions, icon, color ->
                    appViewModel.createBot(name, description, instructions, icon, color)
                    navController.popBackStack()
                },
                onCreateGroup = { name, botIds ->
                    appViewModel.createGroup(name, botIds)
                    navController.popBackStack()
                },
                onBack = { navController.popBackStack() },
            )
        }
        composable(PROFILE, arguments = listOf(navArgument("conversationId") { type = NavType.StringType })) { entry ->
            val id = entry.arguments?.getString("conversationId").orEmpty()
            val conversation = state.conversations.firstOrNull { it.id == id }
            ConversationProfileScreen(
                conversation = conversation,
                bots = state.conversations.filter { it.isBot },
                onSaveBot = { current, name, description, instructions, icon, color ->
                    appViewModel.updateBot(current, name, description, instructions, icon, color)
                    navController.popBackStack()
                },
                onSaveGroup = { current, name, description, botIds ->
                    appViewModel.updateGroup(current, name, description, botIds)
                    navController.popBackStack()
                },
                onBack = { navController.popBackStack() },
            )
        }
        composable(COMPUTER, arguments = listOf(navArgument("conversationId") { type = NavType.StringType })) { entry ->
            val id = entry.arguments?.getString("conversationId").orEmpty()
            val conversation = state.conversations.firstOrNull { it.id == id }
            ComputerViewerScreen(
                title = conversation?.title ?: localizedText("Cloud computer", "云电脑"),
                botId = conversation?.botId.orEmpty(),
                server = state.session?.server,
                requestGrant = appViewModel::requestComputerGrant,
                requestStatus = appViewModel::computerStatus,
                setTakeover = appViewModel::setComputerTakeover,
                setPaused = appViewModel::setComputerPaused,
                sendAction = appViewModel::sendComputerAction,
                sendClipboard = appViewModel::sendComputerClipboard,
                onBack = { navController.popBackStack() },
            )
        }
        composable(CHAT, arguments = listOf(navArgument("conversationId") { type = NavType.StringType })) { entry ->
            val id = entry.arguments?.getString("conversationId").orEmpty()
            val conversation = state.conversations.firstOrNull { it.id == id }
            LaunchedEffect(id) { if (state.activeConversationId != id) appViewModel.openConversation(id) }
            ChatScreen(
                conversationId = id,
                title = conversation?.title ?: localizedText("Conversation", "对话"),
                messages = state.messages,
                targetMessageId = state.activeMessageId,
                draft = state.draft,
                replyingTo = state.replyingTo,
                onReply = appViewModel::startReply,
                onCancelReply = appViewModel::cancelReply,
                onOpenRoutine = { navController.navigate(ROUTINES) },
                error = state.error,
                onBack = { navController.popBackStack() },
                onBotDetails = { navController.navigate("bot/$id/details") },
                onDraftChange = appViewModel::updateDraft,
                onSend = appViewModel::sendDraft,
                onRetry = appViewModel::retryMessage,
                voiceState = voiceState,
                onStartVoice = { microphonePermission.launch(Manifest.permission.RECORD_AUDIO) },
                onStopVoice = appViewModel::stopVoice,
                onRetryVoice = appViewModel::retryVoice,
                onCancelVoice = appViewModel::cancelVoice,
                operation = state.features.operation,
                pendingAttachments = state.pendingAttachments,
                hasMoreHistory = state.hasMoreHistory,
                historyLoading = state.historyLoading,
                conversations = state.conversations,
                onLoadOlder = appViewModel::loadOlderHistory,
                onUpload = appViewModel::uploadChatAttachment,
                onDownload = appViewModel::downloadChatAttachment,
                onSaveAttachment = appViewModel::saveChatAttachment,
                onShareAttachment = appViewModel::shareChatAttachment,
                onForwardAttachment = appViewModel::forwardChatAttachment,
                onAction = appViewModel::submitChatAction,
                onReaction = appViewModel::reactToChatMessage,
                onMessageAction = appViewModel::mutateChatMessage,
                onContext = appViewModel::loadMessageContext,
                threadContext = state.threadContext,
                threadContextTruncated = state.threadContextTruncated,
                activity = state.activity,
                bot = conversation,
            )
        }
        composable(ROUTINES) {
            RoutinesScreen(
                state = state.features.routines,
                onRetry = appViewModel::loadFeatureData,
                onAdd = { appViewModel.startRoutineEditor(); navController.navigate(ROUTINE_EDITOR) },
                onEdit = { appViewModel.startRoutineEditor(it); navController.navigate(ROUTINE_EDITOR) },
                onToggle = appViewModel::toggleRoutine,
                onRun = appViewModel::runRoutine,
                onBack = { navController.popBackStack() },
            )
        }
        composable(ROUTINE_EDITOR) {
            val draft = state.features.routineDraft
            // Keep the last draft on screen while the pop animation plays; the ViewModel
            // clears it after a successful save or delete.
            var shown by remember { mutableStateOf(draft) }
            if (draft != null) shown = draft
            LaunchedEffect(draft == null) {
                if (draft == null && navController.currentDestination?.route == ROUTINE_EDITOR) {
                    navController.popBackStack()
                }
            }
            shown?.let { routine ->
                RoutineEditorScreen(
                    routine = routine,
                    onChange = appViewModel::updateRoutineDraft,
                    onSave = appViewModel::saveRoutine,
                    onBack = { navController.popBackStack() },
                    onDelete = routine.id.takeIf(String::isNotBlank)?.let { { appViewModel.deleteRoutine() } },
                    operation = state.features.operation,
                )
            }
        }
        composable(SETTINGS) {
            SettingsScreen(
                settings = state.features.settings,
                accountName = state.session?.accountName.orEmpty(),
                server = state.session?.server.orEmpty(),
                onChange = appViewModel::saveSettings,
                onSignOut = {
                    appViewModel.signOut()
                    navController.navigate(LOGIN) { popUpTo(navController.graph.id) { inclusive = true } }
                },
                onBack = { navController.popBackStack() },
                onProviders = { navController.navigate(PROVIDERS) },
                onWebProviders = { navController.navigate(WEB_PROVIDERS) },
                onOutbox = { navController.navigate(OUTBOX) },
                onAccount = { navController.navigate(ACCOUNT) },
                onPlugins = { navController.navigate(PLUGINS) },
                onSidebar = { navController.navigate(SIDEBAR) },
            )
        }
        composable(OUTBOX) {
            OutboxScreen(
                items = state.outbox,
                onRetry = appViewModel::retryQueuedMessage,
                onDiscard = appViewModel::discardQueuedMessage,
                onBack = { navController.popBackStack() },
            )
        }
        composable(ACCOUNT) {
            AccountMemoryScreen(
                state = state.features.account,
                onRetry = appViewModel::loadFeatureData,
                onEditMemory = {},
                onClearMemory = appViewModel::clearMemory,
                onReset = appViewModel::resetLocalData,
                onSignOut = {
                    appViewModel.signOut()
                    navController.navigate(LOGIN) { popUpTo(navController.graph.id) { inclusive = true } }
                },
                onBack = { navController.popBackStack() },
            )
        }
        composable(SIDEBAR) {
            SidebarManagementScreen(
                sidebar = state.sidebar,
                hidden = state.hiddenConversations,
                onRename = appViewModel::renameSection,
                onDeleteSection = appViewModel::deleteSection,
                onUnhide = { appViewModel.setConversationHidden(it, false) },
                onDeleteConversation = appViewModel::deleteConversation,
                onBack = { navController.popBackStack() },
            )
        }
        composable(MESSAGE_SEARCH) {
            MessageSearchScreen(
                results = state.searchResults,
                loading = state.searchLoading,
                error = state.searchError,
                conversations = state.conversations,
                onSearch = { query -> appViewModel.search(query, "messages") },
                onOpen = { result ->
                    result.channelId?.let { channelId ->
                        appViewModel.openConversation(channelId, result.messageId)
                        navController.navigate("chat/$channelId")
                    }
                },
                onBack = { navController.popBackStack() },
            )
        }
        composable(PROVIDERS) {
            ProviderSettingsScreen(
                state = state.features.providers,
                onRetry = appViewModel::loadFeatureData,
                onBack = { navController.popBackStack() },
                language = state.features.settings.language,
                onConnect = appViewModel::connectProvider,
                onDisconnect = appViewModel::disconnectProvider,
                onModelChange = { provider, model -> appViewModel.connectProvider(provider.copy(selectedModel = model)) },
                onReasoningChange = { provider, reasoning -> appViewModel.connectProvider(provider.copy(selectedReasoning = reasoning)) },
            )
        }
        composable(WEB_PROVIDERS) {
            WebProviderSettingsScreen(
                state = state.features.webProviders,
                onRetry = appViewModel::loadFeatureData,
                onBack = { navController.popBackStack() },
                language = state.features.settings.language,
                onSelect = appViewModel::selectWebProvider,
                onSaveKey = { tool, provider, key -> appViewModel.saveWebProvider(tool, provider, key) },
                onRemoveKey = { tool, provider -> appViewModel.saveWebProvider(tool, provider, "") },
                onCheck = appViewModel::checkWebProvider,
            )
        }
        composable(PLUGINS) {
            PluginsScreen(
                state = state.features.plugins,
                onRetry = appViewModel::loadFeatureData,
                onInstall = appViewModel::installPlugin,
                onUpdate = appViewModel::updatePlugin,
                onRollback = appViewModel::rollbackPlugin,
                onAuthorize = appViewModel::authorizePlugin,
                onCancelAuthorization = appViewModel::cancelPluginAuthorization,
                onConfigure = appViewModel::configurePlugin,
                onTestTool = appViewModel::testPluginTool,
                onBack = { navController.popBackStack() },
            )
        }
        composable(MARKETPLACE) {
            MarketplaceScreen(
                state = state.features.plugins,
                onBack = { navController.popBackStack() },
                onOpenExtensions = { navController.navigate(PLUGINS) },
            )
        }
        }
    }
}

@Composable
private fun OutboxScreen(
    items: List<PendingSend>,
    onRetry: (String) -> Unit,
    onDiscard: (String) -> Unit,
    onBack: () -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = localizedText("Back", "返回"))
                    }
                },
                title = { Text(localizedText("Outbox", "发件箱")) },
                colors = featureTopBarColors(),
            )
        },
        containerColor = MaterialTheme.colorScheme.surfaceVariant,
    ) { padding ->
        if (items.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Text(localizedText("All messages have been delivered.", "所有消息都已发送。"), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            LazyColumn(
                Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 16.dp),
            ) {
                items(items, key = PendingSend::id) { item ->
                    Card(Modifier.fillMaxWidth(), colors = featureCardColors()) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(item.content.ifBlank { "Attachment-only message" }, fontWeight = FontWeight.Medium)
                            Text(localizedText("Conversation: ${item.channelId}", "对话：${item.channelId}"), style = MaterialTheme.typography.labelSmall)
                            if (item.attachments.isNotEmpty()) {
                                Text(
                                    item.attachments.joinToString(", ") { attachment ->
                                        "${attachment.fileName} (${attachment.mimeType})"
                                    },
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                            Text(
                                item.failure?.let { localizedText("Failed: $it", "失败：$it") } ?: localizedText("Queued for delivery", "已排队等待发送"),
                                color = if (item.failure == null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodySmall,
                            )
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                TextButton(onClick = { onRetry(item.id) }) { Text(localizedText("Retry", "重试")) }
                                TextButton(onClick = { onDiscard(item.id) }) {
                                    Text(localizedText("Discard", "丢弃"), color = MaterialTheme.colorScheme.error)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SidebarManagementScreen(
    sidebar: SidebarPreferences,
    hidden: List<Conversation>,
    onRename: (String, String) -> Unit,
    onDeleteSection: (String) -> Unit,
    onUnhide: (Conversation) -> Unit,
    onDeleteConversation: (Conversation) -> Unit,
    onBack: () -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, localizedText("Back", "返回")) } },
                title = { Text(localizedText("Organize conversations", "整理对话")) },
                colors = featureTopBarColors(),
            )
        },
        containerColor = MaterialTheme.colorScheme.surfaceVariant,
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 16.dp),
        ) {
            item { Text(localizedText("Sections", "分区"), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold) }
            if (sidebar.sections.isEmpty()) {
                item { Text(localizedText("No custom sections yet.", "还没有自定义分区。"), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            items(sidebar.sections, key = { "section:${it.id}" }) { section ->
                var name by remember(section.id, section.name) { mutableStateOf(section.name) }
                Card(Modifier.fillMaxWidth(), colors = featureCardColors()) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(name, { name = it }, label = { Text(localizedText("Section name", "分区名称")) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { onRename(section.id, name) }, enabled = name.trim().isNotEmpty()) { Text(localizedText("Save", "保存")) }
                        TextButton(onClick = { onDeleteSection(section.id) }) {
                            Text(localizedText("Delete", "删除"), color = MaterialTheme.colorScheme.error)
                        }
                        }
                    }
                }
            }
            item {
                Spacer(Modifier.height(8.dp))
                Text(localizedText("Hidden conversations", "隐藏的对话"), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            }
            if (hidden.isEmpty()) {
                item { Text(localizedText("No hidden conversations.", "没有隐藏的对话。"), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            items(hidden, key = { "hidden:${it.id}" }) { conversation ->
                Card(Modifier.fillMaxWidth(), colors = featureCardColors()) {
                    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(conversation.title, fontWeight = FontWeight.Medium)
                            Text(conversation.subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        TextButton(onClick = { onUnhide(conversation) }) { Text(localizedText("Unhide", "取消隐藏")) }
                        TextButton(onClick = { onDeleteConversation(conversation) }) {
                            Text(localizedText("Delete", "删除"), color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MessageSearchScreen(
    results: List<SearchResult>,
    loading: Boolean,
    error: String?,
    conversations: List<Conversation>,
    onSearch: (String) -> Unit,
    onOpen: (SearchResult) -> Unit,
    onBack: () -> Unit,
) {
    var query by remember { mutableStateOf("") }
    LaunchedEffect(query) { onSearch(query) }
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, localizedText("Back", "返回")) } },
                title = { Text(localizedText("Find messages", "查找消息")) },
                colors = featureTopBarColors(),
            )
        },
        containerColor = MaterialTheme.colorScheme.surfaceVariant,
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
            OutlinedTextField(
                query,
                { query = it },
                label = { Text(localizedText("Search messages", "搜索消息")) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            Spacer(Modifier.height(12.dp))
            if (loading) {
                CircularProgressIndicator()
            } else if (error != null) {
                Text(error, color = MaterialTheme.colorScheme.error)
            } else if (query.isBlank()) {
                Text(localizedText("Enter a phrase to search messages.", "输入要搜索的内容。"), color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                SearchResultsList(
                    results = results,
                    loading = loading,
                    error = error,
                    conversations = conversations,
                    onSelect = onOpen,
                )
            }
        }
    }
}

@Composable
private fun SignInScreen(
    loading: Boolean,
    checkingServer: Boolean,
    validatedServer: String?,
    error: String?,
    onCheckServer: (String) -> Unit,
    onClearValidation: () -> Unit,
    onContinue: (String, String, String) -> Unit,
    onPreview: (String, String, String) -> Unit,
) {
    var step by remember { mutableStateOf(SignInStep.WELCOME) }
    var server by remember { mutableStateOf("") }
    var username by remember { mutableStateOf("") }
    var credential by remember { mutableStateOf("") }
    var showingPassword by remember { mutableStateOf(false) }
    var showingInstall by remember { mutableStateOf(false) }
    val scrollState = rememberScrollState()
    val resolvedServer = validatedServer ?: server.trim()

    Column(
        Modifier.fillMaxSize()
            .background(
                Brush.verticalGradient(
                    listOf(
                        MaterialTheme.colorScheme.secondaryContainer.copy(alpha = .34f),
                        MaterialTheme.colorScheme.background,
                        MaterialTheme.colorScheme.background,
                    ),
                ),
            )
            .imePadding()
            .windowInsetsPadding(WindowInsets.statusBars)
            .verticalScroll(scrollState)
            .padding(horizontal = 22.dp, vertical = 18.dp),
    ) {
        AnimatedContent(
            targetState = step,
            transitionSpec = {
                val forward = targetState.ordinal > initialState.ordinal
                val spec = tween<androidx.compose.ui.unit.IntOffset>(NAVIGATION_TRANSITION_DURATION_MILLIS, easing = FastOutSlowInEasing)
                (slideInHorizontally(spec) { if (forward) it / 3 else -it / 3 } + fadeIn()) togetherWith
                    (slideOutHorizontally(spec) { if (forward) -it / 3 else it / 3 } + fadeOut())
            },
            label = "sign-in-step",
        ) { currentStep ->
        Column {
        when (currentStep) {
            SignInStep.WELCOME -> {
                IosWizardHero(stage = "server")
                Spacer(Modifier.height(12.dp))
                Text(
                    stringResource(com.openteam.android.R.string.login_welcome_title),
                    modifier = Modifier.testTag("login-welcome-title"),
                    style = MaterialTheme.typography.headlineLarge,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    stringResource(com.openteam.android.R.string.login_welcome_detail),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyLarge,
                )
                Spacer(Modifier.height(22.dp))
                if (showingInstall) {
                    IosGroupedCard {
                        Text(stringResource(com.openteam.android.R.string.login_install_server), fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(8.dp))
                        Text(
                            stringResource(com.openteam.android.R.string.login_install_command),
                            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.horizontalScroll(rememberScrollState()),
                        )
                        Spacer(Modifier.height(8.dp))
                        Text(
                            stringResource(com.openteam.android.R.string.login_install_detail),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Spacer(Modifier.height(10.dp))
                }
                IosPrimaryButton(
                    label = stringResource(com.openteam.android.R.string.login_get_started),
                    onClick = { step = SignInStep.ENDPOINT },
                    enabled = !loading,
                    testTag = "get-started",
                )
                TextButton(
                    onClick = { showingInstall = !showingInstall },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !loading,
                ) {
                    Text(
                        stringResource(
                            if (showingInstall) com.openteam.android.R.string.login_have_server
                            else com.openteam.android.R.string.login_install_hint,
                        ),
                    )
                }
                Spacer(Modifier.height(8.dp))
                TextButton(
                    onClick = { onPreview("", "", "") },
                    modifier = Modifier.fillMaxWidth().testTag("preview-workspace"),
                    enabled = !loading,
                ) { Text(stringResource(com.openteam.android.R.string.login_sample)) }
                Text(
                    stringResource(com.openteam.android.R.string.login_sample_detail),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            SignInStep.ENDPOINT -> {
                IosWizardTopBar(onBack = { step = SignInStep.WELCOME })
                IosWizardHero(stage = "endpoint")
                IosWizardHeader(
                    title = stringResource(com.openteam.android.R.string.login_server_title),
                    detail = stringResource(com.openteam.android.R.string.login_server_detail),
                )
                Spacer(Modifier.height(16.dp))
                IosGroupedCard {
                    OutlinedTextField(
                        value = server,
                        onValueChange = {
                            server = it
                            if (validatedServer != null) onClearValidation()
                        },
                        modifier = Modifier.fillMaxWidth().testTag("server-field"),
                        label = { Text(stringResource(com.openteam.android.R.string.login_server_address)) },
                        placeholder = { Text(stringResource(com.openteam.android.R.string.login_server_placeholder)) },
                        singleLine = true,
                        trailingIcon = {
                            if (server.isNotEmpty() && !checkingServer) {
                                IconButton(onClick = { server = "" }) {
                                    Icon(Icons.Default.Close, contentDescription = stringResource(com.openteam.android.R.string.login_clear_server))
                                }
                            }
                        },
                    )
                    if (checkingServer) {
                        WizardStatusLine(
                            stringResource(com.openteam.android.R.string.login_connecting) + " " + server.trim(),
                            loading = true,
                        )
                    } else if (validatedServer != null) {
                        WizardStatusLine(
                            stringResource(
                                com.openteam.android.R.string.login_server_found,
                                resolvedServer.removePrefix("https://").removePrefix("http://"),
                            ),
                            done = true,
                        )
                    }
                }
                if (error != null) {
                    Spacer(Modifier.height(10.dp))
                    IosErrorNotice(error)
                }
                Spacer(Modifier.height(10.dp))
                Text(
                    stringResource(com.openteam.android.R.string.login_server_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (server.trim().startsWith("http://", ignoreCase = true)) {
                    Text(
                        stringResource(com.openteam.android.R.string.login_http_warning),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
                Spacer(Modifier.height(18.dp))
                val serverValidated = validatedServer != null
                IosPrimaryButton(
                    label = stringResource(
                        when {
                            serverValidated -> com.openteam.android.R.string.login_connection_successful
                            checkingServer -> com.openteam.android.R.string.login_connecting
                            else -> com.openteam.android.R.string.login_connect
                        },
                    ),
                    onClick = { onCheckServer(server) },
                    enabled = !serverValidated && server.isNotBlank() && !checkingServer && !loading,
                    testTag = "connect-button",
                    busy = checkingServer,
                    success = serverValidated,
                )
                if (checkingServer) {
                    TextButton(onClick = { step = SignInStep.ENDPOINT }, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(com.openteam.android.R.string.login_cancel))
                    }
                } else if (validatedServer != null) {
                    Spacer(Modifier.height(8.dp))
                    IosSecondaryButton(
                        label = stringResource(com.openteam.android.R.string.login_continue_credentials),
                        onClick = { step = SignInStep.CREDENTIALS },
                        enabled = !loading,
                    )
                }
            }
            SignInStep.CREDENTIALS -> {
                IosWizardTopBar(onBack = { step = SignInStep.ENDPOINT })
                IosWizardHero(stage = "credentials")
                IosWizardHeader(
                    title = stringResource(com.openteam.android.R.string.login_credentials_title),
                    detail = stringResource(com.openteam.android.R.string.login_credentials_detail),
                )
                Spacer(Modifier.height(12.dp))
                ServerChip(resolvedServer)
                Spacer(Modifier.height(12.dp))
                IosGroupedCard {
                    OutlinedTextField(
                        value = username,
                        onValueChange = { username = it },
                        modifier = Modifier.fillMaxWidth().testTag("username-field"),
                        label = { Text(stringResource(com.openteam.android.R.string.login_username)) },
                        singleLine = true,
                    )
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(
                        value = credential,
                        onValueChange = { credential = it },
                        modifier = Modifier.fillMaxWidth().testTag("credential-field"),
                        label = { Text(stringResource(com.openteam.android.R.string.login_credential)) },
                        singleLine = true,
                        visualTransformation = if (showingPassword) androidx.compose.ui.text.input.VisualTransformation.None else PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        trailingIcon = {
                            TextButton(onClick = { showingPassword = !showingPassword }) {
                                Text(
                                    stringResource(
                                        if (showingPassword) com.openteam.android.R.string.login_hide
                                        else com.openteam.android.R.string.login_show,
                                    ),
                                )
                            }
                        },
                    )
                }
                if (error != null) {
                    Spacer(Modifier.height(10.dp))
                    IosErrorNotice(error)
                }
                Spacer(Modifier.height(10.dp))
                Text(
                    stringResource(com.openteam.android.R.string.login_forgot),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (resolvedServer.startsWith("http://", ignoreCase = true)) {
                    Text(
                        stringResource(com.openteam.android.R.string.login_credential_http_warning),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
                Spacer(Modifier.height(18.dp))
                IosPrimaryButton(
                    label = stringResource(
                        if (loading) com.openteam.android.R.string.login_signing_in
                        else com.openteam.android.R.string.login_sign_in,
                    ),
                    onClick = { onContinue(resolvedServer, username, credential) },
                    enabled = username.isNotBlank() && credential.isNotBlank() && !loading,
                    testTag = "sign-in-button",
                    busy = loading,
                )
            }
        }
        }
        }
    }
}

@Composable
private fun IosWizardHero(stage: String) {
    val accent = when (stage) {
        "credentials" -> Color(0xFF7C4DFF)
        "endpoint" -> Color(0xFF2F6FEB)
        else -> Color(0xFF12A4B4)
    }
    Box(
        Modifier.fillMaxWidth().height(188.dp).clip(RoundedCornerShape(32.dp))
            .background(
                Brush.linearGradient(
                    listOf(
                        accent.copy(alpha = .24f),
                        MaterialTheme.colorScheme.secondaryContainer.copy(alpha = .8f),
                        MaterialTheme.colorScheme.surface,
                    ),
                ),
            ),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier.size(104.dp).offset(x = (-78).dp, y = 16.dp).clip(CircleShape)
                .background(accent.copy(alpha = .78f)),
        )
        Box(
            Modifier.size(82.dp).offset(x = 86.dp, y = (-18).dp).clip(CircleShape)
                .background(MaterialTheme.colorScheme.primary.copy(alpha = .85f)),
        )
        Card(
            Modifier.width(260.dp).rotate(-2f),
            colors = CardDefaults.cardColors(containerColor = Color(0xFF17171A)),
            shape = RoundedCornerShape(16.dp),
        ) {
            Column(Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
                Text("●  ●  ●   Terminal", color = Color.White.copy(alpha = .55f), style = MaterialTheme.typography.labelSmall)
                Spacer(Modifier.height(8.dp))
                Text("$ openteam setup", color = Color.White.copy(alpha = .48f), fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                Text("✓ ${localizedText("OpenTeam is ready", "OpenTeam 已就绪")}", color = Color(0xFF3DDC84), fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                Text("Server   192.168.1.20:8787", color = Color.White.copy(alpha = .88f), fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun IosWizardTopBar(onBack: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack, modifier = Modifier.testTag("wizard-back")) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = localizedText("Back to conversations", "返回对话列表"))
        }
        Spacer(Modifier.weight(1f))
        Text(stringResource(com.openteam.android.R.string.app_name), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun IosWizardHeader(title: String, detail: String) {
    Text(title, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(6.dp))
    Text(detail, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun IosGroupedCard(content: @Composable ColumnScope.() -> Unit) {
    Card(
        Modifier.fillMaxWidth().animateContentSize(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = .55f)),
        shape = RoundedCornerShape(22.dp),
        content = { Column(Modifier.padding(12.dp), content = content) },
    )
}

@Composable
private fun IosPrimaryButton(
    label: String,
    onClick: () -> Unit,
    enabled: Boolean,
    testTag: String,
    busy: Boolean = false,
    success: Boolean = false,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().testTag(testTag),
        shape = RoundedCornerShape(16.dp),
        colors = androidx.compose.material3.ButtonDefaults.buttonColors(
            containerColor = if (success) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.primary,
            contentColor = if (success) MaterialTheme.colorScheme.onTertiary else MaterialTheme.colorScheme.onPrimary,
            disabledContainerColor = if (success) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.primary,
            disabledContentColor = if (success) MaterialTheme.colorScheme.onTertiary else MaterialTheme.colorScheme.onPrimary,
        ),
    ) {
        if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        else Text(label)
    }
}

@Composable
private fun IosSecondaryButton(label: String, onClick: () -> Unit, enabled: Boolean) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
    ) { Text(label) }
}

@Composable
private fun WizardStatusLine(text: String, loading: Boolean = false, done: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        when {
            loading -> CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            done -> Icon(Icons.Default.CheckCircle, contentDescription = null, tint = MaterialTheme.colorScheme.tertiary, modifier = Modifier.size(18.dp))
        }
        Spacer(Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun IosErrorNotice(message: String) {
    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.error.copy(alpha = .09f)),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.error.copy(alpha = .28f)),
        shape = RoundedCornerShape(14.dp),
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.Top) {
            Icon(Icons.Default.Close, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text(message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun ServerChip(server: String) {
    Text(
        server.removePrefix("https://").removePrefix("http://"),
        modifier = Modifier.clip(CircleShape)
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
private fun DirectoryScreen(
    accountName: String,
    rows: List<Conversation>,
    searchResults: List<SearchResult>,
    searchLoading: Boolean,
    searchError: String?,
    sidebar: SidebarPreferences,
    share: SharePayload?,
    onOpen: (Conversation) -> Unit,
    onShareTarget: (String) -> Unit,
    onRoutines: () -> Unit,
    onOutbox: () -> Unit,
    onSettings: () -> Unit,
    onSearch: (String, String) -> Unit,
    onClearSearch: () -> Unit,
    onOpenSearchResult: (SearchResult) -> Unit,
    onBotDetails: (Conversation) -> Unit,
    onTogglePin: (String) -> Unit,
    onMoveToSection: (String, String?) -> Unit,
    onToggleSection: (String?) -> Unit,
) {
    var searchVisible by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    var searchFilter by remember { mutableStateOf(SearchFilter.All) }
    var rowMenuId by remember { mutableStateOf<String?>(null) }
    val searchFocusRequester = remember { FocusRequester() }
    val keyboardController = LocalSoftwareKeyboardController.current
    val activity = LocalContext.current as? ComponentActivity
    // Only manually pinned chats appear in the top row, and they are removed from the
    // grouped list below so each chat is shown in exactly one place.
    val grouped = remember(rows, sidebar) { groupConversations(rows, sidebar) }
    val pinnedRows = grouped.pinned
    val unassignedRows = grouped.unassigned
    val showSectionHeadings = grouped.showUnassignedHeading
    val settingsLabel = localizedText("Settings", "设置")
    val closeSearch = {
        keyboardController?.hide()
        searchVisible = false
        query = ""
        searchFilter = SearchFilter.All
        onClearSearch()
    }
    BackHandler(enabled = searchVisible) {
        closeSearch()
    }
    DisposableEffect(activity, searchVisible) {
        if (activity == null || !searchVisible || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            onDispose { }
        } else {
            val callback = OnBackInvokedCallback { closeSearch() }
            activity.onBackInvokedDispatcher.registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_OVERLAY,
                callback,
            )
            onDispose {
                activity.onBackInvokedDispatcher.unregisterOnBackInvokedCallback(callback)
            }
        }
    }
    LaunchedEffect(searchVisible, query, searchFilter) {
        if (searchVisible) onSearch(query, searchFilter.apiValue) else onClearSearch()
    }
    LaunchedEffect(searchVisible) {
        if (searchVisible) searchFocusRequester.requestFocus()
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    if (searchVisible) {
                        Text(localizedText("Search Content", "搜索内容"))
                    }
                },
                navigationIcon = {
                    if (!searchVisible) {
                        IconButton(
                            onClick = onSettings,
                            modifier = Modifier.padding(start = 10.dp).size(48.dp).semantics {
                                contentDescription = settingsLabel
                            },
                        ) {
                            Box(
                                Modifier.size(36.dp).clip(CircleShape)
                                    .background(MaterialTheme.colorScheme.onSurface.copy(alpha = .13f)),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    accountName.take(1).uppercase().ifBlank { "O" },
                                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = .65f),
                                    fontWeight = FontWeight.Medium,
                                    style = MaterialTheme.typography.titleLarge,
                                )
                            }
                        }
                    }
                },
                actions = {
                    if (!searchVisible) {
                        IosChromeIcon(
                            icon = { Icon(Icons.Default.Refresh, contentDescription = null) },
                            contentDescription = localizedText("Outbox", "发件箱"),
                            onClick = onOutbox,
                        )
                        IosChromeIcon(
                            icon = { Icon(Icons.Default.Add, contentDescription = null) },
                            contentDescription = localizedText("Create conversation", "创建对话"),
                            onClick = onRoutines,
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant,
                    scrolledContainerColor = MaterialTheme.colorScheme.surfaceVariant,
                ),
            )
        },
        bottomBar = {
            if (searchVisible) {
                ExpandedSearchBar(
                    query = query,
                    onQueryChange = { query = it },
                    focusRequester = searchFocusRequester,
                    onClear = { query = "" },
                    onClose = closeSearch,
                )
            } else FloatingSearchBar(onClick = { searchVisible = true })
        },
        containerColor = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.pointerInput(searchVisible) {
            if (searchVisible) return@pointerInput
            // Settings lives off the left edge: dragging the list to the right pulls it in.
            val trigger = 72.dp.toPx()
            var total = 0f
            var fired = false
            detectHorizontalDragGestures(onDragStart = { total = 0f; fired = false }) { _, delta ->
                total += delta
                if (!fired && total >= trigger) { fired = true; onSettings() }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(horizontal = 20.dp)) {
            if (searchVisible) {
                SearchFilterRow(selected = searchFilter, onSelected = { searchFilter = it })
                Box(Modifier.fillMaxWidth().weight(1f)) {
                    if (query.isNotBlank()) {
                        SearchResultsList(
                            results = searchResults,
                            loading = searchLoading,
                            error = searchError,
                            conversations = rows,
                            onSelect = onOpenSearchResult,
                        )
                    }
                }
            } else {
            if (pinnedRows.isNotEmpty()) {
                // The pinned bots form one group centered in the row. Once they no longer fit,
                // the row starts at the left edge and scrolls.
                LazyRow(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(18.dp, Alignment.CenterHorizontally),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(top = 8.dp, bottom = 10.dp),
                ) {
                    items(pinnedRows, key = { "pinned-${it.id}" }) { row ->
                        PinnedBotCard(
                            conversation = row,
                            unread = row.unread > 0 || sidebar.isUnread(row.id),
                            onClick = { if (share == null) onOpen(row) else onShareTarget(row.id) },
                            onLongClick = {
                                if (share == null) onTogglePin(row.id) else onShareTarget(row.id)
                            },
                        )
                    }
                }
            }
            if (share != null) {
                Spacer(Modifier.height(8.dp))
                Card(
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    shape = RoundedCornerShape(16.dp),
                ) {
                    Column(Modifier.padding(14.dp)) {
                        Text(localizedText("Share with a conversation", "选择一个对话进行分享"), fontWeight = FontWeight.SemiBold)
                        Text(
                            share.text?.takeIf { it.isNotBlank() }
                                ?: if (share.streams.size > 1) "${share.streams.size} attachments" else share.stream?.toString().orEmpty(),
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            LazyColumn(
                modifier = Modifier.fillMaxSize().testTag("directory-title"),
                verticalArrangement = Arrangement.spacedBy(0.dp),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 28.dp),
            ) {
                grouped.sections.forEach { group ->
                    val section = group.section
                    val members = group.conversations
                    item(key = "section-${section.id}") {
                        DirectorySectionHeader(
                            name = section.name,
                            collapsed = section.collapsed,
                            count = members.size,
                            onClick = { onToggleSection(section.id) },
                        )
                    }
                    if (!section.collapsed) {
                        items(members, key = Conversation::id) { row ->
                            DirectoryConversationRow(
                                row = row,
                                unread = row.unread > 0 || sidebar.isUnread(row.id),
                                pinned = false,
                                sections = sidebar.sections,
                                shareActive = share != null,
                                menuExpanded = rowMenuId == row.id,
                                onOpen = { onOpen(row) },
                                onShareTarget = { onShareTarget(row.id) },
                                onBotDetails = { onBotDetails(row) },
                                onTogglePin = { onTogglePin(row.id) },
                                onMoveToSection = { sectionId -> onMoveToSection(row.id, sectionId) },
                                onOpenMenu = { rowMenuId = row.id },
                                onDismissMenu = { rowMenuId = null },
                            )
                        }
                    }
                }
                if (showSectionHeadings) {
                    item(key = "section-unassigned") {
                        DirectorySectionHeader(
                            name = localizedText("Unassigned", "未分组"),
                            collapsed = sidebar.unassignedCollapsed,
                            count = unassignedRows.size,
                            onClick = { onToggleSection(null) },
                        )
                    }
                }
                if (!showSectionHeadings || !sidebar.unassignedCollapsed) {
                    items(unassignedRows, key = Conversation::id) { row ->
                        DirectoryConversationRow(
                            row = row,
                            unread = row.unread > 0 || sidebar.isUnread(row.id),
                            pinned = false,
                            sections = sidebar.sections,
                            shareActive = share != null,
                            menuExpanded = rowMenuId == row.id,
                            onOpen = { onOpen(row) },
                            onShareTarget = { onShareTarget(row.id) },
                            onBotDetails = { onBotDetails(row) },
                            onTogglePin = { onTogglePin(row.id) },
                            onMoveToSection = { sectionId -> onMoveToSection(row.id, sectionId) },
                            onOpenMenu = { rowMenuId = row.id },
                            onDismissMenu = { rowMenuId = null },
                        )
                    }
                }
            }
            }
        }
    }
}

@Composable
private fun SearchResultsList(
    results: List<SearchResult>,
    loading: Boolean,
    error: String?,
    conversations: List<Conversation>,
    onSelect: (SearchResult) -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(0.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 28.dp),
    ) {
        if (loading) {
            item(key = "search-loading") {
                Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
        }
        if (error != null) {
            item(key = "search-error") {
                Text(
                    error,
                    modifier = Modifier.fillMaxWidth().padding(20.dp),
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
        items(results, key = { "search-${it.kind}-${it.id}" }) { result ->
            SearchResultRow(
                result = result,
                conversation = conversations.firstOrNull { it.id == result.channelId },
                onClick = { onSelect(result) },
            )
        }
        if (!loading && error == null && results.isEmpty()) {
            item(key = "search-empty") {
                Text(
                    localizedText("No results", "没有找到结果"),
                    modifier = Modifier.fillMaxWidth().padding(20.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun SearchResultRow(
    result: SearchResult,
    conversation: Conversation?,
    onClick: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth()
            .clickable(enabled = result.channelId != null, onClick = onClick)
            .padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (conversation != null) {
            BotAvatar(conversation, size = 46.dp)
        } else {
            Box(
                Modifier.size(46.dp).clip(CircleShape)
                    .background(MaterialTheme.colorScheme.secondaryContainer),
                contentAlignment = Alignment.Center,
            ) {
                Text(result.title.take(1).uppercase().ifBlank { "O" })
            }
        }
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    result.title,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    localizedSearchResultKind(result.kind),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (result.subtitle.isNotBlank()) {
                Spacer(Modifier.height(2.dp))
                Text(
                    result.subtitle,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                )
            }
        }
    }
}

@Composable
private fun localizedSearchResultKind(kind: String): String = when (kind.lowercase(Locale.ROOT)) {
    "messages" -> localizedText("Messages", "消息")
    "bots" -> localizedText("Robots", "机器人")
    "channels" -> localizedText("Group chats", "群聊")
    "files" -> localizedText("Files", "文件")
    "routines" -> localizedText("Scheduled tasks", "定时任务")
    "links" -> localizedText("Other", "其他")
    else -> kind.replaceFirstChar { it.uppercase() }
}

private enum class SearchFilter(
    val apiValue: String,
    val englishLabel: String,
    val chineseLabel: String,
) {
    All("all", "All", "全部"),
    Messages("messages", "Messages", "消息"),
    Robots("bots", "Robots", "机器人"),
    Groups("channels", "Group chats", "群聊"),
    Files("files", "Files", "文件"),
    ScheduledTasks("routines", "Scheduled tasks", "定时任务"),
    Other("links", "Other", "其他"),
}

@Composable
private fun SearchFilterRow(selected: SearchFilter, onSelected: (SearchFilter) -> Unit) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())
            .padding(top = 4.dp, bottom = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SearchFilter.values().forEach { filter ->
            val active = filter == selected
            Text(
                localizedText(filter.englishLabel, filter.chineseLabel),
                modifier = Modifier.clip(CircleShape)
                    .background(
                        if (active) MaterialTheme.colorScheme.onSurface
                        else MaterialTheme.colorScheme.surface,
                    )
                    .clickable { onSelected(filter) }
                    .padding(horizontal = 18.dp, vertical = 11.dp),
                color = if (active) MaterialTheme.colorScheme.surface
                else MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.bodyLarge,
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun PinnedBotCard(
    conversation: Conversation,
    unread: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    Column(
        modifier = Modifier.width(100.dp)
            .testTag("pinned-${conversation.id}")
            .combinedClickable(onClick = onClick, onLongClick = onLongClick),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box {
            BotAvatar(conversation, size = 80.dp, showWorking = true)
            if (unread) {
                Box(
                    Modifier.align(Alignment.BottomEnd).size(13.dp).clip(CircleShape)
                        .background(MaterialTheme.colorScheme.secondary)
                        .border(2.dp, MaterialTheme.colorScheme.surfaceVariant, CircleShape),
                )
            }
        }
        Spacer(Modifier.height(7.dp))
        Text(
            conversation.title,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DirectoryConversationRow(
    row: Conversation,
    unread: Boolean,
    pinned: Boolean,
    sections: List<SidebarSection>,
    shareActive: Boolean,
    menuExpanded: Boolean,
    onOpen: () -> Unit,
    onShareTarget: () -> Unit,
    onBotDetails: () -> Unit,
    onTogglePin: () -> Unit,
    onMoveToSection: (String?) -> Unit,
    onOpenMenu: () -> Unit,
    onDismissMenu: () -> Unit,
) {
    val timestamp = conversationTimestampLabel(
        row.updatedAt,
        yesterday = localizedText("Yesterday", "昨天"),
    )
    Box {
        Row(
            modifier = Modifier.fillMaxWidth()
                .clip(RoundedCornerShape(18.dp))
                .testTag("conversation-${row.id}")
                .combinedClickable(
                    onClick = { if (shareActive) onShareTarget() else onOpen() },
                    onLongClick = { if (shareActive) onShareTarget() else onOpenMenu() },
                )
                .padding(vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BotAvatar(row, size = 46.dp, showWorking = true)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        row.title,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        modifier = Modifier.weight(1f),
                    )
                    if (timestamp != null) {
                        Spacer(Modifier.width(8.dp))
                        Text(
                            timestamp,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = .8f),
                        )
                    }
                }
                Spacer(Modifier.height(2.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        row.preview ?: localizedText("No messages yet", "还没有消息"),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        modifier = Modifier.weight(1f),
                    )
                    if (unread) {
                        Box(
                            Modifier.padding(start = 8.dp).size(10.dp).clip(CircleShape)
                                .background(MaterialTheme.colorScheme.secondary),
                        )
                    }
                }
            }
        }
        DropdownMenu(expanded = menuExpanded, onDismissRequest = onDismissMenu) {
            DropdownMenuItem(
                text = {
                    Text(
                        if (pinned) localizedText("Unpin", "取消置顶")
                        else localizedText("Pin to top", "置顶"),
                    )
                },
                onClick = { onDismissMenu(); onTogglePin() },
            )
            DropdownMenuItem(
                text = { Text(localizedText("Bot details", "机器人详情")) },
                onClick = { onDismissMenu(); onBotDetails() },
            )
            sections.forEach { section ->
                DropdownMenuItem(
                    text = { Text(localizedText("Move to \"${section.name}\"", "移动到「${section.name}」")) },
                    onClick = { onDismissMenu(); onMoveToSection(section.id) },
                )
            }
            DropdownMenuItem(
                text = { Text(localizedText("Unassigned", "未分组")) },
                onClick = { onDismissMenu(); onMoveToSection(null) },
            )
        }
    }
}

@Composable
private fun DirectorySectionHeader(
    name: String,
    collapsed: Boolean,
    count: Int,
    onClick: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(top = 18.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            if (collapsed) "$name $count" else name,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.width(6.dp))
        Icon(
            if (collapsed) Icons.AutoMirrored.Filled.KeyboardArrowRight else Icons.Default.KeyboardArrowDown,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = .6f),
            modifier = Modifier.size(16.dp),
        )
    }
}

private fun conversationTimestampLabel(iso: String?, yesterday: String): String? {
    if (iso.isNullOrBlank()) return null
    val zoned = runCatching { Instant.parse(iso).atZone(ZoneId.systemDefault()) }.getOrNull() ?: return null
    val date = zoned.toLocalDate()
    val today = LocalDate.now(zoned.zone)
    return when {
        date == today -> DateTimeFormatter.ofPattern("HH:mm", Locale.getDefault()).format(zoned)
        date == today.minusDays(1) -> yesterday
        date.isAfter(today.minusDays(7)) ->
            DateTimeFormatter.ofPattern("EEEE", Locale.getDefault()).format(zoned)
        else -> DateTimeFormatter.ofPattern("M/d/yy", Locale.getDefault()).format(zoned)
    }
}


@Composable
private fun BotAvatar(
    conversation: Conversation,
    size: androidx.compose.ui.unit.Dp,
    showWorking: Boolean = false,
    ringColor: Color = MaterialTheme.colorScheme.surfaceVariant,
) {
    val fill = conversation.avatarColor.toComposeColor()
        ?: MaterialTheme.colorScheme.secondaryContainer
    val avatar = rememberDecodedBitmap(conversation.avatarPath, maxSizePx = (size.value * 4).toInt())
    Box {
        if (avatar != null) {
            Image(
                bitmap = avatar,
                contentDescription = conversation.title,
                modifier = Modifier.size(size).clip(CircleShape),
                contentScale = androidx.compose.ui.layout.ContentScale.Crop,
            )
        } else {
            ServerBotAvatar(conversation.botIcon, fill, size)
        }
        if (showWorking && conversation.working) {
            val dot = (size.value * .26f).coerceIn(10f, 18f).dp
            Box(
                Modifier.align(Alignment.BottomEnd).size(dot).clip(CircleShape)
                    .background(Color(0xFF5BC67A))
                    .border(2.dp, ringColor, CircleShape)
                    .semantics { contentDescription = "Working" },
            )
        }
    }
}

@Composable
private fun ServerBotAvatar(icon: String, fill: Color, size: androidx.compose.ui.unit.Dp) {
    Canvas(Modifier.size(size).clip(CircleShape)) {
        drawCircle(fill)
        val edge = this.size.minDimension
        val face = if (fill.luminance() < .45f) Color.White else Color.Black
        val left = edge * .2f
        val top = edge * .2f
        val width = edge * .6f
        val height = edge * .57f
        when (icon.trim().lowercase()) {
            "tv-head", "dual-screen" -> drawRect(face, androidx.compose.ui.geometry.Offset(left, top), androidx.compose.ui.geometry.Size(width, height))
            "pod", "owl" -> drawOval(face, androidx.compose.ui.geometry.Offset(left, top), androidx.compose.ui.geometry.Size(width, height))
            else -> drawRoundRect(
                face,
                androidx.compose.ui.geometry.Offset(left, top),
                androidx.compose.ui.geometry.Size(width, height),
                androidx.compose.ui.geometry.CornerRadius(edge * .14f),
            )
        }
        if (icon.trim().lowercase() in setOf("terminal", "periscope", "helmet")) {
            drawLine(face, androidx.compose.ui.geometry.Offset(edge * .5f, top), androidx.compose.ui.geometry.Offset(edge * .5f, edge * .08f), strokeWidth = edge * .05f)
            drawCircle(face, radius = edge * .06f, center = androidx.compose.ui.geometry.Offset(edge * .5f, edge * .06f))
        }
        val eyeY = edge * .42f
        drawCircle(fill, radius = edge * .07f, center = androidx.compose.ui.geometry.Offset(edge * .38f, eyeY))
        drawCircle(fill, radius = edge * .07f, center = androidx.compose.ui.geometry.Offset(edge * .62f, eyeY))
        drawRoundRect(
            fill,
            androidx.compose.ui.geometry.Offset(edge * .38f, edge * .58f),
            androidx.compose.ui.geometry.Size(edge * .24f, edge * .06f),
            androidx.compose.ui.geometry.CornerRadius(edge * .03f),
        )
    }
}

private fun String.toComposeColor(): Color? {
    val value = trim().removePrefix("#")
    if (value.length != 6) return null
    return value.toLongOrNull(16)?.let { Color(it.toInt() or 0xFF000000.toInt()) }
}

@Composable
private fun FloatingSearchBar(onClick: () -> Unit) {
    Box(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 10.dp)
            .clip(RoundedCornerShape(28.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = .35f), RoundedCornerShape(28.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 13.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Search, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(12.dp))
            Text(
                localizedText("Search", "搜索"),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyLarge,
            )
        }
    }
}

@Composable
private fun ExpandedSearchBar(
    query: String,
    onQueryChange: (String) -> Unit,
    focusRequester: FocusRequester,
    onClear: () -> Unit,
    onClose: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().imePadding().padding(horizontal = 14.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OutlinedTextField(
            value = query,
            onValueChange = onQueryChange,
            modifier = Modifier.weight(1f).focusRequester(focusRequester),
            singleLine = true,
            placeholder = { Text(localizedText("Search", "搜索")) },
            leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
            trailingIcon = {
                if (query.isNotEmpty()) {
                    IconButton(onClick = onClear) {
                        Icon(
                            Icons.Default.Close,
                            contentDescription = localizedText("Clear", "清除"),
                        )
                    }
                }
            },
            shape = RoundedCornerShape(28.dp),
        )
        IconButton(
            onClick = onClose,
            modifier = Modifier.size(56.dp).clip(CircleShape)
                .background(MaterialTheme.colorScheme.surface)
                .border(
                    1.dp,
                    MaterialTheme.colorScheme.outline.copy(alpha = .35f),
                    CircleShape,
                ),
        ) {
            Icon(
                Icons.Default.Close,
                contentDescription = localizedText("Close search", "关闭搜索"),
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BotDetailsScreen(
    conversation: Conversation?,
    onBack: () -> Unit,
    onOpenChat: () -> Unit,
    onComputer: () -> Unit,
    onRoutines: () -> Unit,
    onEdit: () -> Unit,
    onHide: (Conversation) -> Unit,
    onDelete: (Conversation) -> Unit,
    onDuplicate: (Conversation) -> Unit,
    onNotifications: (Conversation, Boolean) -> Unit,
    onShare: () -> Unit,
) {
    var moreMenuVisible by remember { mutableStateOf(false) }
    var notificationsEnabled by remember(conversation?.id) { mutableStateOf(conversation?.notificationsEnabled ?: true) }
    val surface = MaterialTheme.colorScheme.surface
    val muted = MaterialTheme.colorScheme.onSurfaceVariant

    Column(
        Modifier.fillMaxSize()
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            ProfileChromeButton(
                contentDescription = localizedText("Back to conversations", "返回对话列表"),
                onClick = onBack,
            ) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null)
            }
            Spacer(Modifier.weight(1f))
            ProfileChromeButton(
                contentDescription = localizedText("Share bot", "分享机器人"),
                onClick = onShare,
            ) {
                Icon(Icons.Default.Share, contentDescription = null)
            }
            Box {
                ProfileChromeButton(
                    contentDescription = localizedText("More settings", "更多设置"),
                    onClick = { moreMenuVisible = true },
                ) {
                    Icon(Icons.Default.MoreHoriz, contentDescription = null)
                }
                DropdownMenu(
                    expanded = moreMenuVisible,
                    onDismissRequest = { moreMenuVisible = false },
                ) {
                    DropdownMenuItem(
                        text = { Text(localizedText("Open conversation", "打开对话")) },
                        onClick = { moreMenuVisible = false; onOpenChat() },
                    )
                    DropdownMenuItem(
                        text = { Text(localizedText("Edit profile", "编辑资料")) },
                        onClick = { moreMenuVisible = false; onEdit() },
                    )
                    conversation?.let { row ->
                        DropdownMenuItem(
                            text = { Text(localizedText("Duplicate bot", "复制机器人")) },
                            onClick = { moreMenuVisible = false; onDuplicate(row) },
                        )
                        DropdownMenuItem(
                            text = { Text(localizedText("Hide from sidebar", "从侧边栏隐藏")) },
                            onClick = { moreMenuVisible = false; onHide(row) },
                        )
                        DropdownMenuItem(
                            text = { Text(localizedText("Delete", "删除"), color = MaterialTheme.colorScheme.error) },
                            onClick = { moreMenuVisible = false; onDelete(row) },
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(24.dp))
        conversation?.let {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                BotAvatar(it, 96.dp)
                Spacer(Modifier.height(12.dp))
                Text(it.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(10.dp))
                Box(
                    Modifier.clip(CircleShape)
                        .background(MaterialTheme.colorScheme.secondaryContainer)
                        .clickable(onClick = onEdit)
                        .padding(horizontal = 18.dp, vertical = 9.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Edit, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text(localizedText("Edit", "编辑"), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                    }
                }
            }
        }

        Spacer(Modifier.height(28.dp))
        ProfileGroupedCard(surface) {
            ProfileCapabilityRow(
                icon = Icons.Default.AccessTime,
                title = localizedText("Scheduled routines", "定时任务"),
                status = localizedText("0 enabled", "已开启 0 个"),
                onClick = onRoutines,
            )
            ProfileDivider(muted)
            ProfileCapabilityRow(
                icon = Icons.Default.FolderOpen,
                title = localizedText("Library", "资料库"),
                status = null,
                onClick = onOpenChat,
            )
            ProfileDivider(muted)
            ProfileCapabilityRow(
                icon = Icons.Default.Computer,
                title = localizedText("Cloud computer", "云电脑"),
                status = localizedText("Idle", "空闲"),
                onClick = onComputer,
            )
        }

        Spacer(Modifier.height(18.dp))
        Column(
            Modifier.fillMaxWidth()
                .clip(RoundedCornerShape(20.dp))
                .background(surface)
                .border(1.dp, muted.copy(alpha = .12f), RoundedCornerShape(20.dp)),
        ) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Default.Notifications, contentDescription = null, tint = muted)
                Spacer(Modifier.width(14.dp))
                Text(
                    localizedText("Notifications", "通知"),
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier.weight(1f),
                )
                Switch(checked = notificationsEnabled, onCheckedChange = {
                    notificationsEnabled = it
                    conversation?.let { row -> onNotifications(row, it) }
                })
            }
        }
        Text(
            localizedText("The bot will notify you when work is ready for your attention.", "机器人完成任务或需要你处理时通知你。"),
            color = muted,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
        )
        Spacer(Modifier.height(12.dp))
    }
}

@Composable
private fun CreateConversationScreen(
    bots: List<Conversation>,
    onCreateBot: (String, String, String, String, String) -> Unit,
    onCreateGroup: (String, List<String>) -> Unit,
    onBack: () -> Unit,
) {
    var group by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var instructions by remember { mutableStateOf("") }
    var icon by remember { mutableStateOf("chip") }
    var color by remember { mutableStateOf("#A47952") }
    val selected = remember { mutableStateOf(emptySet<String>()) }
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, localizedText("Back", "返回")) } },
                title = { Text(if (group) localizedText("Create group", "创建群聊") else localizedText("Create bot", "创建机器人")) },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).padding(16.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = !group, onClick = { group = false }, label = { Text(localizedText("Bot", "机器人")) })
                FilterChip(selected = group, onClick = { group = true }, label = { Text(localizedText("Group", "群聊")) })
            }
            OutlinedTextField(name, { name = it }, label = { Text(localizedText("Name", "名称")) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            OutlinedTextField(description, { description = it }, label = { Text(localizedText("Description", "描述")) }, modifier = Modifier.fillMaxWidth())
            if (group) {
                Text(localizedText("Members", "成员"), fontWeight = FontWeight.SemiBold)
                bots.forEach { bot ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        androidx.compose.material3.Checkbox(
                            checked = bot.botId?.let(selected.value::contains) == true,
                            onCheckedChange = { checked ->
                                selected.value = if (checked) selected.value + bot.botId.orEmpty() else selected.value - bot.botId.orEmpty()
                            },
                        )
                        Text(bot.title)
                    }
                }
            } else {
                OutlinedTextField(instructions, { instructions = it }, label = { Text(localizedText("Instructions", "说明")) }, modifier = Modifier.fillMaxWidth(), minLines = 5)
                OutlinedTextField(icon, { icon = it }, label = { Text(localizedText("Icon", "图标")) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                OutlinedTextField(color, { color = it }, label = { Text(localizedText("Color (#RRGGBB)", "颜色（#RRGGBB）")) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            }
            Button(
                onClick = {
                    if (group) onCreateGroup(name, selected.value.filter(String::isNotBlank))
                    else onCreateBot(name, description, instructions, icon, color)
                },
                enabled = name.isNotBlank() && (!group || selected.value.isNotEmpty()),
                modifier = Modifier.fillMaxWidth(),
            ) { Text(localizedText("Create", "创建")) }
        }
    }
}

@Composable
private fun ConversationProfileScreen(
    conversation: Conversation?,
    bots: List<Conversation>,
    onSaveBot: (Conversation, String, String, String, String, String) -> Unit,
    onSaveGroup: (Conversation, String, String, List<String>) -> Unit,
    onBack: () -> Unit,
) {
    if (conversation == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text(localizedText("Conversation is unavailable.", "对话不可用。")) }
        return
    }
    var name by remember(conversation.id) { mutableStateOf(conversation.title) }
    var description by remember(conversation.id) { mutableStateOf(conversation.subtitle) }
    var instructions by remember { mutableStateOf("") }
    var icon by remember { mutableStateOf("chip") }
    var color by remember { mutableStateOf(conversation.avatarColor.ifBlank { "#A47952" }) }
    val selected = remember(conversation.id) { mutableStateOf(conversation.memberBotIds.toSet()) }
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, localizedText("Back", "返回")) } },
                title = { Text(localizedText("Edit profile", "编辑资料")) },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(name, { name = it }, label = { Text(localizedText("Name", "名称")) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            OutlinedTextField(description, { description = it }, label = { Text(localizedText("Description", "描述")) }, modifier = Modifier.fillMaxWidth())
            if (conversation.isGroup) {
                Text(localizedText("Members", "成员"), fontWeight = FontWeight.SemiBold)
                bots.forEach { bot ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        androidx.compose.material3.Checkbox(
                            checked = bot.botId?.let(selected.value::contains) == true,
                            onCheckedChange = { checked -> selected.value = if (checked) selected.value + bot.botId.orEmpty() else selected.value - bot.botId.orEmpty() },
                        )
                        Text(bot.title)
                    }
                }
            } else {
                OutlinedTextField(instructions, { instructions = it }, label = { Text(localizedText("Instructions", "说明")) }, modifier = Modifier.fillMaxWidth(), minLines = 5)
                OutlinedTextField(icon, { icon = it }, label = { Text(localizedText("Icon", "图标")) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                OutlinedTextField(color, { color = it }, label = { Text(localizedText("Color (#RRGGBB)", "颜色（#RRGGBB）")) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            }
            Button(
                onClick = {
                    if (conversation.isGroup) onSaveGroup(conversation, name, description, selected.value.toList())
                    else onSaveBot(conversation, name, description, instructions, icon, color)
                },
                enabled = name.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) { Text(localizedText("Save", "保存")) }
        }
    }
}

@Composable
private fun ProfileChromeButton(
    contentDescription: String,
    onClick: () -> Unit,
    content: @Composable () -> Unit,
) {
    IconButton(
        onClick = onClick,
        modifier = Modifier.size(48.dp)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.surface)
            .semantics { this.contentDescription = contentDescription },
    ) {
        content()
    }
}

@Composable
private fun ProfileGroupedCard(
    surface: Color,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(surface)
            .border(1.dp, MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = .12f), RoundedCornerShape(24.dp)),
        content = content,
    )
}

@Composable
private fun ProfileDivider(muted: Color) {
    HorizontalDivider(
        modifier = Modifier.padding(start = 56.dp),
        color = muted.copy(alpha = .12f),
    )
}

@Composable
private fun ProfileCapabilityRow(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    title: String,
    status: String?,
    onClick: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(24.dp))
        Spacer(Modifier.width(16.dp))
        Text(title, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        if (!status.isNullOrBlank()) {
            Text(status, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(10.dp))
        }
        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null, modifier = Modifier.rotate(180f), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun IosActionCard(
    title: String,
    detail: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    onClick: () -> Unit,
) {
    Card(
        Modifier.fillMaxWidth().clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(20.dp),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
    ) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(42.dp).clip(CircleShape).background(MaterialTheme.colorScheme.secondaryContainer),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, contentDescription = null)
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(title, fontWeight = FontWeight.Medium)
                Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null, modifier = Modifier.rotate(180f))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MarketplaceScreen(
    state: FeatureLoadState<List<Plugin>>,
    onBack: () -> Unit,
    onOpenExtensions: () -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(com.openteam.android.R.string.marketplace_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = localizedText("Back to conversations", "返回对话列表"))
                    }
                },
            )
        },
        containerColor = MaterialTheme.colorScheme.surfaceVariant,
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(stringResource(com.openteam.android.R.string.marketplace_detail), color = MaterialTheme.colorScheme.onSurfaceVariant)
            IosActionCard(
                title = stringResource(com.openteam.android.R.string.marketplace_extensions),
                detail = when (state) {
                    is FeatureLoadState.Ready -> stringResource(com.openteam.android.R.string.marketplace_extensions_count, state.value.size)
                    is FeatureLoadState.Loading -> stringResource(com.openteam.android.R.string.marketplace_loading)
                    is FeatureLoadState.Empty -> state.message
                    is FeatureLoadState.Failure -> state.message
                },
                icon = Icons.Default.Add,
                onClick = onOpenExtensions,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ComputerViewerScreen(
    title: String,
    botId: String,
    server: String?,
    requestGrant: suspend (String) -> Result<ComputerVncGrant>,
    requestStatus: suspend (String) -> Result<JsonObject>,
    setTakeover: suspend (String, Boolean) -> Result<JsonObject>,
    setPaused: suspend (String, Boolean) -> Result<JsonObject>,
    sendAction: suspend (String, JsonObject) -> Result<JsonObject>,
    sendClipboard: suspend (String, String) -> Result<JsonObject>,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val renderer = remember { AndroidVncWebViewRenderer(context) }
    val rendererState by renderer.state.collectAsStateWithLifecycle()
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var status by remember { mutableStateOf<JsonObject?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    var clipboardText by remember { mutableStateOf("") }
    var clipboardOpen by remember { mutableStateOf(false) }
    val controlling = status?.get("humanTakeover")?.toString()?.toBoolean() == true
    val paused = status?.get("agentInputPaused")?.toString()?.toBoolean() == true
    DisposableEffect(renderer) {
        onDispose { renderer.detach() }
    }
    LaunchedEffect(renderer, botId, server) {
        if (server.isNullOrBlank()) {
            renderer.onSocketError("Cloud computer viewing requires a connected server.")
            return@LaunchedEffect
        }
        if (botId.isBlank()) {
            renderer.onSocketError("This conversation is not linked to a bot.")
            return@LaunchedEffect
        }
        var retryDelay = 500L
        while (isActive) {
            val grant = requestGrant(botId).getOrElse {
                failure = it.message ?: "Unable to request the computer viewer."
                renderer.prepareForReconnect()
                null
            }
            if (grant != null) {
                runCatching { renderer.connect(grant, URI(server), botId) }
                    .onSuccess {
                        failure = null
                        retryDelay = 500L
                    }
                    .onFailure {
                        failure = it.message ?: "Unable to connect to the computer."
                        renderer.prepareForReconnect()
                    }
                while (isActive && renderer.state.value == VncRendererState.Connected) {
                    delay(250)
                }
            }
            if (!isActive) break
            delay(retryDelay)
            retryDelay = (retryDelay * 2).coerceAtMost(5_000L)
        }
    }
    LaunchedEffect(botId, server, controlling) {
        if (botId.isBlank() || server.isNullOrBlank()) return@LaunchedEffect
        while (isActive) {
            requestStatus(botId).onSuccess { status = it }.onFailure { failure = it.message }
            if (controlling) {
                setTakeover(botId, true).onSuccess { status = it }.onFailure { failure = it.message }
            }
            delay(20_000)
        }
    }
    LaunchedEffect(rendererState, controlling, paused) {
        if (rendererState == VncRendererState.Connected) {
            renderer.setControl(controlling && !paused)
        }
    }
    DisposableEffect(botId) {
        onDispose {
            if (controlling) scope.launch { setTakeover(botId, false) }
        }
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                actions = {
                    TextButton(onClick = {
                        scope.launch {
                            setTakeover(botId, !controlling).fold(
                                onSuccess = { status = it; failure = null },
                                onFailure = { failure = it.message },
                            )
                        }
                    }) { Text(if (controlling) localizedText("Release", "释放控制") else localizedText("Take control", "接管控制")) }
                    TextButton(onClick = {
                        scope.launch {
                            setPaused(botId, !paused).fold(
                                onSuccess = { status = it; failure = null },
                                onFailure = { failure = it.message },
                            )
                        }
                    }) { Text(if (paused) localizedText("Resume", "继续") else localizedText("Pause", "暂停")) }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = localizedText("Back to conversations", "返回对话列表"))
                    }
                },
            )
        },
        containerColor = Color.Black,
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { viewContext -> WebView(viewContext).also(renderer::attach) },
            )
            if (rendererState != VncRendererState.Connected) {
                Card(
                    Modifier.align(Alignment.Center).padding(24.dp),
                    colors = CardDefaults.cardColors(containerColor = Color(0xFF202020)),
                    shape = RoundedCornerShape(20.dp),
                ) {
                    Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(stringResource(com.openteam.android.R.string.computer_title), color = Color.White, style = MaterialTheme.typography.titleLarge)
                        Text(
                            when (val state = rendererState) {
                                is VncRendererState.Failed -> state.message
                                is VncRendererState.Reconnecting -> {
                                    val reason = state.reason.trim()
                                    if (reason.isBlank()) "Computer connection interrupted. Reconnecting…"
                                    else "Computer connection interrupted. Reconnecting…\n$reason"
                                }
                                else -> stringResource(com.openteam.android.R.string.computer_connecting)
                            },
                            color = Color.White.copy(alpha = .75f),
                        )
                    }
                }
            }
            // The toolbar sits on the dark remote-screen overlay, so it keeps light content,
            // but uses button colors so disabled actions (before Take control) read as disabled.
            val toolbarButtonColors = androidx.compose.material3.ButtonDefaults.textButtonColors(
                contentColor = Color.White,
                disabledContentColor = Color.White.copy(alpha = .38f),
            )
            Column(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Color.Black.copy(alpha = .82f)).padding(10.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                failure?.let { Text(it, color = Color(0xFFFF8A80), style = MaterialTheme.typography.bodySmall) }
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    TextButton(onClick = { clipboardOpen = true }, enabled = controlling && !paused, colors = toolbarButtonColors) { Text(localizedText("Clipboard", "剪贴板")) }
                    listOf("Return", "Tab", "Escape", "BackSpace").forEach { key ->
                        TextButton(onClick = { scope.launch { runCatching { renderer.send(com.openteam.platform.ComputerInput.Key(listOf(key))) } } }, enabled = controlling && !paused, colors = toolbarButtonColors) {
                            Text(key)
                        }
                    }
                }
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("chromium" to "Browser", "thunar" to "Files", "terminal" to "Terminal").forEach { (app, label) ->
                        TextButton(onClick = { scope.launch { sendAction(botId, buildJsonObject { put("action", "open_app"); put("app", app) }) } }, enabled = controlling && !paused, colors = toolbarButtonColors) {
                            Text(label)
                        }
                    }
                }
            }
        }
    }
    if (clipboardOpen) {
        AlertDialog(
            onDismissRequest = { clipboardOpen = false },
            title = { Text(localizedText("Send text to computer", "发送文本到云电脑")) },
            text = { OutlinedTextField(clipboardText, { clipboardText = it }, label = { Text(localizedText("Text", "文本")) }, minLines = 3) },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch {
                        sendClipboard(botId, clipboardText).onFailure { failure = it.message }
                        clipboardOpen = false
                    }
                }, enabled = clipboardText.isNotBlank() && controlling && !paused) { Text(localizedText("Send", "发送")) }
            },
            dismissButton = { TextButton(onClick = { clipboardOpen = false }) { Text(localizedText("Cancel", "取消")) } },
        )
    }
}

@Composable
private fun IosChromeIcon(
    icon: @Composable () -> Unit,
    contentDescription: String,
    onClick: () -> Unit,
) {
    IconButton(
        onClick = onClick,
        modifier = Modifier.size(44.dp).clip(CircleShape)
            .background(MaterialTheme.colorScheme.surface.copy(alpha = .58f))
            .border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = .35f), CircleShape),
    ) {
        CompositionLocalProvider(
            androidx.compose.material3.LocalContentColor provides MaterialTheme.colorScheme.onSurface,
        ) {
            icon()
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatScreen(
    conversationId: String,
    title: String,
    messages: List<ChatMessage>,
    targetMessageId: String?,
    draft: String,
    replyingTo: ChatMessage?,
    onReply: (String) -> Unit,
    onCancelReply: () -> Unit,
    onOpenRoutine: () -> Unit,
    error: String?,
    onBack: () -> Unit,
    onBotDetails: () -> Unit,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
    onRetry: (String) -> Unit,
    voiceState: VoiceRecordingState,
    onStartVoice: () -> Unit,
    onStopVoice: () -> Unit,
    onRetryVoice: () -> Unit,
    onCancelVoice: () -> Unit,
    operation: FeatureOperationState,
    pendingAttachments: List<Attachment>,
    hasMoreHistory: Boolean,
    historyLoading: Boolean,
    conversations: List<Conversation>,
    onLoadOlder: () -> Unit,
    onUpload: (String) -> Unit,
    onDownload: (String, Attachment) -> Unit,
    onSaveAttachment: (String, Attachment) -> Unit,
    onShareAttachment: (Attachment) -> Unit,
    onForwardAttachment: (Attachment, String) -> Unit,
    onAction: (String, String, Map<String, String>) -> Unit,
    onReaction: (String, String) -> Unit,
    onMessageAction: (String, MessageAction) -> Unit,
    onContext: (String) -> Unit,
    threadContext: List<ChatMessage>,
    threadContextTruncated: Boolean,
    activity: ChannelActivity? = null,
    bot: Conversation? = null,
) {
    val listState = rememberLazyListState()
    var forwardingAttachment by remember { mutableStateOf<Attachment?>(null) }
    val attachmentPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { onUpload(it.toString()) } }
    val contextRows = threadContext.take(com.openteam.android.data.ChatHistoryPage.DEFAULT_CONTEXT_LIMIT)
    var hasPositionedInitialMessages by remember(conversationId) { mutableStateOf(false) }
    // The list ends with the bot-activity row and a 4dp spacer. Scrolling to that last item can only
    // stop at the end of the list, so the newest message is always shown in full, however tall.
    val lastItemIndex = (if (hasMoreHistory) 1 else 0) + (if (contextRows.isNotEmpty()) 1 else 0) + messages.size + 1
    val currentLastItemIndex by rememberUpdatedState(lastItemIndex)
    val currentTargetMessageId by rememberUpdatedState(targetMessageId)
    val bottomThresholdPx = with(LocalDensity.current) { 48.dp.toPx() }
    // True while the reader is at (or within a thumb's width of) the newest message. It is only
    // re-evaluated when a scroll settles, so list growth between two scrolls cannot flip it.
    var followBottom by remember(conversationId) { mutableStateOf(true) }
    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress }.collect { scrolling ->
            if (!scrolling) followBottom = listState.isNearBottom(bottomThresholdPx)
        }
    }
    var lastScrolledId by remember(conversationId) { mutableStateOf<String?>(null) }
    val newest = messages.lastOrNull()
    // Keyed on the whole newest message so edits, reactions, attachments and delivery changes that
    // alter its height also re-run this, not only a new message id.
    LaunchedEffect(conversationId, historyLoading, targetMessageId, messages.size, newest, activity) {
        if (historyLoading || messages.isEmpty()) return@LaunchedEffect
        val targetIndex = targetMessageId?.let { id -> messages.indexOfFirst { it.id == id } }?.takeIf { it >= 0 }
        if (targetIndex != null) {
            listState.scrollToItem(targetIndex + if (contextRows.isNotEmpty()) 1 else 0)
            hasPositionedInitialMessages = true
            return@LaunchedEffect
        }
        val isNewMessage = newest?.id != lastScrolledId
        lastScrolledId = newest?.id
        when {
            !hasPositionedInitialMessages -> {
                listState.scrollToItem(lastItemIndex)
                hasPositionedInitialMessages = true
                followBottom = true
            }
            // Your own message always jumps to the bottom, even if you had scrolled up.
            followBottom || (isNewMessage && newest?.isMine == true) -> {
                if (isNewMessage || activity != null) listState.animateScrollToItem(lastItemIndex)
                else listState.scrollToItem(lastItemIndex)
                followBottom = true
            }
        }
    }
    // The viewport shrinks when the keyboard opens or the composer grows; stay on the newest message.
    LaunchedEffect(listState) {
        snapshotFlow { listState.layoutInfo.viewportSize.height }.drop(1).collect {
            if (followBottom && hasPositionedInitialMessages && currentTargetMessageId == null) {
                listState.scrollToItem(currentLastItemIndex)
            }
        }
    }
    // Jumping to a quoted original is local to this screen. Routing it through targetMessageId
    // would keep the list pinned to that message and drag it back after every new message.
    var jumpToMessageId by remember(conversationId) { mutableStateOf<String?>(null) }
    var highlightedMessageId by remember(conversationId) { mutableStateOf<String?>(null) }
    LaunchedEffect(jumpToMessageId, messages) {
        val id = jumpToMessageId ?: return@LaunchedEffect
        val index = messages.indexOfFirst { it.id == id }
        if (index < 0) return@LaunchedEffect
        listState.animateScrollToItem(index + if (contextRows.isNotEmpty()) 1 else 0)
        jumpToMessageId = null
        highlightedMessageId = id
        delay(1500)
        if (highlightedMessageId == id) highlightedMessageId = null
    }
    forwardingAttachment?.let { attachment ->
        AlertDialog(
            onDismissRequest = { forwardingAttachment = null },
            title = { Text(stringResource(com.openteam.android.R.string.chat_forward)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("${stringResource(com.openteam.android.R.string.chat_forward)}: ${attachment.name}")
                    conversations.forEach { conversation ->
                        TextButton(
                            onClick = {
                                onForwardAttachment(attachment, conversation.id)
                                forwardingAttachment = null
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text(conversation.title, textAlign = androidx.compose.ui.text.style.TextAlign.Start) }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { forwardingAttachment = null }) { Text(stringResource(com.openteam.android.R.string.login_cancel)) } },
        )
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    IconButton(
                        onClick = onBack,
                        modifier = Modifier.testTag("back-to-conversations"),
                    ) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = localizedText("Back to conversations", "返回对话列表"),
                        )
                    }
                },
                actions = {
                    IconButton(
                        onClick = onBotDetails,
                        modifier = Modifier.testTag("bot-details"),
                    ) {
                        Icon(
                            Icons.Default.Info,
                            contentDescription = stringResource(com.openteam.android.R.string.chat_bot_details),
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        bottomBar = {
            Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background).windowInsetsPadding(WindowInsets.navigationBars).imePadding().padding(horizontal = 14.dp, vertical = 10.dp)) {
                if (error != null) Text(error, Modifier.padding(start = 4.dp, bottom = 6.dp), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                when (voiceState) {
                    VoiceRecordingState.Idle -> Unit
                    is VoiceRecordingState.Starting -> Text(stringResource(com.openteam.android.R.string.chat_record_voice), style = MaterialTheme.typography.bodySmall)
                    is VoiceRecordingState.Recording -> voiceControls(localizedText("Recording voice note", "正在录制语音消息"), onStopVoice, onCancelVoice)
                    is VoiceRecordingState.Interrupted -> voiceControls(localizedText("Recording paused", "录音已暂停"), onStopVoice, onCancelVoice)
                    is VoiceRecordingState.Transcribing -> voiceControls("Transcribing…", null, onCancelVoice)
                    is VoiceRecordingState.Review -> {
                        Text(voiceState.error ?: localizedText("Transcription failed", "语音转写失败"), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = onRetryVoice) { Text(localizedText("Retry", "重试")) }
                            TextButton(onClick = onCancelVoice) { Text(localizedText("Discard", "丢弃")) }
                        }
                    }
                    is VoiceRecordingState.Failed -> {
                        Text(voiceState.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                        TextButton(onClick = onCancelVoice) { Text(localizedText("Dismiss", "关闭")) }
                    }
                }
                replyingTo?.let { target ->
                    ReplyPreviewBar(target, onCancelReply)
                }
                Row(verticalAlignment = Alignment.Bottom) {
                    IconButton(onClick = { attachmentPicker.launch(arrayOf("*/*")) }) { Icon(Icons.Default.Add, contentDescription = stringResource(com.openteam.android.R.string.chat_add_attachment)) }
                    OutlinedTextField(
                        value = draft,
                        onValueChange = onDraftChange,
                        modifier = Modifier.weight(1f).testTag("message-composer"),
                        placeholder = { Text(stringResource(com.openteam.android.R.string.chat_message)) },
                        shape = RoundedCornerShape(24.dp),
                        maxLines = 5,
                    )
                    Spacer(Modifier.width(8.dp))
                    IconButton(onClick = onStartVoice, enabled = voiceState is VoiceRecordingState.Idle, modifier = Modifier.testTag("voice-composer")) {
                        Icon(Icons.Default.Mic, contentDescription = stringResource(com.openteam.android.R.string.chat_record_voice))
                    }
                    IconButton(onClick = onSend, enabled = draft.isNotBlank() || pendingAttachments.isNotEmpty(), modifier = Modifier.testTag("send-message").clip(CircleShape).background(MaterialTheme.colorScheme.primary)) {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = stringResource(com.openteam.android.R.string.chat_send), tint = MaterialTheme.colorScheme.onPrimary)
                    }
                }
                if (pendingAttachments.isNotEmpty()) {
                    ChatAttachmentStrip(pendingAttachments, onPreview = { _, _ -> }, onDownload = { _, _ -> })
                }
                when (operation) {
                    FeatureOperationState.Idle -> Unit
                    FeatureOperationState.Pending -> Text(localizedText("Working…", "处理中…"), Modifier.testTag("chat-operation-status"), style = MaterialTheme.typography.bodySmall)
                    is FeatureOperationState.Succeeded -> Text(operation.message ?: localizedText("Done", "完成"), Modifier.testTag("chat-operation-status"), color = MaterialTheme.colorScheme.tertiary, style = MaterialTheme.typography.bodySmall)
                    is FeatureOperationState.Failed -> Text(operation.message, Modifier.testTag("chat-operation-status"), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (hasMoreHistory) {
                item(key = "load-older") {
                    TextButton(
                        onClick = onLoadOlder,
                        enabled = !historyLoading,
                        modifier = Modifier.fillMaxWidth().testTag("load-older-messages"),
                    ) {
                        if (historyLoading) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                        else Text(stringResource(com.openteam.android.R.string.chat_load_older))
                    }
                }
            }
            if (contextRows.isNotEmpty()) {
                item(key = "thread-context") {
                    ChatContextSummary(contextRows, threadContextTruncated || threadContext.size > contextRows.size)
                }
            }
            items(messages, key = ChatMessage::id) { message ->
                MessageBubble(
                    message,
                    onRetry,
                    isTarget = message.id == targetMessageId || message.id == highlightedMessageId,
                    operation = operation,
                    onDownload = onDownload,
                    onSaveAttachment = onSaveAttachment,
                    onShareAttachment = onShareAttachment,
                    onForwardAttachment = { forwardingAttachment = it },
                    onAction = onAction,
                    onReaction = onReaction,
                    onMessageAction = onMessageAction,
                    onContext = onContext,
                    onReply = onReply,
                    onOpenRoutine = onOpenRoutine,
                    replyOriginal = message.replyToMessageId?.let { id -> messages.firstOrNull { it.id == id } },
                    onOpenOriginal = { id ->
                        // Load the surrounding history only when the original is not already in the list.
                        if (messages.none { it.id == id }) onContext(id)
                        jumpToMessageId = id
                    },
                )
            }
            item(key = "bot-activity") { BotActivityRow(activity, bot) }
            item { Spacer(Modifier.height(4.dp)) }
        }
    }
}

private fun LazyListState.isNearBottom(thresholdPx: Float): Boolean {
    val info = layoutInfo
    val last = info.visibleItemsInfo.lastOrNull() ?: return true
    return last.index >= info.totalItemsCount - 1 &&
        last.offset + last.size - info.viewportEndOffset <= thresholdPx
}

@Composable
private fun ChannelActivity.label(): String = when (this) {
    ChannelActivity.Thinking -> localizedText("Thinking", "思考中")
    ChannelActivity.Typing -> localizedText("Typing", "正在输入")
    ChannelActivity.ReadingFile -> localizedText("Reading file", "正在读取文件")
    ChannelActivity.SearchingWeb -> localizedText("Searching the web", "正在搜索网页")
    ChannelActivity.ReadingWeb -> localizedText("Reading the web", "正在阅读网页")
    ChannelActivity.DraftingFile -> localizedText("Drafting the file", "正在撰写文件")
    ChannelActivity.RunningCommands -> localizedText("Running commands", "正在运行命令")
    ChannelActivity.WaitingOnCommand -> localizedText("Waiting on a command", "正在等待命令")
    ChannelActivity.OnComputer -> localizedText("On its computer", "正在操作电脑")
    ChannelActivity.MessagingAssistant -> localizedText("Messaging another assistant", "正在联系其他助手")
    ChannelActivity.WaitingOnBot -> localizedText("Waiting on another Bot", "正在等待其他 Bot")
    ChannelActivity.GeneratingImage -> localizedText("Generating a photo", "正在生成图片")
    ChannelActivity.OrganizingContext -> localizedText("Organizing context", "正在整理上下文")
    ChannelActivity.Working -> localizedText("Working", "处理中")
    ChannelActivity.Background -> localizedText("Working in the background", "正在后台处理")
}

/**
 * The desktop's "bot is working" row: a small avatar with a soft pulse and a caption of what the
 * bot is doing. It scales and fades in and out (180ms / 140ms) so the transcript does not jump.
 */
@Composable
private fun BotActivityRow(activity: ChannelActivity?, bot: Conversation?) {
    // Keep the last caption while the row animates out.
    var shown by remember { mutableStateOf(activity) }
    if (activity != null) shown = activity
    AnimatedVisibility(
        visible = activity != null,
        enter = fadeIn(tween(180, easing = FastOutSlowInEasing)) + scaleIn(tween(180, easing = FastOutSlowInEasing), initialScale = .92f, transformOrigin = TransformOrigin(0f, .5f)),
        exit = fadeOut(tween(140, easing = FastOutSlowInEasing)) + scaleOut(tween(140, easing = FastOutSlowInEasing), targetScale = .92f, transformOrigin = TransformOrigin(0f, .5f)),
    ) {
        val label = shown?.label().orEmpty()
        val pulse = rememberInfiniteTransition(label = "activity-pulse").animateFloat(
            initialValue = .45f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(900, easing = FastOutSlowInEasing), RepeatMode.Reverse),
            label = "activity-alpha",
        )
        Row(
            Modifier.fillMaxWidth().height(36.dp).testTag("bot-activity")
                .semantics { contentDescription = label },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (bot != null) BotAvatar(bot, size = 22.dp, ringColor = MaterialTheme.colorScheme.background)
            AnimatedContent(
                targetState = label,
                transitionSpec = { fadeIn(tween(180)) togetherWith fadeOut(tween(120)) },
                label = "activity-caption",
            ) { text ->
                Text(
                    text,
                    Modifier.alpha(pulse.value),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
            }
        }
    }
}

@Composable
fun ChatContextSummary(messages: List<ChatMessage>, truncated: Boolean) {
    Card(Modifier.fillMaxWidth().testTag("thread-context"), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(com.openteam.android.R.string.chat_thread_context),
                    Modifier.weight(1f).testTag("thread-context-title"),
                    fontWeight = FontWeight.SemiBold,
                )
                if (truncated) {
                    Text(
                        stringResource(com.openteam.android.R.string.chat_older_context),
                        modifier = Modifier.testTag("thread-context-truncated"),
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
            messages.forEach { message ->
                Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                    Text(message.author, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSecondaryContainer)
                    Text(message.displayBody ?: "Rich content", maxLines = 3, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun voiceControls(label: String, onStop: (() -> Unit)?, onCancel: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
        onStop?.let { IconButton(onClick = it) { Icon(Icons.Default.Stop, contentDescription = localizedText("Stop voice note", "停止语音消息")) } }
        IconButton(onClick = onCancel) { Icon(Icons.Default.Close, contentDescription = localizedText("Cancel voice note", "取消语音消息")) }
    }
}

@Composable
private fun MessageBubble(
    message: ChatMessage,
    onRetry: (String) -> Unit,
    isTarget: Boolean,
    operation: FeatureOperationState,
    onDownload: (String, Attachment) -> Unit,
    onSaveAttachment: (String, Attachment) -> Unit,
    onShareAttachment: (Attachment) -> Unit,
    onForwardAttachment: (Attachment) -> Unit,
    onAction: (String, String, Map<String, String>) -> Unit,
    onReaction: (String, String) -> Unit,
    onMessageAction: (String, MessageAction) -> Unit,
    onContext: (String) -> Unit,
    onReply: (String) -> Unit,
    onOpenRoutine: () -> Unit,
    replyOriginal: ChatMessage?,
    onOpenOriginal: (String) -> Unit,
) {
    message.routineEvent?.let { event ->
        RoutineEventRow(message.id, event, onOpenRoutine)
        return
    }
    var previewAttachment by remember(message.id) { mutableStateOf<Attachment?>(null) }
    val context = LocalContext.current
    previewAttachment?.let { attachment ->
        AttachmentGalleryDialog(
            attachments = message.attachments,
            initialId = attachment.id,
            onDismiss = { previewAttachment = null },
            onOpenDocument = { item ->
                NativeAttachmentPreview.open(context, item).onFailure {
                    previewAttachment = null
                }
            },
            onSave = { onSaveAttachment(message.id, it) },
            onShare = onShareAttachment,
            onForward = onForwardAttachment,
        )
    }
    val swipeScope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    val density = LocalDensity.current
    val replyThresholdPx = with(density) { 56.dp.toPx() }
    val maxSwipePx = with(density) { 84.dp.toPx() }
    val swipe = remember(message.id) { Animatable(0f) }
    // Only the other side's messages can be replied to by swiping. Unsent rows have no server id.
    val canSwipeReply = !message.isMine && message.delivery == com.openteam.android.data.Delivery.SENT
    Box(Modifier.fillMaxWidth()) {
        Icon(
            Icons.AutoMirrored.Filled.Reply,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .align(Alignment.CenterEnd)
                .padding(end = 8.dp)
                .size(22.dp)
                .alpha((-swipe.value / replyThresholdPx).coerceIn(0f, 1f)),
        )
    Row(
        Modifier
            .fillMaxWidth()
            .offset { IntOffset(swipe.value.roundToInt(), 0) }
            .then(
                if (!canSwipeReply) Modifier else Modifier.pointerInput(message.id) {
                    var crossed = false
                    detectHorizontalDragGestures(
                        onDragStart = { crossed = false },
                        onDragEnd = {
                            if (crossed) onReply(message.id)
                            swipeScope.launch { swipe.animateTo(0f) }
                        },
                        onDragCancel = { swipeScope.launch { swipe.animateTo(0f) } },
                    ) { change, delta ->
                        change.consume()
                        // Leftward only, with resistance past the trigger distance.
                        val next = (swipe.value + delta).coerceIn(-maxSwipePx, 0f)
                        swipeScope.launch { swipe.snapTo(next) }
                        val nowCrossed = -next >= replyThresholdPx
                        if (nowCrossed && !crossed) haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        crossed = nowCrossed
                    }
                },
            ),
        horizontalArrangement = if (message.isMine) Arrangement.End else Arrangement.Start,
    ) {
        // The column is 86% wide, so its children need their own alignment. Without it
        // the author and bubble sit at the column's left edge even for the user's own messages.
        Column(
            Modifier.fillMaxWidth(.86f),
            horizontalAlignment = if (message.isMine) Alignment.End else Alignment.Start,
        ) {
            Text(
                message.author,
                Modifier.padding(horizontal = 8.dp),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Spacer(Modifier.height(4.dp))
            Card(
                modifier = Modifier.testTag("message-row-${message.body.hashCode()}"),
                colors = CardDefaults.cardColors(containerColor = if (message.isMine) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surface),
                shape = RoundedCornerShape(20.dp),
                border = if (isTarget) androidx.compose.foundation.BorderStroke(2.dp, MaterialTheme.colorScheme.tertiary) else null,
            ) {
                Column(Modifier.padding(horizontal = 15.dp, vertical = 12.dp)) {
                    message.replyToMessageId?.let { reply ->
                        ReplyQuote(
                            original = replyOriginal,
                            ownMessage = message.isMine,
                            onOpen = { onOpenOriginal(reply) },
                        )
                    }
                    // A question card already shows its prompt, so the body text would repeat it.
                    message.displayBody?.takeUnless { message.richMessage?.isQuestion == true }?.let { body ->
                        MarkdownMessage(
                            markdown = body,
                            contentColor = if (message.isMine) {
                                MaterialTheme.colorScheme.onPrimary
                            } else {
                                MaterialTheme.colorScheme.onSurface
                            },
                        )
                            containerColor = if (message.isMine) {
                                MaterialTheme.colorScheme.primary
                            } else {
                                MaterialTheme.colorScheme.surface
                            },
                    }
                    message.richMessage?.let { rich ->
                        RichMessageCardScreen(
                            message = rich,
                            operation = operation,
                            onAction = { action, values -> onAction(message.id, action.id, values) },
                        )
                    }
                    if (message.attachments.isNotEmpty()) {
                        ChatAttachmentStrip(
                            attachments = message.attachments,
                            onPreview = { attachment, _ ->
                                previewAttachment = attachment
                                if (!attachment.isImage && attachment.localUri == null) onDownload(message.id, attachment)
                            },
                            onDownload = { attachment, _ -> onDownload(message.id, attachment) },
                        )
                    }
                    if (message.reactions.isNotEmpty() || (message.richMessage != null && message.richMessage?.isQuestion != true)) {
                        ReactionsAndActionsRow(
                            state = ReactionState(message.reactions, operation),
                            onReaction = { emoji -> onReaction(message.id, emoji) },
                            onAction = { action -> onMessageAction(message.id, action) },
                        )
                    }
                    // A plain reply already has a tappable quote that jumps to the original.
                    if (message.replyToMessageId == null && (message.contextMessageId != null || message.threadId != null)) {
                        TextButton(onClick = { onContext(message.id) }) { Text(stringResource(com.openteam.android.R.string.chat_show_context)) }
                    }
                    if (message.isMine) {
                        val status = when (message.delivery) {
                            com.openteam.android.data.Delivery.SENDING -> "Sending…"
                    com.openteam.android.data.Delivery.SENT -> localizedText("Sent", "已发送")
                    com.openteam.android.data.Delivery.FAILED -> localizedText("Not sent", "未发送")
                        }
                        Text(
                            status,
                            Modifier.align(Alignment.End).padding(top = 4.dp)
                                .testTag("delivery-status-${message.body.hashCode()}"),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onPrimary,
                        )
                        if (message.delivery == com.openteam.android.data.Delivery.FAILED) {
                            Row(
                                modifier = Modifier.align(Alignment.End)
                                    .clip(RoundedCornerShape(8.dp))
                                    .clickable { onRetry(message.id) }
                                    .padding(horizontal = 10.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Icon(Icons.Default.Refresh, contentDescription = null, modifier = Modifier.size(14.dp))
                                Spacer(Modifier.width(4.dp))
                                Text(localizedText("Retry", "重试"), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onPrimary)
                            }
                        }
                    }
                }
            }
        }
    }
    }
}

@Composable
private fun RoutineEventRow(messageId: String, event: RoutineEvent, onOpen: () -> Unit) {
    val label = when (event.action) {
        "created" -> localizedText("New routine “${event.name}”", "新建例程“${event.name}”")
        "updated" -> localizedText("Updated routine “${event.name}”", "已更新例程“${event.name}”")
        "enabled" -> localizedText("Enabled routine “${event.name}”", "已启用例程“${event.name}”")
        "disabled" -> localizedText("Disabled routine “${event.name}”", "已停用例程“${event.name}”")
        else -> localizedText("Deleted routine “${event.name}”", "已删除例程“${event.name}”")
    }
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .clickable(enabled = event.canOpen, onClick = onOpen)
            .padding(vertical = 8.dp)
            .testTag("routine-event-$messageId"),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.Default.AccessTime,
            contentDescription = null,
            modifier = Modifier.size(14.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.width(6.dp))
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * One-line preview of the message being replied to, shown above a reply's text.
 * Tapping it scrolls to the original, loading surrounding history first when it is not on screen.
 */
@Composable
private fun ReplyQuote(original: ChatMessage?, ownMessage: Boolean, onOpen: () -> Unit) {
    val preview = original?.let { message ->
        val text = (message.displayBody ?: "").replace(Regex("\\s+"), " ").trim()
        text.ifEmpty {
            if (message.attachments.isNotEmpty()) localizedText("Attachment", "附件") else ""
        }
    }.orEmpty().ifEmpty { localizedText("View original message", "查看原消息") }
    val tint = if (ownMessage) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        Modifier
            .padding(bottom = 8.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(tint.copy(alpha = 0.14f))
            .clickable(onClick = onOpen)
            .padding(horizontal = 10.dp, vertical = 5.dp)
            .testTag("reply-quote"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.AutoMirrored.Filled.Reply,
            contentDescription = null,
            modifier = Modifier.size(12.dp),
            tint = tint,
        )
        Spacer(Modifier.width(5.dp))
        Text(
            preview,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.labelMedium,
            color = tint,
        )
    }
}

@Composable
private fun ReplyPreviewBar(target: ChatMessage, onCancel: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(bottom = 6.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(start = 12.dp)
            .testTag("reply-preview"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.AutoMirrored.Filled.Reply,
            contentDescription = null,
            modifier = Modifier.size(16.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.width(8.dp))
        Text(
            (target.displayBody ?: "").replace(Regex("\\s+"), " ").trim(),
            Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        IconButton(onClick = onCancel, modifier = Modifier.size(36.dp).testTag("cancel-reply")) {
            Icon(
                Icons.Default.Close,
                contentDescription = localizedText("Cancel reply", "取消回复"),
                modifier = Modifier.size(16.dp),
            )
        }
    }
}

@Composable
private fun AttachmentGalleryDialog(
    attachments: List<Attachment>,
    initialId: String,
    onDismiss: () -> Unit,
    onOpenDocument: (Attachment) -> Unit,
    onSave: (Attachment) -> Unit,
    onShare: (Attachment) -> Unit,
    onForward: (Attachment) -> Unit,
) {
    var index by remember(initialId) {
        mutableStateOf(attachments.indexOfFirst { it.id == initialId }.coerceAtLeast(0))
    }
    val current = attachments.getOrNull(index) ?: return
    val bitmap = rememberDecodedBitmap(current.localUri, maxSizePx = 2048)
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            Column(Modifier.fillMaxSize().padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(current.name, Modifier.weight(1f), color = Color.White, maxLines = 1)
                    IconButton(onClick = onDismiss) { Icon(Icons.Default.Close, localizedText("Close", "关闭"), tint = Color.White) }
                }
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    if (bitmap != null) {
                        Image(bitmap, current.alt ?: current.name, Modifier.fillMaxWidth())
                    } else {
                        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text(current.mimeType.ifBlank { localizedText("Document", "文档") }, color = Color.White)
                            TextButton(onClick = { onOpenDocument(current) }) {
                                Text(localizedText("Open with Android", "使用 Android 打开"), color = Color.White)
                            }
                        }
                    }
                }
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    TextButton(onClick = { onSave(current) }) {
                        Text(localizedText("Save", "保存"), color = Color.White)
                    }
                    TextButton(onClick = { onShare(current) }) {
                        Text(localizedText("Share", "分享"), color = Color.White)
                    }
                    TextButton(onClick = { onForward(current) }) {
                        Text(localizedText("Forward", "转发"), color = Color.White)
                    }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(onClick = { index = (index - 1).coerceAtLeast(0) }, enabled = index > 0) { Text(localizedText("Previous", "上一项"), color = Color.White) }
                    Text("${index + 1} / ${attachments.size}", color = Color.White)
                    TextButton(onClick = { index = (index + 1).coerceAtMost(attachments.lastIndex) }, enabled = index < attachments.lastIndex) { Text(localizedText("Next", "下一项"), color = Color.White) }
                }
            }
        }
    }
}
