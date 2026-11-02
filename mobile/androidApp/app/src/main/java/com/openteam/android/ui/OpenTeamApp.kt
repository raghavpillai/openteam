package com.openteam.android.ui

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.webkit.WebView
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AccessTime
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.FolderOpen
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.viewinterop.AndroidView
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
import com.openteam.android.data.SidebarPreferences
import com.openteam.android.data.SidebarSection
import com.openteam.features.Attachment
import com.openteam.features.FeatureOperationState
import com.openteam.features.FeatureLoadState
import com.openteam.features.MessageAction
import com.openteam.features.Plugin
import com.openteam.features.ReactionState
import com.openteam.features.ReactionsAndActionsRow
import com.openteam.features.RichMessageCardScreen
import com.openteam.features.ChatAttachmentStrip
import com.openteam.features.AccountMemoryScreen
import com.openteam.features.PluginsScreen
import com.openteam.features.ProviderSettingsScreen
import com.openteam.features.RoutineEditorScreen
import com.openteam.features.RoutinesScreen
import com.openteam.features.SettingsScreen
import com.openteam.features.WebProviderSettingsScreen
import com.openteam.platform.SharePayload
import com.openteam.platform.VoiceRecordingState
import com.openteam.platform.AndroidVncWebViewRenderer
import com.openteam.platform.ComputerVncGrant
import com.openteam.platform.VncRendererState
import java.net.URI
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private const val LOGIN = "login"
private const val DIRECTORY = "directory"
private const val CHAT = "chat/{conversationId}"
private const val BOT_DETAILS = "bot/{conversationId}/details"
private const val COMPUTER = "bot/{conversationId}/computer"
private const val MARKETPLACE = "marketplace"
private const val ROUTINES = "routines"
private const val ROUTINE_EDITOR = "routines/editor"
private const val SETTINGS = "settings"
private const val PROVIDERS = "providers"
private const val WEB_PROVIDERS = "web-providers"
private const val PLUGINS = "plugins"

private enum class SignInStep { WELCOME, ENDPOINT, CREDENTIALS }

