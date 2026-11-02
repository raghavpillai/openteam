package com.openteam.features


/** Shared UI state used by feature screens while live operations are in flight. */
sealed interface FeatureLoadState<out T> {
    data object Loading : FeatureLoadState<Nothing>
    data class Ready<T>(val value: T) : FeatureLoadState<T>
    data class Empty<T>(val message: String) : FeatureLoadState<T>
    data class Failure<T>(val message: String, val retryable: Boolean = true) : FeatureLoadState<T>
}

sealed interface FeatureOperationState {
    data object Idle : FeatureOperationState
    data object Pending : FeatureOperationState
    data class Succeeded(val message: String? = null) : FeatureOperationState
    data class Failed(val message: String, val retryable: Boolean = true) : FeatureOperationState
}

data class RichMessage(
    val id: String,
    val blocks: List<RichMessageBlock>,
    val actions: List<RichMessageAction> = emptyList(),
    val metadata: Map<String, String> = emptyMap(),
)

sealed interface RichMessageBlock {
    data class Markdown(val text: String) : RichMessageBlock
    data class Code(val language: String?, val code: String) : RichMessageBlock
    data class Table(val headers: List<String>, val rows: List<List<String>>) : RichMessageBlock
    data class Math(val expression: String) : RichMessageBlock
    data class Mermaid(val source: String) : RichMessageBlock
    data class Card(val title: String, val body: String, val action: RichMessageAction? = null) : RichMessageBlock
    data class Form(val title: String, val fields: List<RichFormField>, val submit: RichMessageAction) : RichMessageBlock
    data class Approval(val title: String, val detail: String, val approve: RichMessageAction, val reject: RichMessageAction) : RichMessageBlock
    data class Widget(
        val prompt: String,
        val options: List<RichWidgetOption>,
        val multiSelect: Boolean = false,
        val allowCustom: Boolean = false,
        val dismissOnMoveOn: Boolean = false,
    ) : RichMessageBlock
}

data class RichMessageAction(
    val id: String,
    val label: String,
    val kind: Kind = Kind.Primary,
    val enabled: Boolean = true,
) {
    enum class Kind { Primary, Secondary, Destructive }
}

data class RichFormField(
    val id: String,
    val label: String,
    val value: String = "",
    val secret: Boolean = false,
    val required: Boolean = false,
    val options: List<String> = emptyList(),
)

data class RichWidgetOption(
    val label: String,
    val value: String = label,
    val description: String? = null,
    val style: String? = null,
)

data class Attachment(
    val id: String,
    val name: String,
    val mimeType: String,
    val sizeBytes: Long,
    val localUri: String? = null,
    val state: AttachmentState = AttachmentState.Available,
    val kind: String = "file",
    val width: Int? = null,
    val height: Int? = null,
    val alt: String? = null,
)

enum class AttachmentState { Queued, Uploading, Available, Downloading, Failed }

data class Reaction(val emoji: String, val count: Int, val selected: Boolean = false)

data class ReactionState(
    val reactions: List<Reaction> = emptyList(),
    val operation: FeatureOperationState = FeatureOperationState.Idle,
)

enum class MessageAction(val label: String) { Fork("Fork"), Stop("Stop"), Dismiss("Dismiss"), Approve("Approve") }

data class Routine(
    val id: String,
    val name: String,
    val prompt: String,
    val schedule: RoutineSchedule,
    val enabled: Boolean = true,
    val revision: Int = 0,
    val nextRunAt: String? = null,
    val executions: List<RoutineExecution> = emptyList(),
)

data class RoutineExecution(val id: String, val status: String, val createdAt: String)

data class RoutineSchedule(
    val frequency: Frequency = Frequency.Daily,
    val timeMinutes: Int = 9 * 60,
    val timeZone: String = "UTC",
    val dayOfWeek: Int = 1,
    val dayOfMonth: Int = 1,
    val intervalAmount: Int = 1,
    val intervalUnit: IntervalUnit = IntervalUnit.Days,
) {
    enum class Frequency(val label: String) { Hourly("Hourly"), Daily("Daily"), Weekdays("Weekdays"), Weekly("Weekly"), Monthly("Monthly"), Interval("Interval") }
    enum class IntervalUnit(val label: String) { Minutes("minutes"), Hours("hours"), Days("days"), Weeks("weeks") }

    fun summary(): String {
        val safeMinutes = timeMinutes.coerceIn(0, 23 * 60 + 59)
        val hour = safeMinutes / 60
        val minute = safeMinutes % 60
        val time = "%02d:%02d".format(hour, minute)
        return when (frequency) {
            Frequency.Hourly -> "Every hour at :%02d".format(minute)
            Frequency.Daily -> "Daily at $time"
            Frequency.Weekdays -> "Weekdays at $time"
            Frequency.Weekly -> "Weekly on ${weekdayName(dayOfWeek)} at $time"
            Frequency.Monthly -> "Monthly on the ${ordinal(dayOfMonth)} at $time"
            Frequency.Interval -> "Every $intervalAmount ${intervalUnit.label}"
        } + " ($timeZone)"
    }

    companion object {
        private fun weekdayName(day: Int) = listOf("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")[(day - 1).coerceIn(0, 6)]
        private fun ordinal(value: Int): String {
            val suffix = if (value % 100 in 11..13) "th" else when (value % 10) { 1 -> "st"; 2 -> "nd"; 3 -> "rd"; else -> "th" }
            return "$value$suffix"
        }
    }
}

