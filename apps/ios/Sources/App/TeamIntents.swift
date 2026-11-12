import AppIntents

struct SendBotTaskIntent: AppIntent {
  static let title: LocalizedStringResource = "Send a task to a Bot"
  static let description = IntentDescription("Send instructions to an OpenTeam Bot. The Bot keeps working on your server.")
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  @Parameter(title: "Bot", description: "The existing OpenTeam Bot that should receive the task.") var bot: TeamBotEntity
  @Parameter(title: "Instructions", description: "The task to send now. Sending starts asynchronous work; it does not return the Bot’s completed answer.", inputConnectionBehavior: .connectToPreviousIntentResult) var instructions: String
  @Parameter(title: "Attachments", description: "Files the user wants the Bot to use for this task.", default: []) var attachments: [IntentFile]
  static var parameterSummary: some ParameterSummary {
    Summary("Ask \(\.$bot) to \(\.$instructions)") { \.$attachments }
  }
  @MainActor func perform() async throws -> some IntentResult & ReturnsValue<TeamMessageEntity> & ProvidesDialog {
    let client = try await SystemIntentClient.connect()
    let target = try client.destination(bot.id, kind: .bot)
    let message = try await client.send(to: target, text: instructions, files: attachments)
    return .result(value: TeamMessageEntity(message, name: target.name, scope: client.scope),
      dialog: "Sent to \(target.name). Your Bot will continue working on your server.")
  }
}

struct OpenTeamConversationIntent: OpenIntent {
  static let description = IntentDescription("Open an existing Bot or group conversation in OpenTeam.")
  static let title: LocalizedStringResource = "Open a conversation"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let openAppWhenRun = true
  @Parameter(title: "Conversation") var target: TeamConversationEntity
  @Dependency var store: AppStore
  @MainActor func perform() async throws -> some IntentResult {
    let client = try await SystemIntentClient.connect()
    _ = try client.destination(target.id, kind: .conversation)
    try await store.openSystemItem(target.id)
    return .result()
  }
}

struct OpenTeamBotIntent: OpenIntent {
  static let title: LocalizedStringResource = "Open a Bot"
  static let description = IntentDescription("Open a chosen Bot's conversation in OpenTeam. Save the Bot in a shortcut to use it with Back Tap or the Action button.")
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let openAppWhenRun = true
  @available(iOS 26.0, *)
  static var supportedModes: IntentModes { .foreground(.immediate) }
  @Parameter(title: "Bot") var target: TeamBotEntity
  static var parameterSummary: some ParameterSummary { Summary("Open \(\.$target)") }
  @Dependency var store: AppStore
  @MainActor func perform() async throws -> some IntentResult {
    guard SystemEntityID(target.id)?.kind == .bot else { throw APIError("Choose a Bot to open.") }
    try await store.openSystemItem(target.id)
    return .result()
  }
}

struct RecordBotVoiceNoteIntent: AudioRecordingIntent {
  static let title: LocalizedStringResource = "Record a voice note to a Bot"
  static let description = IntentDescription("Open a chosen Bot and start hands-free voice-note recording. Tap Send to transcribe and send, or discard the recording. Works with a saved shortcut assigned to Back Tap or the Action button.")
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let openAppWhenRun = true
  @available(iOS 26.0, *)
  static var supportedModes: IntentModes { .foreground(.immediate) }
  @Parameter(title: "Bot") var bot: TeamBotEntity
  @Dependency var store: AppStore
  static var parameterSummary: some ParameterSummary { Summary("Record a voice note to \(\.$bot)") }
  @MainActor func perform() async throws -> some IntentResult {
    try await store.openSystemItem(bot.id, recordVoiceNote: true)
    return .result()
  }
}

struct OpenTeamMessageIntent: OpenIntent {
  static let description = IntentDescription("Show a specific existing message in its original OpenTeam conversation.")
  static let title: LocalizedStringResource = "Open a message"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let openAppWhenRun = true
  @Parameter(title: "Message") var target: TeamMessageEntity
  @Dependency var store: AppStore
  @MainActor func perform() async throws -> some IntentResult {
    try await store.openSystemItem(target.id)
    return .result()
  }
}

struct RunTeamRoutineIntent: AppIntent {
  static let title: LocalizedStringResource = "Run an OpenTeam routine"
  static let description = IntentDescription("Start an existing saved routine once on your OpenTeam server. This starts asynchronous work; it does not change its schedule or return completed results.")
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  @Parameter(title: "Routine", description: "The existing saved routine explicitly requested by the user.") var routine: TeamRoutineEntity
  static var parameterSummary: some ParameterSummary { Summary("Run \(\.$routine)") }
  @MainActor func perform() async throws -> some IntentResult & ProvidesDialog {
    let client = try await SystemIntentClient.connect()
    let resolved = try await client.routine(routine.id)
    try client.validateSession()
    _ = try await client.api.request("/api/v0/routines/\(API.segment(resolved.id))/test",
      method: "POST", body: .object(["clientId": .string(UUID().uuidString)]))
    try client.validateSession()
    return .result(dialog: "Started \(resolved.name) on your OpenTeam server.")
  }
}

struct FindTeamMessagesIntent: AppIntent {
  static let description = IntentDescription("Search committed messages on the connected OpenTeam server, including messages older than the recent on-device index. Returns matching messages, not a generated answer.")
  static let title: LocalizedStringResource = "Find OpenTeam messages"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  @Parameter(title: "Search", description: "Words or a phrase to search for in existing messages.") var query: String
  static var parameterSummary: some ParameterSummary { Summary("Find messages matching \(\.$query)") }
  func perform() async throws -> some IntentResult & ReturnsValue<[TeamMessageEntity]> {
    .result(value: try await TeamMessageQuery().entities(matching: query))
  }
}

