@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.openteam.features

import android.graphics.BitmapFactory
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

@Composable
private fun FeaturePage(title: String, onBack: (() -> Unit)? = null, content: @Composable () -> Unit) {
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    onBack?.let {
                        IconButton(onClick = it) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                        }
                    }
                },
                title = { Text(title) },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) { content() }
    }
}

@Composable
private fun <T> LoadStateContent(
    state: FeatureLoadState<T>,
    onRetry: () -> Unit,
    emptyAction: (@Composable () -> Unit)? = null,
    content: @Composable (T) -> Unit,
) {
    when (state) {
        FeatureLoadState.Loading -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
        is FeatureLoadState.Failure -> StateMessage(state.message, onRetry)
        is FeatureLoadState.Empty -> Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Text(state.message, color = MaterialTheme.colorScheme.onSurfaceVariant)
            emptyAction?.invoke()
        }
        is FeatureLoadState.Ready -> content(state.value)
    }
}

@Composable
private fun StateMessage(message: String, onRetry: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(message, color = MaterialTheme.colorScheme.error)
        Spacer(Modifier.height(12.dp))
        Button(onClick = onRetry) { Text("Retry") }
    }
}

@Composable
private fun OperationStatus(state: FeatureOperationState) {
    when (state) {
        FeatureOperationState.Idle -> Unit
        FeatureOperationState.Pending -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            Text("Working…", style = MaterialTheme.typography.bodySmall)
        }
        is FeatureOperationState.Succeeded -> state.message?.let { Text(it, color = MaterialTheme.colorScheme.tertiary) }
        is FeatureOperationState.Failed -> Text(state.message, color = MaterialTheme.colorScheme.error)
    }
}

@Composable
fun RichMessageCardScreen(
    message: RichMessage,
    operation: FeatureOperationState = FeatureOperationState.Idle,
    onAction: (RichMessageAction, Map<String, String>) -> Unit,
) {
    val values = remember(message.id) { mutableStateMapOf<String, String>() }
    Card(Modifier.fillMaxWidth().padding(12.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            message.blocks.forEach { block ->
                when (block) {
                    is RichMessageBlock.Markdown -> MarkdownMessage(block.text)
                    is RichMessageBlock.Code -> CodeBlock(block.language, block.code)
                    is RichMessageBlock.Math -> CodeBlock("math", block.expression)
                    is RichMessageBlock.Mermaid -> CodeBlock("mermaid", block.source)
                    is RichMessageBlock.Table -> MessageTable(block)
                    is RichMessageBlock.Card -> {
                        Text(block.title, fontWeight = FontWeight.Bold)
                        Text(block.body)
                        block.action?.let { ActionButton(it) { onAction(it, emptyMap()) } }
                    }
                    is RichMessageBlock.Form -> {
                        Text(block.title, fontWeight = FontWeight.Bold)
                        block.fields.forEach { field ->
                            OutlinedTextField(
                                value = values[field.id] ?: field.value,
                                onValueChange = { values[field.id] = it },
                                label = { Text(field.label + if (field.required) " *" else "") },
                                visualTransformation = if (field.secret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
                                modifier = Modifier.fillMaxWidth(),
                                singleLine = true,
                            )
                            if (field.options.isNotEmpty()) {
                                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    field.options.forEach { option ->
                                        FilterChip(
                                            selected = values[field.id] == option,
                                            onClick = { values[field.id] = option },
                                            label = { Text(option) },
                                        )
                                    }
                                }
                            }
                        }
                        ActionButton(block.submit) { onAction(block.submit, values.toMap() + ("_richType" to "user-form")) }
                    }
                    is RichMessageBlock.Secret -> {
                        Text(block.prompt, fontWeight = FontWeight.Bold)
                        var value by remember(message.id, block.prompt) { mutableStateOf("") }
                        OutlinedTextField(
                            value = value,
                            onValueChange = { value = it },
                            label = { Text("Secret") },
                            visualTransformation = PasswordVisualTransformation(),
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                        )
                        ActionButton(block.submit) { onAction(block.submit, mapOf("value" to value, "_richType" to "secret")) }
                    }
                    is RichMessageBlock.Approval -> {
                        Text(block.title, fontWeight = FontWeight.Bold)
                        Text(block.detail)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            ActionButton(block.approve) { onAction(block.approve, emptyMap()) }
                            ActionButton(block.reject) { onAction(block.reject, emptyMap()) }
                        }
                    }
                    is RichMessageBlock.Widget -> {
                        Text(block.prompt, fontWeight = FontWeight.Bold)
                        var selected by remember(message.id, block.prompt) { mutableStateOf(emptySet<String>()) }
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            block.options.forEach { option ->
                                FilterChip(
                                    selected = option.value in selected,
                                    onClick = { selected = if (block.multiSelect) if (option.value in selected) selected - option.value else selected + option.value else setOf(option.value) },
                                    label = { Text(option.label) },
                                )
                            }
                        }
                        ActionButton(
                            RichMessageAction("widget-response", "Submit"),
                        ) { onAction(RichMessageAction("widget-response", "Submit", route = "widget-response"), mapOf("value" to selected.joinToString("\n"), "_richType" to "widget-response")) }
                    }
                }
            }
            message.actions.forEach { action -> ActionButton(action) { onAction(action, emptyMap()) } }
            OperationStatus(operation)
        }
    }
}