data class AccountProfile(
    val displayName: String,
    val server: String,
    val connected: Boolean,
    val version: String,
)

data class MemoryItem(val id: String, val title: String, val content: String, val updatedAt: String)

data class AccountMemoryState(val profile: AccountProfile, val memories: List<MemoryItem> = emptyList())

data class AppSettings(
    val appearance: Appearance = Appearance.System,
    val accent: Accent = Accent.Black,
    val timeZone: String = "UTC",
    val haptics: Boolean = true,
    val notifications: NotificationPreferences = NotificationPreferences(),
) {
    enum class Appearance { System, Light, Dark }
    enum class Accent { Black, Blue, Purple, Green }
}

data class NotificationPreferences(
    val messages: Boolean = true,
    val mentions: Boolean = true,
    val routineRuns: Boolean = true,
)

data class ProviderConnection(
    val id: String,
    val name: String,
    val connected: Boolean,
    val authMode: AuthMode = AuthMode.None,
    val apiKeySaved: Boolean = false,
    val models: List<String> = emptyList(),
    val selectedModel: String? = null,
    val reasoningLevels: List<String> = emptyList(),
    val selectedReasoning: String? = null,
    val error: String? = null,
    val authorizationUrl: String? = null,
)

enum class AuthMode { None, OAuth, ApiKey }

data class WebProvider(
    val id: String,
    val name: String,
    val description: String,
    val requiresApiKey: Boolean,
    val secretSaved: Boolean = false,
    val ready: Boolean = false,
    val selected: Boolean = false,
    val check: WebProviderCheck? = null,
)

data class WebProviderCheck(val passed: Boolean, val message: String, val checkedAt: String? = null)

data class WebProvidersState(
    val search: List<WebProvider> = emptyList(),
    val fetch: List<WebProvider> = emptyList(),
)

data class Plugin(
    val id: String,
    val name: String,
    val description: String,
    val installedVersion: String? = null,
    val latestVersion: String? = null,
    val requiresOAuth: Boolean = false,
    val configured: Boolean = false,
    val busy: Boolean = false,
    val error: String? = null,
    val pluginKey: String = id,
    val connectionId: String? = null,
    val authorizationUrl: String? = null,
    val authorizationState: String? = null,
    val authorizationRedirectUrl: String? = null,
    val oauthCallbackMode: String? = null,
    val setupPhase: String? = null,
)

interface FeatureGateway {
    suspend fun submitRichAction(messageId: String, actionId: String, values: Map<String, String> = emptyMap()): Result<Unit>
    suspend fun uploadAttachment(uri: String): Result<Attachment>
    suspend fun downloadAttachment(attachmentId: String): Result<String>
    suspend fun saveAttachment(attachmentId: String): Result<String>
    suspend fun forwardAttachment(attachmentId: String, destinationId: String): Result<Unit>
    suspend fun mutateReaction(messageId: String, emoji: String): Result<List<Reaction>>
    suspend fun mutateMessageAction(messageId: String, action: MessageAction): Result<Unit>
    suspend fun listRoutines(ownerId: String): Result<List<Routine>>
    suspend fun saveRoutine(ownerId: String, routine: Routine): Result<Routine>
    suspend fun setRoutineEnabled(routineId: String, enabled: Boolean, expectedRevision: Int): Result<Routine>
    suspend fun runRoutine(routineId: String): Result<Unit>
    suspend fun deleteRoutine(routineId: String, expectedRevision: Int): Result<Unit>
    suspend fun loadAccountMemory(): Result<AccountMemoryState>
    suspend fun loadSettings(): Result<AppSettings>
    suspend fun clearMemory(): Result<Unit>
    suspend fun resetLocalData(): Result<Unit>
    suspend fun signOut(): Result<Unit>
    suspend fun saveSettings(settings: AppSettings): Result<AppSettings>
    suspend fun listProviderConnections(): Result<List<ProviderConnection>>
    suspend fun saveProvider(provider: ProviderConnection, apiKey: String? = null): Result<ProviderConnection>
    suspend fun disconnectProvider(providerId: String): Result<Unit>
    suspend fun loadWebProviders(): Result<WebProvidersState>
    suspend fun saveWebProvider(tool: String, providerId: String, apiKey: String?, selected: Boolean): Result<WebProvidersState>
    suspend fun checkWebProvider(tool: String, providerId: String): Result<WebProviderCheck>
    suspend fun listPlugins(): Result<List<Plugin>>
    suspend fun installPlugin(pluginId: String): Result<Plugin>
    suspend fun updatePlugin(pluginId: String): Result<Plugin>
    suspend fun rollbackPlugin(pluginId: String): Result<Plugin>
    suspend fun authorizePlugin(pluginId: String): Result<Plugin>
    suspend fun cancelPluginAuthorization(pluginId: String, state: String, redirectUrl: String? = null): Result<Unit>
    suspend fun completePluginAuthorization(pluginId: String, callbackUrl: String): Result<Unit>
    suspend fun testPluginTool(pluginId: String, toolName: String, input: String): Result<String>
}
