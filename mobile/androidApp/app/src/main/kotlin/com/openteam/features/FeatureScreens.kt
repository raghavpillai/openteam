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
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

@Composable
private fun FeaturePage(title: String, content: @Composable () -> Unit) {
    Scaffold(topBar = { TopAppBar(title = { Text(title) }) }) { padding ->
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
        is FeatureOperationState.Succeeded -> state.message?.let { Text(it, color = Color(0xFF277A45)) }
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
                    is RichMessageBlock.Markdown -> Text(block.text, style = MaterialTheme.typography.bodyLarge)
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
                        ActionButton(block.submit) { onAction(block.submit, values.toMap()) }
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
                        ) { onAction(RichMessageAction("widget-response", "Submit"), mapOf("value" to selected.joinToString("\n"))) }
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
fun SettingsScreen(settings: AppSettings, onChange: (AppSettings) -> Unit, onSignOut: () -> Unit) {
    var confirmSignOut by remember { mutableStateOf(false) }
    FeaturePage("Settings") {
        LazyColumn(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { Text("Appearance", style = MaterialTheme.typography.titleMedium) }
            item { ChoiceRow("Theme", AppSettings.Appearance.entries, settings.appearance, { onChange(settings.copy(appearance = it)) }, { it.name }) }
            item { ChoiceRow("Accent", AppSettings.Accent.entries, settings.accent, { onChange(settings.copy(accent = it)) }, { it.name }) }
            item { OutlinedTextField(settings.timeZone, { onChange(settings.copy(timeZone = it)) }, label = { Text("Time zone") }, modifier = Modifier.fillMaxWidth(), singleLine = true) }
            item { Row(verticalAlignment = Alignment.CenterVertically) { Text("App haptics", modifier = Modifier.weight(1f)); Switch(checked = settings.haptics, onCheckedChange = { onChange(settings.copy(haptics = it)) }) } }
            item { Text("Notifications", style = MaterialTheme.typography.titleMedium) }
            item { NotificationToggle("Messages", settings.notifications.messages) { onChange(settings.copy(notifications = settings.notifications.copy(messages = it))) } }
            item { NotificationToggle("Mentions", settings.notifications.mentions) { onChange(settings.copy(notifications = settings.notifications.copy(mentions = it))) } }
            item { NotificationToggle("Routine runs", settings.notifications.routineRuns) { onChange(settings.copy(notifications = settings.notifications.copy(routineRuns = it))) } }
            item { TextButton(onClick = { confirmSignOut = true }) { Text("Sign out", color = MaterialTheme.colorScheme.error) } }
        }
        if (confirmSignOut) {
            AlertDialog(
                onDismissRequest = { confirmSignOut = false },
                title = { Text("Sign out?") },
                text = { Text("You will need to sign in again to use this server.") },
                confirmButton = { TextButton(onClick = { confirmSignOut = false; onSignOut() }) { Text("Sign out", color = MaterialTheme.colorScheme.error) } },
                dismissButton = { TextButton(onClick = { confirmSignOut = false }) { Text("Cancel") } },
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
    onConnect: (ProviderConnection, String?) -> Unit,
    onDisconnect: (ProviderConnection) -> Unit,
    onModelChange: (ProviderConnection, String) -> Unit,
    onReasoningChange: (ProviderConnection, String) -> Unit,
) {
    var pendingDisconnect by remember { mutableStateOf<ProviderConnection?>(null) }
    FeaturePage("Providers") {
        LoadStateContent(state, onRetry) { providers ->
            LazyColumn(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(providers, key = { it.id }) { provider ->
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) { Text(provider.name, Modifier.weight(1f), fontWeight = FontWeight.Bold); Text(if (provider.connected) "Connected" else "Disconnected") }
                            provider.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                            if (!provider.connected) {
                                if (provider.authMode == AuthMode.ApiKey) {
                                    var apiKey by remember(provider.id) { mutableStateOf("") }
                                    OutlinedTextField(apiKey, { apiKey = it }, label = { Text(if (provider.apiKeySaved) "Replace API key" else "API key") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), singleLine = true)
                                    Button(onClick = { onConnect(provider.copy(apiKeySaved = true), apiKey.takeIf { it.isNotBlank() }); apiKey = "" }, enabled = apiKey.isNotBlank() || provider.apiKeySaved) { Text("Save and connect") }
                                } else {
                                    Button(onClick = { onConnect(provider, null) }) { Text(if (provider.authMode == AuthMode.OAuth) "Connect with OAuth" else "Connect") }
                                }
                            }
                            else {
                                ChoiceRow("Model", provider.models, provider.selectedModel ?: provider.models.firstOrNull().orEmpty(), { onModelChange(provider, it) }, { it })
                                ChoiceRow("Reasoning", provider.reasoningLevels, provider.selectedReasoning ?: provider.reasoningLevels.firstOrNull().orEmpty(), { onReasoningChange(provider, it) }, { it })
                                TextButton(onClick = { pendingDisconnect = provider }) { Text("Disconnect") }
                            }
                        }
                    }
                }
            }
        }
        pendingDisconnect?.let { provider ->
            AlertDialog(
                onDismissRequest = { pendingDisconnect = null },
                title = { Text("Disconnect ${provider.name}?") },
                text = { Text("The server will remove this provider connection and its selected model.") },
                confirmButton = { TextButton(onClick = { pendingDisconnect = null; onDisconnect(provider) }) { Text("Disconnect", color = MaterialTheme.colorScheme.error) } },
                dismissButton = { TextButton(onClick = { pendingDisconnect = null }) { Text("Cancel") } },
            )
        }
    }
}

@Composable
fun WebProviderSettingsScreen(
    state: FeatureLoadState<WebProvidersState>,
    onRetry: () -> Unit,
    onSelect: (tool: String, provider: WebProvider) -> Unit,
    onSaveKey: (tool: String, provider: WebProvider, key: String) -> Unit,
    onRemoveKey: (tool: String, provider: WebProvider) -> Unit,
    onCheck: (tool: String, provider: WebProvider) -> Unit,
) {
    FeaturePage("Web providers") {
        LoadStateContent(state, onRetry) { providers ->
            LazyColumn(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item { WebProviderTool("Search", "search", providers.search, onSelect, onSaveKey, onRemoveKey, onCheck) }
                item { WebProviderTool("Fetch", "fetch", providers.fetch, onSelect, onSaveKey, onRemoveKey, onCheck) }
            }
        }
    }
}

@Composable
private fun WebProviderTool(
    title: String,
    tool: String,
    providers: List<WebProvider>,
    onSelect: (String, WebProvider) -> Unit,
    onSaveKey: (String, WebProvider, String) -> Unit,
    onRemoveKey: (String, WebProvider) -> Unit,
    onCheck: (String, WebProvider) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(if (tool == "search") "The service bots use to find information on the web." else "How bots read a web page without opening their browser.", style = MaterialTheme.typography.bodySmall)
        providers.forEach { provider ->
            var key by remember(provider.id) { mutableStateOf("") }
            var confirmRemove by remember(provider.id) { mutableStateOf(false) }
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = provider.selected, onClick = { if (provider.ready || !provider.requiresApiKey) onSelect(tool, provider) })
                        Column(Modifier.weight(1f)) { Text(provider.name, fontWeight = FontWeight.Medium); Text(provider.description, style = MaterialTheme.typography.bodySmall) }
                        Text(if (provider.check?.passed == true) "Checked" else if (provider.requiresApiKey && !provider.ready) "Add API key" else "Not checked", style = MaterialTheme.typography.labelSmall)
                    }
                    if (provider.requiresApiKey) {
                        OutlinedTextField(key, { key = it }, label = { Text(if (provider.secretSaved) "Replace API key" else "API key") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), singleLine = true)
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            Button(onClick = { onSaveKey(tool, provider, key); key = "" }, enabled = key.isNotBlank()) { Text("Save") }
                            if (provider.secretSaved && !provider.selected) TextButton(onClick = { confirmRemove = true }) { Text("Remove key") }
                            TextButton(onClick = { onCheck(tool, provider) }, enabled = provider.ready || key.isNotBlank()) { Text("Check") }
                        }
                    }
                    provider.check?.let { check -> Text(check.message, color = if (check.passed) Color(0xFF277A45) else MaterialTheme.colorScheme.error) }
                    if (confirmRemove) {
                        AlertDialog(
                            onDismissRequest = { confirmRemove = false },
                            title = { Text("Remove API key?") },
                            text = { Text("The saved key for ${provider.name} will be removed from the server.") },
                            confirmButton = { TextButton(onClick = { confirmRemove = false; onRemoveKey(tool, provider) }) { Text("Remove", color = MaterialTheme.colorScheme.error) } },
                            dismissButton = { TextButton(onClick = { confirmRemove = false }) { Text("Cancel") } },
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
    onConfigure: (Plugin) -> Unit,
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
                                        TextButton(onClick = { onConfigure(plugin) }, enabled = !plugin.busy) { Text("Configure") }
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