@Composable
private fun CodeBlock(language: String?, code: String) {
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(12.dp)) {
        language?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary) }
        Text(code, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun MessageTable(table: RichMessageBlock.Table) {
    Column(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
        Row(Modifier.background(MaterialTheme.colorScheme.surface), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
            table.headers.forEach { Text(it, Modifier.padding(8.dp), fontWeight = FontWeight.Bold) }
        }
        table.rows.forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) { row.forEach { Text(it, Modifier.padding(8.dp)) } }
        }
    }
}

@Composable
private fun ActionButton(action: RichMessageAction, onClick: () -> Unit) {
    when (action.kind) {
        RichMessageAction.Kind.Primary -> Button(onClick = onClick, enabled = action.enabled) { Text(action.label) }
        RichMessageAction.Kind.Secondary -> OutlinedButton(onClick = onClick, enabled = action.enabled) { Text(action.label) }
        RichMessageAction.Kind.Destructive -> Button(onClick = onClick, enabled = action.enabled, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text(action.label) }
    }
}

@Composable
fun AttachmentGalleryScreen(
    state: FeatureLoadState<List<Attachment>>,
    operation: FeatureOperationState = FeatureOperationState.Idle,
    onRetry: () -> Unit,
    onAttachmentAction: (Attachment, AttachmentAction) -> Unit,
    onUpload: () -> Unit = {},
) {
    FeaturePage("Attachments") {
        LoadStateContent(state, onRetry) { attachments ->
            LazyColumn(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                item { Button(onClick = onUpload) { Text("Add attachment") } }
                items(attachments, key = { it.id }) { attachment ->
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(attachment.name, Modifier.weight(1f), fontWeight = FontWeight.Medium)
                                Text(formatBytes(attachment.sizeBytes), style = MaterialTheme.typography.labelSmall)
                            }
                            Text(attachment.mimeType, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(attachment.state.label(), style = MaterialTheme.typography.labelMedium)
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                if (attachment.state == AttachmentState.Available) {
                                    TextButton(onClick = { onAttachmentAction(attachment, AttachmentAction.Preview) }) { Text("Preview") }
                                    TextButton(onClick = { onAttachmentAction(attachment, AttachmentAction.Download) }) { Text("Download") }
                                    TextButton(onClick = { onAttachmentAction(attachment, AttachmentAction.Save) }) { Text("Save") }
                                    TextButton(onClick = { onAttachmentAction(attachment, AttachmentAction.Share) }) { Text("Share") }
                                    TextButton(onClick = { onAttachmentAction(attachment, AttachmentAction.Forward) }) { Text("Forward") }
                                }
                                if (attachment.state == AttachmentState.Failed) TextButton(onClick = { onAttachmentAction(attachment, AttachmentAction.Retry) }) { Text("Retry") }
                            }
                        }
                    }
                }
                item { OperationStatus(operation) }
            }
        }
    }
}

@Composable
fun ChatAttachmentStrip(
    attachments: List<Attachment>,
    onPreview: (Attachment, AttachmentAction) -> Unit,
    onDownload: (Attachment, AttachmentAction) -> Unit,
    onSave: (Attachment) -> Unit = {},
    onShare: (Attachment) -> Unit = {},
    onForward: (Attachment) -> Unit = {},
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        attachments.forEach { attachment ->
            Card(Modifier.fillMaxWidth()) {
                Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    val localPath = attachment.localUri
                    val bitmap = remember(localPath) { localPath?.let { BitmapFactory.decodeFile(it) } }
                    if (bitmap != null) {
                        Image(bitmap.asImageBitmap(), contentDescription = attachment.alt ?: attachment.name, modifier = Modifier.size(52.dp))
                    }
                    Column(Modifier.weight(1f).padding(start = 8.dp)) {
                        Text(attachment.name, fontWeight = FontWeight.Medium)
                        Text("${attachment.mimeType} · ${formatBytes(attachment.sizeBytes)}", style = MaterialTheme.typography.bodySmall)
                    }
                    TextButton(onClick = { onPreview(attachment, AttachmentAction.Preview) }) { Text(if (localPath == null) "Preview" else "Open") }
                    if (localPath == null) TextButton(onClick = { onDownload(attachment, AttachmentAction.Download) }) { Text("Download") }
                }
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                    TextButton(onClick = { onSave(attachment) }) { Text("Save") }
                    TextButton(onClick = { onShare(attachment) }) { Text("Share") }
                    TextButton(onClick = { onForward(attachment) }) { Text("Forward") }
                }
            }
        }
    }
}

enum class AttachmentAction { Preview, Download, Share, Save, Forward, Retry }

private fun AttachmentState.label() = when (this) {
    AttachmentState.Queued -> "Queued"
    AttachmentState.Uploading -> "Uploading…"
    AttachmentState.Available -> "Ready"
    AttachmentState.Downloading -> "Downloading…"
    AttachmentState.Failed -> "Transfer failed"
}

