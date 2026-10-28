import AppIntents

struct SendBotTaskIntent: AppIntent {
  static let title: LocalizedStringResource = "Send a task to a Bot"
  static let description = IntentDescription("Send instructions to an OpenTeam Bot. The Bot keeps working on your server.")
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  @Parameter(title: "Bot") var bot: TeamBotEntity
  @Parameter(title: "Instructions", inputConnectionBehavior: .connectToPreviousIntentResult) var instructions: String
  @Parameter(title: "Attachments", default: []) var attachments: [IntentFile]
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
  static let description = IntentDescription("Open a chosen Bot's conversation in OpenTeam. Save the Bot in a shortcut to use it with the Action button.")
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let openAppWhenRun = true
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
  static let description = IntentDescription("Open a chosen Bot and start hands-free voice-note recording. Tap Send to transcribe and send, or discard the recording. Works with a saved shortcut and the Action button.")
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let openAppWhenRun = true
  @Parameter(title: "Bot") var bot: TeamBotEntity
  @Dependency var store: AppStore
  static var parameterSummary: some ParameterSummary { Summary("Record a voice note to \(\.$bot)") }
  @MainActor func perform() async throws -> some IntentResult {
    try await store.openSystemItem(bot.id, recordVoiceNote: true)
    return .result()
  }
}

struct OpenTeamMessageIntent: OpenIntent {
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
  static let description = IntentDescription("Start a saved routine once on your OpenTeam server.")
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  @Parameter(title: "Routine") var routine: TeamRoutineEntity
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
  static let title: LocalizedStringResource = "Find OpenTeam messages"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  @Parameter(title: "Search") var query: String
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