@Composable
fun OpenTeamApp(appViewModel: AppViewModel = viewModel()) {
    val state by appViewModel.state.collectAsStateWithLifecycle()
    val voiceState by appViewModel.voiceState.collectAsStateWithLifecycle()
    val navController = rememberNavController()
    val context = LocalContext.current
    val microphonePermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) appViewModel.startVoice()
    }

    LaunchedEffect(state.pendingExternalUrl) {
        state.pendingExternalUrl?.let { url ->
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            appViewModel.consumeExternalUrl()
        }
    }

    LaunchedEffect(state.pendingOutgoingShare) {
        state.pendingOutgoingShare?.let { share ->
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = share.mimeType.ifBlank { "application/octet-stream" }
                putExtra(Intent.EXTRA_STREAM, Uri.parse(share.uri))
                putExtra(Intent.EXTRA_TEXT, share.fileName)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(Intent.createChooser(intent, "Share ${share.fileName}"))
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

    NavHost(navController = navController, startDestination = LOGIN) {
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
            LaunchedEffect(Unit) { appViewModel.loadFeatureData() }
            DirectoryScreen(
                accountName = state.session?.accountName.orEmpty(),
                rows = state.conversations,
                sidebar = state.sidebar,
                share = state.pendingShare,
                onOpen = { conversation ->
                    appViewModel.openConversation(conversation.id)
                    navController.navigate("chat/${conversation.id}")
                },
                onShareTarget = appViewModel::selectShareTarget,
                onRoutines = { navController.navigate(ROUTINES) },
                onSettings = { navController.navigate(SETTINGS) },
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
            val shareLabel = stringResource(com.openteam.android.R.string.bot_share)
            BackHandler { navController.popBackStack() }
            BotDetailsScreen(
                conversation = conversation,
                onBack = { navController.popBackStack() },
                onOpenChat = {
                    appViewModel.openConversation(id)
                    navController.navigate("chat/$id")
                },
                onComputer = { navController.navigate("bot/$id/computer") },
                onRoutines = { navController.navigate(ROUTINES) },
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
        composable(COMPUTER, arguments = listOf(navArgument("conversationId") { type = NavType.StringType })) { entry ->
            val id = entry.arguments?.getString("conversationId").orEmpty()
            val conversation = state.conversations.firstOrNull { it.id == id }
            BackHandler { navController.popBackStack() }
            ComputerViewerScreen(
                title = conversation?.title ?: "Cloud computer",
                botId = conversation?.botId.orEmpty(),
                server = state.session?.server,
                requestGrant = appViewModel::requestComputerGrant,
                onBack = { navController.popBackStack() },
            )
        }
        composable(CHAT, arguments = listOf(navArgument("conversationId") { type = NavType.StringType })) { entry ->
            val id = entry.arguments?.getString("conversationId").orEmpty()
            val conversation = state.conversations.firstOrNull { it.id == id }
            LaunchedEffect(id) { if (state.activeConversationId != id) appViewModel.openConversation(id) }
            BackHandler { navController.popBackStack() }
            ChatScreen(
                title = conversation?.title ?: "Conversation",
                messages = state.messages,
                targetMessageId = state.activeMessageId,
                draft = state.draft,
                error = state.error,
                onBack = { navController.popBackStack() },
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
            )
        }
        composable(ROUTINES) {
            BackHandler { navController.popBackStack() }
            RoutinesScreen(
                state = state.features.routines,
                onRetry = appViewModel::loadFeatureData,
                onAdd = { appViewModel.startRoutineEditor(); navController.navigate(ROUTINE_EDITOR) },
                onEdit = { appViewModel.startRoutineEditor(it); navController.navigate(ROUTINE_EDITOR) },
                onToggle = appViewModel::toggleRoutine,
                onRun = appViewModel::runRoutine,
            )
        }
        composable(ROUTINE_EDITOR) {
            BackHandler { navController.popBackStack() }
            state.features.routineDraft?.let { routine ->
                RoutineEditorScreen(
                    routine = routine,
                    onChange = appViewModel::updateRoutineDraft,
                    onSave = appViewModel::saveRoutine,
                    onDelete = routine.id.takeIf(String::isNotBlank)?.let { { appViewModel.deleteRoutine() } },
                    operation = state.features.operation,
                )
            }
        }
        composable(SETTINGS) {
            BackHandler { navController.popBackStack() }
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
            )
        }
        composable(PROVIDERS) {
            BackHandler { navController.popBackStack() }
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
            BackHandler { navController.popBackStack() }
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
            BackHandler { navController.popBackStack() }
            PluginsScreen(
                state = state.features.plugins,
                onRetry = appViewModel::loadFeatureData,
                onInstall = appViewModel::installPlugin,
                onUpdate = appViewModel::updatePlugin,
                onRollback = appViewModel::rollbackPlugin,
                onAuthorize = appViewModel::authorizePlugin,
                onCancelAuthorization = appViewModel::cancelPluginAuthorization,
                onConfigure = { },
                onTestTool = appViewModel::testPluginTool,
            )
        }
        composable(MARKETPLACE) {
            BackHandler { navController.popBackStack() }
            MarketplaceScreen(
                state = state.features.plugins,
                onBack = { navController.popBackStack() },
                onOpenExtensions = { navController.navigate(PLUGINS) },
            )
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
        when (step) {
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
                Text("✓ OpenTeam is ready", color = Color(0xFF3DDC84), fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                Text("Server   192.168.1.20:8787", color = Color.White.copy(alpha = .88f), fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun IosWizardTopBar(onBack: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack, modifier = Modifier.testTag("wizard-back")) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(com.openteam.android.R.string.chat_back))
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
    val successGreen = Color(0xFF16845B)
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().testTag(testTag),
        shape = RoundedCornerShape(16.dp),
        colors = androidx.compose.material3.ButtonDefaults.buttonColors(
            containerColor = if (success) successGreen else MaterialTheme.colorScheme.primary,
            contentColor = if (success) Color.White else MaterialTheme.colorScheme.onPrimary,
            disabledContainerColor = if (success) successGreen else MaterialTheme.colorScheme.primary,
            disabledContentColor = if (success) Color.White else MaterialTheme.colorScheme.onPrimary,
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
            done -> Icon(Icons.Default.CheckCircle, contentDescription = null, tint = Color(0xFF16845B), modifier = Modifier.size(18.dp))
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
    sidebar: SidebarPreferences,
    share: SharePayload?,
    onOpen: (Conversation) -> Unit,
    onShareTarget: (String) -> Unit,
    onRoutines: () -> Unit,
    onSettings: () -> Unit,
    onBotDetails: (Conversation) -> Unit,
    onTogglePin: (String) -> Unit,
    onMoveToSection: (String, String?) -> Unit,
    onToggleSection: (String?) -> Unit,
) {
    var searchVisible by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    var rowMenuId by remember { mutableStateOf<String?>(null) }
    val visibleRows = rows.filter {
        query.isBlank() ||
            it.title.contains(query, ignoreCase = true) ||
            (it.preview?.contains(query, ignoreCase = true) == true)
    }
    // Only manually pinned chats appear in the top row, and they are removed from the
    // grouped list below so each chat is shown in exactly one place.
    val grouped = remember(visibleRows, sidebar) { groupConversations(visibleRows, sidebar) }
    val pinnedRows = grouped.pinned
    val unassignedRows = grouped.unassigned
    val showSectionHeadings = grouped.showUnassignedHeading
    val settingsLabel = stringResource(com.openteam.android.R.string.directory_settings)
    Scaffold(
        topBar = {
            TopAppBar(
                title = {},
                navigationIcon = {
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
                },
                actions = {
                    IosChromeIcon(
                        icon = { Icon(Icons.Default.Search, contentDescription = null) },
                        contentDescription = stringResource(com.openteam.android.R.string.directory_search),
                        onClick = { searchVisible = !searchVisible },
                    )
                    IosChromeIcon(
                        icon = { Icon(Icons.Default.Add, contentDescription = null) },
                        contentDescription = stringResource(com.openteam.android.R.string.directory_create),
                        onClick = onRoutines,
                    )
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant,
                    scrolledContainerColor = MaterialTheme.colorScheme.surfaceVariant,
                ),
            )
        },
        bottomBar = {
            if (!searchVisible) {
                FloatingSearchBar(onClick = { searchVisible = true })
            }
        },
        containerColor = MaterialTheme.colorScheme.surfaceVariant,
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(horizontal = 20.dp)) {
            if (pinnedRows.isNotEmpty()) {
                if (pinnedRows.size == 1) {
                    // A single pinned chat sits centered; more than one scrolls from the left.
                    val pinned = pinnedRows.first()
                    Box(
                        Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 10.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        PinnedBotCard(
                            conversation = pinned,
                            unread = pinned.unread > 0 || sidebar.isUnread(pinned.id),
                            onClick = { if (share == null) onOpen(pinned) else onShareTarget(pinned.id) },
                            onLongClick = {
                                if (share == null) onTogglePin(pinned.id) else onShareTarget(pinned.id)
                            },
                        )
                    }
                } else {
                    LazyRow(
                        horizontalArrangement = Arrangement.spacedBy(18.dp),
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
            }
            if (searchVisible) {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                    singleLine = true,
                    label = { Text(stringResource(com.openteam.android.R.string.directory_search_label)) },
                    trailingIcon = {
                        if (query.isNotEmpty()) {
                            IconButton(onClick = { query = "" }) {
                                Icon(Icons.Default.Close, contentDescription = stringResource(com.openteam.android.R.string.common_clear))
                            }
                        }
                    },
                )
            }
            if (share != null) {
                Spacer(Modifier.height(8.dp))
                Card(
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    shape = RoundedCornerShape(16.dp),
                ) {
                    Column(Modifier.padding(14.dp)) {
                        Text(stringResource(com.openteam.android.R.string.directory_share_title), fontWeight = FontWeight.SemiBold)
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
                            name = stringResource(com.openteam.android.R.string.directory_section_unassigned),
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
            BotAvatar(conversation, size = 80.dp)
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
        yesterday = stringResource(com.openteam.android.R.string.directory_yesterday),
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
            BotAvatar(row, size = 46.dp)
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
                        row.preview ?: stringResource(com.openteam.android.R.string.directory_no_messages),
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
                        stringResource(
                            if (pinned) com.openteam.android.R.string.directory_unpin
                            else com.openteam.android.R.string.directory_pin,
                        ),
                    )
                },
                onClick = { onDismissMenu(); onTogglePin() },
            )
            DropdownMenuItem(
                text = { Text(stringResource(com.openteam.android.R.string.directory_bot_details)) },
                onClick = { onDismissMenu(); onBotDetails() },
            )
            sections.forEach { section ->
                DropdownMenuItem(
                    text = { Text(stringResource(com.openteam.android.R.string.directory_move_to_section, section.name)) },
                    onClick = { onDismissMenu(); onMoveToSection(section.id) },
                )
            }
            DropdownMenuItem(
                text = { Text(stringResource(com.openteam.android.R.string.directory_section_unassigned)) },
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
private fun BotAvatar(conversation: Conversation, size: androidx.compose.ui.unit.Dp) {
    val fill = conversation.avatarColor.toComposeColor()
        ?: MaterialTheme.colorScheme.secondaryContainer
    Box(
        Modifier.size(size).clip(CircleShape).background(fill),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            conversation.title.take(1).uppercase().ifBlank { "O" },
            color = if (fill.luminance() < .45f) Color.White else Color.Black,
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Medium,
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
                stringResource(com.openteam.android.R.string.directory_search_dock),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyLarge,
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
    onShare: () -> Unit,
) {
    var moreMenuVisible by remember { mutableStateOf(false) }
    var notificationsEnabled by remember { mutableStateOf(true) }
    val surface = MaterialTheme.colorScheme.surface
    val muted = MaterialTheme.colorScheme.onSurfaceVariant

    Column(
        Modifier.fillMaxSize()
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 12.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            ProfileChromeButton(
                contentDescription = stringResource(com.openteam.android.R.string.chat_back),
                onClick = onBack,
            ) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null)
            }
            Spacer(Modifier.weight(1f))
            ProfileChromeButton(
                contentDescription = stringResource(com.openteam.android.R.string.bot_share),
                onClick = onShare,
            ) {
                Icon(Icons.Default.Share, contentDescription = null)
            }
            Box {
                ProfileChromeButton(
                    contentDescription = stringResource(com.openteam.android.R.string.directory_more),
                    onClick = { moreMenuVisible = true },
                ) {
                    Icon(Icons.Default.MoreHoriz, contentDescription = null)
                }
                DropdownMenu(
                    expanded = moreMenuVisible,
                    onDismissRequest = { moreMenuVisible = false },
                ) {
                    DropdownMenuItem(
                        text = { Text(stringResource(com.openteam.android.R.string.bot_open_chat)) },
                        onClick = { moreMenuVisible = false; onOpenChat() },
                    )
                }
            }
        }

        Spacer(Modifier.height(44.dp))
        conversation?.let {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                BotAvatar(it, 128.dp)
                Spacer(Modifier.height(16.dp))
                Text(it.title, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(12.dp))
                Box(
                    Modifier.clip(CircleShape)
                        .background(MaterialTheme.colorScheme.secondaryContainer)
                        .padding(horizontal = 22.dp, vertical = 10.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Edit, contentDescription = null, modifier = Modifier.size(17.dp))
                        Spacer(Modifier.width(7.dp))
                        Text(stringResource(com.openteam.android.R.string.bot_edit), fontWeight = FontWeight.Medium)
                    }
                }
            }
        }

        Spacer(Modifier.height(36.dp))
        ProfileGroupedCard(surface) {
            ProfileCapabilityRow(
                icon = Icons.Default.AccessTime,
                title = stringResource(com.openteam.android.R.string.bot_routines_title),
                status = stringResource(com.openteam.android.R.string.bot_routines_status),
                onClick = onRoutines,
            )
            ProfileDivider(muted)
            ProfileCapabilityRow(
                icon = Icons.Default.FolderOpen,
                title = stringResource(com.openteam.android.R.string.bot_library_title),
                status = null,
                onClick = onOpenChat,
            )
            ProfileDivider(muted)
            ProfileCapabilityRow(
                icon = Icons.Default.Computer,
                title = stringResource(com.openteam.android.R.string.bot_cloud_computer),
                status = stringResource(com.openteam.android.R.string.bot_computer_idle),
                onClick = onComputer,
            )
        }

        Spacer(Modifier.height(18.dp))
        Column(
            Modifier.fillMaxWidth()
                .clip(RoundedCornerShape(24.dp))
                .background(surface)
                .border(1.dp, muted.copy(alpha = .12f), RoundedCornerShape(24.dp)),
        ) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 18.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Default.Notifications, contentDescription = null, tint = muted)
                Spacer(Modifier.width(16.dp))
                Text(
                    stringResource(com.openteam.android.R.string.bot_notifications),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier.weight(1f),
                )
                Switch(checked = notificationsEnabled, onCheckedChange = { notificationsEnabled = it })
            }
        }
        Text(
            stringResource(com.openteam.android.R.string.bot_notifications_detail),
            color = muted,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 14.dp),
        )
        Spacer(Modifier.height(20.dp))
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
        modifier = Modifier.size(64.dp)
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
        modifier = Modifier.padding(start = 70.dp),
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
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 20.dp, vertical = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(28.dp))
        Spacer(Modifier.width(22.dp))
        Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
        if (!status.isNullOrBlank()) {
            Text(status, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(12.dp))
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
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(com.openteam.android.R.string.chat_back))
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
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val renderer = remember { AndroidVncWebViewRenderer(context) }
    val rendererState by renderer.state.collectAsStateWithLifecycle()
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
        val grant = requestGrant(botId).getOrElse {
            renderer.onSocketError(it.message ?: "Unable to request the computer viewer.")
            return@LaunchedEffect
        }
        runCatching { renderer.connect(grant, URI(server), botId) }
            .onFailure { renderer.onSocketError(it.message ?: "Unable to connect to the computer.") }
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(com.openteam.android.R.string.chat_back))
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
            if (rendererState is VncRendererState.Failed || rendererState is VncRendererState.Ready) {
                Card(
                    Modifier.align(Alignment.Center).padding(24.dp),
                    colors = CardDefaults.cardColors(containerColor = Color(0xFF202020)),
                    shape = RoundedCornerShape(20.dp),
                ) {
                    Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(stringResource(com.openteam.android.R.string.computer_title), color = Color.White, style = MaterialTheme.typography.titleLarge)
                        Text(
                            if (rendererState is VncRendererState.Failed) {
                                (rendererState as VncRendererState.Failed).message
                            } else {
                                stringResource(com.openteam.android.R.string.computer_connecting)
                            },
                            color = Color.White.copy(alpha = .75f),
                        )
                    }
                }
            }
        }
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
    title: String,
    messages: List<ChatMessage>,
    targetMessageId: String?,
    draft: String,
    error: String?,
    onBack: () -> Unit,
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
) {
    val listState = rememberLazyListState()
    var forwardingAttachment by remember { mutableStateOf<Attachment?>(null) }
    val attachmentPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { onUpload(it.toString()) } }
    val contextRows = threadContext.take(com.openteam.android.data.ChatHistoryPage.DEFAULT_CONTEXT_LIMIT)
    LaunchedEffect(messages, targetMessageId, threadContext, historyLoading) {
        if (historyLoading) return@LaunchedEffect
        val index = targetMessageId?.let { id -> messages.indexOfFirst { it.id == id } }
            ?.takeIf { it >= 0 }?.let { it + if (contextRows.isNotEmpty()) 1 else 0 }
            ?: (messages.lastIndex + if (contextRows.isNotEmpty()) 1 else 0)
        if (index >= 0) listState.animateScrollToItem(index)
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
                            contentDescription = stringResource(com.openteam.android.R.string.chat_back),
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
                    is VoiceRecordingState.Recording -> voiceControls("Recording voice note", onStopVoice, onCancelVoice)
                    is VoiceRecordingState.Interrupted -> voiceControls("Recording paused", onStopVoice, onCancelVoice)
                    is VoiceRecordingState.Transcribing -> voiceControls("Transcribing…", null, onCancelVoice)
                    is VoiceRecordingState.Review -> {
                        Text(voiceState.error ?: "Transcription failed", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = onRetryVoice) { Text("Retry") }
                            TextButton(onClick = onCancelVoice) { Text("Discard") }
                        }
                    }
                    is VoiceRecordingState.Failed -> {
                        Text(voiceState.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                        TextButton(onClick = onCancelVoice) { Text("Dismiss") }
                    }
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
                    FeatureOperationState.Pending -> Text("Working…", Modifier.testTag("chat-operation-status"), style = MaterialTheme.typography.bodySmall)
                    is FeatureOperationState.Succeeded -> Text(operation.message ?: "Done", Modifier.testTag("chat-operation-status"), color = Color(0xFF277A45), style = MaterialTheme.typography.bodySmall)
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
                    isTarget = message.id == targetMessageId,
                    operation = operation,
                    onDownload = onDownload,
                    onSaveAttachment = onSaveAttachment,
                    onShareAttachment = onShareAttachment,
                    onForwardAttachment = { forwardingAttachment = it },
                    onAction = onAction,
                    onReaction = onReaction,
                    onMessageAction = onMessageAction,
                    onContext = onContext,
                )
            }
            item { Spacer(Modifier.height(4.dp)) }
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
        onStop?.let { IconButton(onClick = it) { Icon(Icons.Default.Stop, contentDescription = "Stop voice note") } }
        IconButton(onClick = onCancel) { Icon(Icons.Default.Close, contentDescription = "Cancel voice note") }
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
) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (message.isMine) Arrangement.End else Arrangement.Start) {
        Column(Modifier.fillMaxWidth(.86f)) {
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
                        Text("Replying to $reply", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    message.displayBody?.let { body ->
                        Text(body, color = if (message.isMine) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface)
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
                            onPreview = { attachment, _ -> onDownload(message.id, attachment) },
                            onDownload = { attachment, _ -> onDownload(message.id, attachment) },
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            TextButton(onClick = { onSaveAttachment(message.id, message.attachments.first()) }) { Text(stringResource(com.openteam.android.R.string.chat_save)) }
                            TextButton(onClick = { onShareAttachment(message.attachments.first()) }) { Text(stringResource(com.openteam.android.R.string.chat_share)) }
                            TextButton(onClick = { onForwardAttachment(message.attachments.first()) }) { Text(stringResource(com.openteam.android.R.string.chat_forward)) }
                        }
                    }
                    if (message.reactions.isNotEmpty() || message.richMessage != null) {
                        ReactionsAndActionsRow(
                            state = ReactionState(message.reactions, operation),
                            onReaction = { emoji -> onReaction(message.id, emoji) },
                            onAction = { action -> onMessageAction(message.id, action) },
                        )
                    }
                    if (message.replyToMessageId != null || message.contextMessageId != null || message.threadId != null) {
                        TextButton(onClick = { onContext(message.id) }) { Text(stringResource(com.openteam.android.R.string.chat_show_context)) }
                    }
                    if (message.isMine) {
                        val status = when (message.delivery) {
                            com.openteam.android.data.Delivery.SENDING -> "Sending…"
                            com.openteam.android.data.Delivery.SENT -> "Sent"
                            com.openteam.android.data.Delivery.FAILED -> "Not sent"
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
                                Text("Retry", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onPrimary)
                            }
                        }
                    }
                }
            }
        }
    }
}