private fun formatBytes(value: Long): String = when {
    value < 1_024 -> "$value B"
    value < 1_024 * 1_024 -> "${value / 1_024} KB"
    else -> "${value / (1_024 * 1_024)} MB"
}

@Composable
fun ReactionsAndActionsRow(
    state: ReactionState,
    availableEmojis: List<String> = listOf("👍", "❤️", "🎉", "👀"),
    onReaction: (String) -> Unit,
    onAction: (MessageAction) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            state.reactions.forEach { reaction ->
                AssistChip(onClick = { onReaction(reaction.emoji) }, label = { Text("${reaction.emoji} ${reaction.count}") })
            }
            availableEmojis.forEach { emoji ->
                AssistChip(onClick = { onReaction(emoji) }, label = { Text(emoji) })
            }
        }
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            MessageAction.entries.forEach { action -> TextButton(onClick = { onAction(action) }) { Text(action.label) } }
        }
        OperationStatus(state.operation)
    }
}

@Composable
fun RoutinesScreen(
    state: FeatureLoadState<List<Routine>>,
    onRetry: () -> Unit,
    onAdd: () -> Unit,
    onEdit: (Routine) -> Unit,
    onToggle: (Routine) -> Unit,
    onRun: (Routine) -> Unit,
) {
    FeaturePage("Routines") {
        LoadStateContent(state, onRetry, emptyAction = { OutlinedButton(onClick = onAdd) { Text("Add routine") } }) { routines ->
            LazyColumn(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                item { Button(onClick = onAdd) { Text("Add routine") } }
                items(routines, key = { it.id }) { routine ->
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(routine.name, Modifier.weight(1f), fontWeight = FontWeight.Bold)
                                Switch(checked = routine.enabled, onCheckedChange = { onToggle(routine) })
                            }
                            Text(routine.schedule.summary(), color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(routine.prompt, maxLines = 3, style = MaterialTheme.typography.bodySmall)
                            routine.nextRunAt?.let { Text("Next: $it", style = MaterialTheme.typography.labelSmall) }
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                OutlinedButton(onClick = { onEdit(routine) }) { Text("Edit") }
                                TextButton(onClick = { onRun(routine) }) { Text("Run now") }
                            }
                            if (routine.executions.isNotEmpty()) {
                                HorizontalDivider()
                                Text("Recent runs", fontWeight = FontWeight.Medium)
                                routine.executions.take(3).forEach { execution -> Text("${execution.status} · ${execution.createdAt}", style = MaterialTheme.typography.bodySmall) }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun RoutineEditorScreen(
    routine: Routine,
    onChange: (Routine) -> Unit,
    onSave: () -> Unit,
    onDelete: (() -> Unit)? = null,
    operation: FeatureOperationState = FeatureOperationState.Idle,
) {
    var confirmDelete by remember { mutableStateOf(false) }
    FeaturePage(if (routine.id.isBlank()) "New routine" else "Edit routine") {
        LazyColumn(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                OutlinedTextField(routine.name, { onChange(routine.copy(name = it)) }, label = { Text("Routine name") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(routine.prompt, { onChange(routine.copy(prompt = it)) }, label = { Text("Instructions") }, modifier = Modifier.fillMaxWidth().height(130.dp))
            }
            item {
                Text("Frequency", fontWeight = FontWeight.Bold)
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    RoutineSchedule.Frequency.entries.forEach { frequency ->
                        FilterChip(
                            selected = routine.schedule.frequency == frequency,
                            onClick = { onChange(routine.copy(schedule = routine.schedule.copy(frequency = frequency))) },
                            label = { Text(frequency.label) },
                        )
                    }
                }
            }
            item {
                OutlinedTextField(routine.schedule.timeZone, { onChange(routine.copy(schedule = routine.schedule.copy(timeZone = it))) }, label = { Text("Time zone") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                OutlinedTextField(routine.schedule.timeMinutes.toString(), { it.toIntOrNull()?.let { minutes -> onChange(routine.copy(schedule = routine.schedule.copy(timeMinutes = minutes))) } }, label = { Text("Time of day (minutes after midnight)") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                if (routine.schedule.frequency == RoutineSchedule.Frequency.Weekly) {
                    OutlinedTextField(routine.schedule.dayOfWeek.toString(), { it.toIntOrNull()?.let { day -> onChange(routine.copy(schedule = routine.schedule.copy(dayOfWeek = day))) } }, label = { Text("Day of week (1–7)") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                }
                if (routine.schedule.frequency == RoutineSchedule.Frequency.Monthly) {
                    OutlinedTextField(routine.schedule.dayOfMonth.toString(), { it.toIntOrNull()?.let { day -> onChange(routine.copy(schedule = routine.schedule.copy(dayOfMonth = day))) } }, label = { Text("Day of month (1–31)") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                }
                if (routine.schedule.frequency == RoutineSchedule.Frequency.Interval) {
                    OutlinedTextField(routine.schedule.intervalAmount.toString(), { it.toIntOrNull()?.let { amount -> onChange(routine.copy(schedule = routine.schedule.copy(intervalAmount = amount.coerceAtLeast(1)))) } }, label = { Text("Every") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = onSave, enabled = routine.name.isNotBlank() && routine.prompt.isNotBlank()) { Text("Save") }
                    onDelete?.let { TextButton(onClick = { confirmDelete = true }) { Text("Delete", color = MaterialTheme.colorScheme.error) } }
                }
                OperationStatus(operation)
            }
        }
        if (confirmDelete) {
            AlertDialog(
                onDismissRequest = { confirmDelete = false },
                title = { Text("Delete routine?") },
                text = { Text("This removes the routine and its schedule from the server.") },
                confirmButton = { TextButton(onClick = { confirmDelete = false; onDelete?.invoke() }) { Text("Delete", color = MaterialTheme.colorScheme.error) } },
                dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
            )
        }
    }
}

@Composable
fun AccountMemoryScreen(
    state: FeatureLoadState<AccountMemoryState>,
    onRetry: () -> Unit,
    onEditMemory: (MemoryItem) -> Unit,
    onClearMemory: () -> Unit,
    onReset: () -> Unit,
    onSignOut: () -> Unit,
) {
    var pendingAction by remember { mutableStateOf<String?>(null) }
    FeaturePage("Account and memory") {
        LoadStateContent(state, onRetry) { account ->
            LazyColumn(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item {
                    Text(account.profile.displayName, style = MaterialTheme.typography.titleLarge)
                    Text(account.profile.server, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(if (account.profile.connected) "Connected" else "Offline")
                    Text("Version ${account.profile.version}", style = MaterialTheme.typography.labelSmall)
                }
                item { Text("Memory", style = MaterialTheme.typography.titleMedium) }
                if (account.memories.isEmpty()) item { Text("No saved memories yet.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
                items(account.memories, key = { it.id }) { memory ->
                    Card(Modifier.fillMaxWidth().clickable { onEditMemory(memory) }) {
                        Column(Modifier.padding(12.dp)) { Text(memory.title, fontWeight = FontWeight.Medium); Text(memory.content, maxLines = 3); Text(memory.updatedAt, style = MaterialTheme.typography.labelSmall) }
                    }
                }
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { pendingAction = "clear" }) { Text("Clear memory") }
                        TextButton(onClick = { pendingAction = "reset" }) { Text("Reset local data", color = MaterialTheme.colorScheme.error) }
                    }
                    Button(onClick = { pendingAction = "sign-out" }) { Text("Sign out") }
                }
            }
        }
        pendingAction?.let { action ->
            val title = when (action) { "clear" -> "Clear memory?"; "reset" -> "Reset local data?"; else -> "Sign out?" }
            val detail = when (action) { "clear" -> "Saved memories will be removed from the server."; "reset" -> "Local drafts and feature state will be cleared."; else -> "You will need to sign in again to use this server." }
            AlertDialog(
                onDismissRequest = { pendingAction = null },
                title = { Text(title) },
                text = { Text(detail) },
                confirmButton = {
                    TextButton(onClick = {
                        when (action) { "clear" -> onClearMemory(); "reset" -> onReset(); else -> onSignOut() }
                        pendingAction = null
                    }) { Text("Continue", color = if (action == "sign-out") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary) }
                },
                dismissButton = { TextButton(onClick = { pendingAction = null }) { Text("Cancel") } },
            )
        }
    }
}

@Composable
fun SettingsScreen(
    settings: AppSettings,
    accountName: String,
    server: String,
    onChange: (AppSettings) -> Unit,
    onSignOut: () -> Unit,
    onBack: () -> Unit,
    onProviders: () -> Unit,
    onWebProviders: () -> Unit,
    onOutbox: () -> Unit,
    onAccount: () -> Unit,
    onPlugins: () -> Unit,
    onSidebar: () -> Unit,
) {
    var confirmSignOut by remember { mutableStateOf(false) }
    val language = settings.language
    val text: (String, String) -> String = { english, chinese ->
        if (language == AppSettings.Language.Chinese) chinese else english
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = text("Back", "返回"))
                    }
                },
                title = {
                    Column {
                        Text(text("Settings", "设置"))
                        Text(
                            text("Application preferences", "应用偏好"),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
            )
        },
        containerColor = MaterialTheme.colorScheme.surfaceVariant,
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(top = 14.dp, bottom = 28.dp),
        ) {
            item {
                Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            Modifier.size(48.dp).background(MaterialTheme.colorScheme.primary, androidx.compose.foundation.shape.CircleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                accountName.take(1).uppercase().ifBlank { "O" },
                                color = MaterialTheme.colorScheme.onPrimary,
                                style = MaterialTheme.typography.titleLarge,
                            )
                        }
                        Spacer(Modifier.width(14.dp))
                        Column(Modifier.weight(1f)) {
                            Text(accountName.ifBlank { "OpenTeam" }, fontWeight = FontWeight.SemiBold)
                            Text(server, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(text("Connected", "已连接"), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.tertiary)
                        }
                    }
                }
            }

            item { SettingsSectionTitle(text("Appearance", "外观")) }
            item {
                SettingsGroup {
                    SettingsRow(text("Theme", "主题"), text("Choose the app theme", "选择应用主题")) {
                        ChoiceChips(
                            choices = AppSettings.Appearance.entries,
                            selected = settings.appearance,
                            label = { choice ->
                                when (choice) {
                                    AppSettings.Appearance.System -> text("System", "系统")
                                    AppSettings.Appearance.Light -> text("Light", "浅色")
                                    AppSettings.Appearance.Dark -> text("Dark", "深色")
                                }
                            },
                            onSelected = { onChange(settings.copy(appearance = it)) },
                        )
                    }
                    SettingsRow(text("Accent", "强调色"), text("Choose the interface accent", "选择界面强调色")) {
                        ChoiceChips(
                            choices = AppSettings.Accent.entries,
                            selected = settings.accent,
                            label = { choice ->
                                when (choice) {
                                    AppSettings.Accent.Black -> text("Black", "黑色")
                                    AppSettings.Accent.Blue -> text("Blue", "蓝色")
                                    AppSettings.Accent.Purple -> text("Purple", "紫色")
                                    AppSettings.Accent.Green -> text("Green", "绿色")
                                }
                            },
                            onSelected = { onChange(settings.copy(accent = it)) },
                        )
                    }
                }
            }

            item { SettingsSectionTitle(text("Language", "语言")) }
            item {
                SettingsGroup {
                    SettingsRow(text("Interface language", "界面语言"), text("Choose the language used by settings", "选择设置界面使用的语言")) {
                        ChoiceChips(
                            choices = AppSettings.Language.entries,
                            selected = language,
                            label = { choice -> if (choice == AppSettings.Language.Chinese) "中文" else "English" },
                            onSelected = { onChange(settings.copy(language = it)) },
                        )
                    }
                }
            }

            item { SettingsSectionTitle(text("Preferences", "偏好设置")) }
            item {
                SettingsGroup {
                    SettingsRow(text("Time zone", "时区"), text("Used for routines and timestamps", "用于例行任务和时间戳"), inline = false) {
                        OutlinedTextField(
                            value = settings.timeZone,
                            onValueChange = { onChange(settings.copy(timeZone = it)) },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            label = { Text(text("Time zone", "时区")) },
                        )
                    }
                    SettingsRow(text("App haptics", "应用触感反馈"), text("Vibrate for important interactions", "重要交互时提供震动反馈")) {
                        Switch(checked = settings.haptics, onCheckedChange = { onChange(settings.copy(haptics = it)) })
                    }
                }
            }

            item { SettingsSectionTitle(text("Notifications", "通知")) }
            item {
                SettingsGroup {
                    SettingsToggleRow(text("Messages", "消息"), text("Notify about new messages", "新消息提醒"), settings.notifications.messages) {
                        onChange(settings.copy(notifications = settings.notifications.copy(messages = it)))
                    }
                    SettingsToggleRow(text("Mentions", "提及"), text("Notify when you are mentioned", "有人提及时提醒"), settings.notifications.mentions) {
                        onChange(settings.copy(notifications = settings.notifications.copy(mentions = it)))
                    }
                    SettingsToggleRow(text("Routine runs", "例行任务运行"), text("Notify when scheduled work runs", "计划任务运行时提醒"), settings.notifications.routineRuns) {
                        onChange(settings.copy(notifications = settings.notifications.copy(routineRuns = it)))
                    }
                }
            }

            item { SettingsSectionTitle(text("Connections", "连接")) }
            item {
                SettingsGroup {
                    SettingsActionRow(
                        text("Message outbox", "消息发件箱"),
                        text("Retry messages that could not be delivered", "重试无法投递的消息"),
                        text("Open", "打开"),
                        onOutbox,
                    )
                    SettingsActionRow(text("Account and memory", "账户与记忆"), text("Review account data and saved memories", "查看账户数据和已保存的记忆"), text("Open", "打开"), onAccount)
                    SettingsActionRow(text("Plugins", "插件"), text("Manage installed connections and tools", "管理已安装的连接和工具"), text("Open", "打开"), onPlugins)
                    SettingsActionRow(text("Organize conversations", "整理会话"), text("Rename sections and manage hidden conversations", "重命名分区并管理隐藏会话"), text("Open", "打开"), onSidebar)
                    SettingsActionRow(text("AI model", "AI 模型"), text("Choose the provider and model used by bots", "选择 Bot 使用的服务商和模型"), text("Open", "打开"), onProviders)
                    SettingsActionRow(text("Web providers", "网络服务商"), text("Choose search and page-fetch services", "选择搜索和网页抓取服务"), text("Open", "打开"), onWebProviders)
                }
            }

            item {
                SettingsGroup {
                    Row(Modifier.fillMaxWidth().padding(14.dp), horizontalArrangement = Arrangement.End) {
                        TextButton(onClick = { confirmSignOut = true }) {
                            Text(text("Sign out", "退出登录"), color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
        }
    }

    if (confirmSignOut) {
        AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            title = { Text(text("Sign out?", "退出登录？")) },
            text = { Text(text("You will need to sign in again to use this server.", "你需要重新登录才能使用此服务器。")) },
            confirmButton = {
                TextButton(onClick = { confirmSignOut = false; onSignOut() }) {
                    Text(text("Sign out", "退出登录"), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { confirmSignOut = false }) { Text(text("Cancel", "取消")) } },
        )
    }
}

@Composable
private fun SettingsSectionTitle(title: String) {
    Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
}

@Composable
private fun SettingsGroup(content: @Composable ColumnScope.() -> Unit) {
    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(content = content)
    }
}

@Composable
private fun SettingsRow(title: String, description: String, inline: Boolean = true, content: @Composable () -> Unit) {
    BoxWithConstraints(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 13.dp),
    ) {
        val stacked = !inline || maxWidth < 520.dp
        if (stacked) {
            Column(
                Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(9.dp),
            ) {
                Column(Modifier.widthIn(max = 360.dp)) {
                    Text(title, fontWeight = FontWeight.Medium)
                    Text(
                        description,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Box(
                    Modifier.fillMaxWidth(),
                    contentAlignment = Alignment.CenterEnd,
                ) {
                    content()
                }
            }
        } else {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(
                    Modifier.weight(1f).widthIn(max = 320.dp),
                ) {
                    Text(title, fontWeight = FontWeight.Medium)
                    Text(
                        description,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                content()
            }
        }
    }
}

@Composable
private fun SettingsToggleRow(title: String, description: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    SettingsRow(title, description) {
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

@Composable
private fun SettingsActionRow(title: String, description: String, action: String, onClick: () -> Unit) {
    SettingsRow(title, description) {
        TextButton(onClick = onClick) { Text(action) }
    }
}

@Composable
private fun <T> ChoiceChips(choices: List<T>, selected: T, label: (T) -> String, onSelected: (T) -> Unit) {
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        choices.forEach { choice ->
            FilterChip(
                selected = choice == selected,
                onClick = { onSelected(choice) },
                label = { Text(label(choice)) },
            )
        }
    }
}

@Composable
private fun <T> ChoiceRow(title: String, choices: List<T>, selected: T, onSelected: (T) -> Unit, label: (T) -> String) {
    Column { Text(title, style = MaterialTheme.typography.labelLarge); choices.forEach { choice -> Row(verticalAlignment = Alignment.CenterVertically) { RadioButton(selected = choice == selected, onClick = { onSelected(choice) }); Text(label(choice)) } } }
}

@Composable
private fun NotificationToggle(label: String, enabled: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) { Text(label, modifier = Modifier.weight(1f)); Switch(checked = enabled, onCheckedChange = onChange) }
}

@Composable
fun ProviderSettingsScreen(
    state: FeatureLoadState<List<ProviderConnection>>,
    onRetry: () -> Unit,
    onBack: () -> Unit,
    language: AppSettings.Language,
    onConnect: (ProviderConnection, String?) -> Unit,
    onDisconnect: (ProviderConnection) -> Unit,
    onModelChange: (ProviderConnection, String) -> Unit,
    onReasoningChange: (ProviderConnection, String) -> Unit,
) {
    var pendingDisconnect by remember { mutableStateOf<ProviderConnection?>(null) }
    val text: (String, String) -> String = { english, chinese -> if (language == AppSettings.Language.Chinese) chinese else english }
    FeaturePage(text("AI model", "AI 模型"), onBack = onBack) {
        LoadStateContent(state, onRetry) { providers ->
            LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp), contentPadding = androidx.compose.foundation.layout.PaddingValues(top = 14.dp, bottom = 28.dp)) {
                item { SettingsSectionTitle(text("Choose the provider and model used by bots.", "选择 Bot 使用的服务商和模型。")) }
                items(providers, key = { it.id }) { provider ->
                    SettingsGroup {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(provider.name, Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                                Text(
                                    if (provider.connected) text("Connected", "已连接") else text("Disconnected", "未连接"),
                                    style = MaterialTheme.typography.labelMedium,
                                    color = if (provider.connected) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            provider.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                            if (!provider.connected) {
                                if (provider.authMode == AuthMode.ApiKey) {
                                    var apiKey by remember(provider.id) { mutableStateOf("") }
                                    OutlinedTextField(apiKey, { apiKey = it }, label = { Text(if (provider.apiKeySaved) text("Replace API key", "替换 API 密钥") else text("API key", "API 密钥")) }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), singleLine = true)
                                    Button(onClick = { onConnect(provider.copy(apiKeySaved = true), apiKey.takeIf { it.isNotBlank() }); apiKey = "" }, enabled = apiKey.isNotBlank() || provider.apiKeySaved) { Text(text("Save and connect", "保存并连接")) }
                                } else {
                                    Button(onClick = { onConnect(provider, null) }) { Text(if (provider.authMode == AuthMode.OAuth) text("Connect with OAuth", "使用 OAuth 连接") else text("Connect", "连接")) }
                                }
                            }
                            else {
                                SettingsRow(text("Model", "模型"), text("Used by this provider", "此服务商使用的模型"), inline = false) {
                                    ChoiceChips(provider.models, provider.selectedModel ?: provider.models.firstOrNull().orEmpty(), { it }) { onModelChange(provider, it) }
                                }
                                SettingsRow(text("Reasoning", "推理强度"), text("How much effort the model uses", "模型使用的推理强度"), inline = false) {
                                    ChoiceChips(provider.reasoningLevels, provider.selectedReasoning ?: provider.reasoningLevels.firstOrNull().orEmpty(), { it }) { onReasoningChange(provider, it) }
                                }
                                TextButton(onClick = { pendingDisconnect = provider }) { Text(text("Disconnect", "断开连接"), color = MaterialTheme.colorScheme.error) }
                            }
                        }
                    }
                }
            }
        }
        pendingDisconnect?.let { provider ->
            AlertDialog(
                onDismissRequest = { pendingDisconnect = null },
                title = { Text(text("Disconnect ${provider.name}?", "断开 ${provider.name}？")) },
                text = { Text(text("The server will remove this provider connection and its selected model.", "服务器将移除此服务商连接及其已选模型。")) },
                confirmButton = { TextButton(onClick = { pendingDisconnect = null; onDisconnect(provider) }) { Text(text("Disconnect", "断开连接"), color = MaterialTheme.colorScheme.error) } },
                dismissButton = { TextButton(onClick = { pendingDisconnect = null }) { Text(text("Cancel", "取消")) } },
            )
        }
    }
}

@Composable
fun WebProviderSettingsScreen(
    state: FeatureLoadState<WebProvidersState>,
    onRetry: () -> Unit,
    onBack: () -> Unit,
    language: AppSettings.Language,
    onSelect: (tool: String, provider: WebProvider) -> Unit,
    onSaveKey: (tool: String, provider: WebProvider, key: String) -> Unit,
    onRemoveKey: (tool: String, provider: WebProvider) -> Unit,
    onCheck: (tool: String, provider: WebProvider) -> Unit,
) {
    val text: (String, String) -> String = { english, chinese -> if (language == AppSettings.Language.Chinese) chinese else english }
    FeaturePage(text("Web providers", "网络服务商"), onBack = onBack) {
        LoadStateContent(state, onRetry) { providers ->
            LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp), contentPadding = androidx.compose.foundation.layout.PaddingValues(top = 14.dp, bottom = 28.dp)) {
                item { WebProviderTool(text("Search", "搜索"), text("The service bots use to find information on the web.", "Bot 用于在网络上查找信息的服务。"), "search", providers.search, language, onSelect, onSaveKey, onRemoveKey, onCheck) }
                item { WebProviderTool(text("Fetch", "抓取"), text("How bots read a web page without opening their browser.", "Bot 不打开浏览器时读取网页的方式。"), "fetch", providers.fetch, language, onSelect, onSaveKey, onRemoveKey, onCheck) }
            }
        }
    }
}

@Composable
private fun WebProviderTool(
    title: String,
    description: String,
    tool: String,
    providers: List<WebProvider>,
    language: AppSettings.Language,
    onSelect: (String, WebProvider) -> Unit,
    onSaveKey: (String, WebProvider, String) -> Unit,
    onRemoveKey: (String, WebProvider) -> Unit,
    onCheck: (String, WebProvider) -> Unit,
) {
    val text: (String, String) -> String = { english, chinese -> if (language == AppSettings.Language.Chinese) chinese else english }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SettingsSectionTitle(title)
        Text(description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        providers.forEach { provider ->
            var key by remember(provider.id) { mutableStateOf("") }
            var confirmRemove by remember(provider.id) { mutableStateOf(false) }
            SettingsGroup {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = provider.selected, onClick = { if (provider.ready || !provider.requiresApiKey) onSelect(tool, provider) })
                        Column(Modifier.weight(1f)) { Text(provider.name, fontWeight = FontWeight.Medium); Text(provider.description, style = MaterialTheme.typography.bodySmall) }
                        Text(if (provider.check?.passed == true) text("Checked", "已检查") else if (provider.requiresApiKey && !provider.ready) text("Add API key", "添加 API 密钥") else text("Not checked", "未检查"), style = MaterialTheme.typography.labelSmall)
                    }
                    if (provider.requiresApiKey) {
                        OutlinedTextField(key, { key = it }, label = { Text(if (provider.secretSaved) text("Replace API key", "替换 API 密钥") else text("API key", "API 密钥")) }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), singleLine = true)
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            Button(onClick = { onSaveKey(tool, provider, key); key = "" }, enabled = key.isNotBlank()) { Text(text("Save", "保存")) }
                            if (provider.secretSaved && !provider.selected) TextButton(onClick = { confirmRemove = true }) { Text(text("Remove key", "删除密钥")) }
                            TextButton(onClick = { onCheck(tool, provider) }, enabled = provider.ready || key.isNotBlank()) { Text(text("Check", "检查")) }
                        }
                    }
                    provider.check?.let { check -> Text(check.message, color = if (check.passed) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.error) }
                    if (confirmRemove) {
                        AlertDialog(
                            onDismissRequest = { confirmRemove = false },
                            title = { Text(text("Remove API key?", "删除 API 密钥？")) },
                            text = { Text(text("The saved key for ${provider.name} will be removed from the server.", "服务器将删除 ${provider.name} 的已保存密钥。")) },
                            confirmButton = { TextButton(onClick = { confirmRemove = false; onRemoveKey(tool, provider) }) { Text(text("Remove", "删除"), color = MaterialTheme.colorScheme.error) } },
                            dismissButton = { TextButton(onClick = { confirmRemove = false }) { Text(text("Cancel", "取消")) } },
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun PluginsScreen(
    state: FeatureLoadState<List<Plugin>>,
    onRetry: () -> Unit,
    onInstall: (Plugin) -> Unit,
    onUpdate: (Plugin) -> Unit,
    onRollback: (Plugin) -> Unit,
    onAuthorize: (Plugin) -> Unit,
    onCancelAuthorization: (Plugin) -> Unit,
    onConfigure: (Plugin, JsonObject) -> Unit,
    onTestTool: (Plugin) -> Unit,
) {
    FeaturePage("Plugins") {
        LoadStateContent(state, onRetry, emptyAction = { Text("No plugins available.") }) { plugins ->
            var filter by remember { mutableStateOf("") }
            val authorizationPending = plugins.any { it.authorizationUrl != null }
            LaunchedEffect(authorizationPending) {
                while (authorizationPending) {
                    delay(2_000)
                    onRetry()
                }
            }
            Column(Modifier.fillMaxSize().padding(12.dp)) {
                OutlinedTextField(filter, { filter = it }, label = { Text("Filter plugins") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                Spacer(Modifier.height(8.dp))
                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(plugins.filter { filter.isBlank() || it.name.contains(filter, true) || it.description.contains(filter, true) }, key = { "${it.id}:${it.connectionId ?: "plugin"}" }) { plugin ->
                        var confirmRollback by remember(plugin.id, plugin.connectionId) { mutableStateOf(false) }
                        var configure by remember(plugin.id, plugin.connectionId) { mutableStateOf(false) }
                        var configuration by remember(plugin.id, plugin.connectionId) { mutableStateOf("{}") }
                        Card(Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) { Text(plugin.name, Modifier.weight(1f), fontWeight = FontWeight.Bold); Text(plugin.installedVersion ?: "Not installed", style = MaterialTheme.typography.labelSmall) }
                                Text(plugin.description)
                                plugin.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                    if (plugin.installedVersion == null) Button(onClick = { onInstall(plugin) }, enabled = !plugin.busy) { Text("Install") }
                                    else {
                                        if (plugin.latestVersion != null && plugin.latestVersion != plugin.installedVersion) TextButton(onClick = { onUpdate(plugin) }, enabled = !plugin.busy) { Text("Update") }
                                        TextButton(onClick = { confirmRollback = true }, enabled = !plugin.busy) { Text("Rollback") }
                                        TextButton(onClick = { configure = true }, enabled = !plugin.busy) { Text("Configure") }
                                        TextButton(onClick = { onTestTool(plugin) }, enabled = !plugin.busy) { Text("Test tool") }
                                    }
                                    if (plugin.requiresOAuth && !plugin.configured && plugin.authorizationUrl == null) TextButton(onClick = { onAuthorize(plugin) }, enabled = !plugin.busy) { Text("Authorize") }
                                    if (plugin.authorizationUrl != null) {
                                        Text("Waiting for browser sign-in", style = MaterialTheme.typography.labelSmall)
                                        TextButton(onClick = { onCancelAuthorization(plugin) }, enabled = !plugin.busy) { Text("Cancel") }
                                    }
                                }
                                if (plugin.busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                            }
                        }
                        if (configure) {
                            AlertDialog(
                                onDismissRequest = { configure = false },
                                title = { Text("Configure ${plugin.name}") },
                                text = {
                                    OutlinedTextField(
                                        value = configuration,
                                        onValueChange = { configuration = it },
                                        label = { Text("Configuration JSON") },
                                        modifier = Modifier.fillMaxWidth(),
                                        minLines = 5,
                                    )
                                },
                                confirmButton = {
                                    TextButton(onClick = {
                                        runCatching { Json.parseToJsonElement(configuration).jsonObject }
                                            .onSuccess { onConfigure(plugin, it); configure = false }
                                    }) { Text("Save") }
                                },
                                dismissButton = { TextButton(onClick = { configure = false }) { Text("Cancel") } },
                            )
                        }
                        if (confirmRollback) {
                            AlertDialog(
                                onDismissRequest = { confirmRollback = false },
                                title = { Text("Roll back ${plugin.name}?") },
                                text = { Text("The server will restore the previous installed plugin version.") },
                                confirmButton = { TextButton(onClick = { confirmRollback = false; onRollback(plugin) }) { Text("Roll back", color = MaterialTheme.colorScheme.error) } },
                                dismissButton = { TextButton(onClick = { confirmRollback = false }) { Text("Cancel") } },
                            )
                        }
                    }
                }
            }
        }
    }
}