struct TeamAppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(intent: OpenTeamBotIntent(), phrases: [
      "Open a bot in \(.applicationName)",
      "Open bot \(\.$target) in \(.applicationName)",
    ], shortTitle: "Open a Bot", systemImageName: "bubble.left")
    AppShortcut(intent: RecordBotVoiceNoteIntent(), phrases: [
      "Record a voice note in \(.applicationName)",
      "Talk to \(\.$bot) in \(.applicationName)",
    ], shortTitle: "Record to a Bot", systemImageName: "mic")
    AppShortcut(intent: SendBotTaskIntent(), phrases: [
      "Send a task with \(.applicationName)",
      "Ask \(\.$bot) in \(.applicationName)",
    ], shortTitle: "Ask a Bot", systemImageName: "bubble.left.and.text.bubble.right")
    AppShortcut(intent: OpenTeamConversationIntent(), phrases: [
      "Open a conversation in \(.applicationName)",
      "Open \(\.$target) in \(.applicationName)",
    ], shortTitle: "Open conversation", systemImageName: "bubble.left.and.bubble.right")
    AppShortcut(intent: RunTeamRoutineIntent(), phrases: [
      "Run a routine in \(.applicationName)",
      "Run \(\.$routine) in \(.applicationName)",
    ], shortTitle: "Run routine", systemImageName: "clock.arrow.circlepath")
    AppShortcut(intent: FindTeamMessagesIntent(), phrases: [
      "Find messages in \(.applicationName)",
    ], shortTitle: "Find messages", systemImageName: "magnifyingglass")
  }
}

// Scope the new marker conformance rather than the intent type itself. Existing
// saved Shortcuts keep their identifiers and remain available back to iOS 18.
// Enable only with the Siri preview SDK; stable SDKs can share its compiler version.
// Messages-schema intents are already Siri tools; adding ToolIntent to those is invalid.
#if OPENTEAM_SIRI_AI_PREVIEW
@available(iOS 27.3, *)
extension SendBotTaskIntent: ToolIntent {}
@available(iOS 27.3, *)
extension RunTeamRoutineIntent: ToolIntent {}
@available(iOS 27.3, *)
extension FindTeamMessagesIntent: ToolIntent {}
@available(iOS 27.3, *)
extension OpenTeamBotIntent: ToolIntent {}
@available(iOS 27.3, *)
extension OpenTeamConversationIntent: ToolIntent {}
@available(iOS 27.3, *)
extension OpenTeamMessageIntent: ToolIntent {}
#endif

struct SendTeamConversationMessageIntent: AppIntent {
  static let title: LocalizedStringResource = "Send a message to a conversation"
  static let description = IntentDescription("Send instructions, text and files to one specific existing OpenTeam conversation. Use this for a named group even when another group has the same members. The returned message acknowledges acceptance; Bot work continues asynchronously.")
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  @Parameter(title: "Conversation", description: "The exact existing Bot or group conversation to receive the message.") var conversation: TeamConversationEntity
  @Parameter(title: "Message", description: "Text to send now, including any requested links.") var text: String
  @Parameter(title: "Attachments", description: "Files the user wants to send.", default: []) var attachments: [IntentFile]
  static var parameterSummary: some ParameterSummary { Summary("Send \(\.$text) to \(\.$conversation)") { \.$attachments } }
  @MainActor func perform() async throws -> some IntentResult & ReturnsValue<TeamMessageEntity> & ProvidesDialog {
    let client = try await SystemIntentClient.connect()
    let target = try client.destination(conversation.id, kind: .conversation)
    let message = try await client.send(to: target, text: text, files: attachments)
    return .result(value: TeamMessageEntity(message, name: target.name, scope: client.scope),
      dialog: "Sent to \(target.name). Your Bots will continue working on your server.")
  }
}

struct DraftTeamConversationMessageIntent: AppIntent {
  static let title: LocalizedStringResource = "Draft a message to a conversation"
  static let description = IntentDescription("Open a draft for review in a specific existing OpenTeam conversation. Appends to any existing draft and never sends it.")
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let openAppWhenRun = true
  @Parameter(title: "Conversation", description: "The exact existing Bot or group conversation for this draft.") var conversation: TeamConversationEntity
  @Parameter(title: "Message", description: "The draft text, including any requested links.") var text: String
  @Parameter(title: "Attachments", description: "Files to attach to the draft.", default: []) var attachments: [IntentFile]
  @Dependency var store: AppStore
  static var parameterSummary: some ParameterSummary { Summary("Draft \(\.$text) to \(\.$conversation)") { \.$attachments } }
  @MainActor func perform() async throws -> some IntentResult {
    let client = try await SystemIntentClient.connect()
    let target = try client.destination(conversation.id, kind: .conversation)
    let assets = try await client.upload(attachments)
    try await store.openSystemItem(TeamConversationEntity(target, scope: client.scope).id,
      draft: text, attachments: assets)
    return .result()
  }
}

#if OPENTEAM_SIRI_AI_PREVIEW
@available(iOS 27.3, *)
extension SendTeamConversationMessageIntent: ToolIntent {}
@available(iOS 27.3, *)
extension DraftTeamConversationMessageIntent: ToolIntent {}
#endif
