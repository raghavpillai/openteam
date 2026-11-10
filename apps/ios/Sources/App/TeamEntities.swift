import AppIntents
import CoreSpotlight
import CoreTransferable
import UniformTypeIdentifiers

struct TeamBotEntity: IndexedEntity, Transferable {
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Bot"
  static let defaultQuery = TeamBotQuery()
  var id: String
  @Property(title: "Name") var name: String
  @Property(title: "Role") var role: String
  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(name)", subtitle: "\(role)")
  }
  var attributeSet: CSSearchableItemAttributeSet {
    let attributes = CSSearchableItemAttributeSet(contentType: .text)
    attributes.title = name
    attributes.contentDescription = role
    return attributes
  }
  init(_ bot: Bot, scope: String) {
    id = SystemEntityID(scope: scope, kind: .bot, channelID: bot.dmChannelId, localID: bot.id).value
    name = bot.name
    role = bot.title
  }
  init(id: String, name: String, role: String) {
    self.id = id; self.name = name; self.role = role
  }
  static var transferRepresentation: some TransferRepresentation {
    DataRepresentation(exportedContentType: .plainText) { entity in try await exportText(entity) }
  }
  @MainActor private static func exportText(_ entity: TeamBotEntity) async throws -> Data {
    // Resolve against the live account before exporting content to another app.
    let client = try await SystemIntentClient.connect()
    _ = try client.identifier(entity.id, kind: .bot)
    let live: TeamBotEntity
    let target = try client.destination(entity.id, kind: .bot)
    guard let bot = target.bot else { throw APIError("This Bot is no longer available.") }
    live = TeamBotEntity(bot, scope: client.scope)
    try client.validateSession()
    return Data(([live.name, live.role].filter { !$0.isEmpty }.joined(separator: ": ")).utf8)
  }
}

struct TeamBotQuery: EntityStringQuery, EnumerableEntityQuery {
  @MainActor func allEntities() async throws -> [Entity] { try await entities(matching: "") }
  @MainActor func entities(for identifiers: [String]) async throws -> [TeamBotEntity] {
    if let cached = try SavedBotDirectory.entities(for: identifiers) { return cached }
    let directory = try await SavedBotDirectory.liveEntities(matching: "")
    return try identifiers.map { value in
      guard let entity = directory.first(where: { $0.id == value }) else {
        throw APIError("This conversation is no longer available in OpenTeam.")
      }
      return entity
    }
  }
  @MainActor func suggestedEntities() async throws -> [TeamBotEntity] { try await entities(matching: "") }
  @MainActor func entities(matching string: String) async throws -> [TeamBotEntity] {
    if let cached = try SavedBotDirectory.entities(matching: string) { return cached }
    return try await SavedBotDirectory.liveEntities(matching: string)
  }
}

struct TeamConversationEntity: IndexedEntity, Transferable {
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Conversation"
  static let defaultQuery = TeamConversationQuery()
  var id: String
  @Property(title: "Name") var name: String
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
  var attributeSet: CSSearchableItemAttributeSet {
    let attributes = CSSearchableItemAttributeSet(contentType: .text)
    attributes.title = name
    return attributes
  }
  init(_ target: ShareDestination, scope: String) {
    id = SystemEntityID(scope: scope, kind: .conversation, channelID: target.id, localID: target.id).value
    name = target.name
  }
  static var transferRepresentation: some TransferRepresentation {
    DataRepresentation(exportedContentType: .plainText) { entity in try await exportText(entity) }
  }
  @MainActor private static func exportText(_ entity: TeamConversationEntity) async throws -> Data {
    // Resolve against the live account before exporting content to another app.
    let client = try await SystemIntentClient.connect()
    _ = try client.identifier(entity.id, kind: .conversation)
    let live: TeamConversationEntity
    live = TeamConversationEntity(try client.destination(entity.id, kind: .conversation), scope: client.scope)
    try client.validateSession()
    return Data((live.name).utf8)
  }
}

struct TeamConversationQuery: EntityStringQuery, EnumerableEntityQuery {
  @MainActor func allEntities() async throws -> [Entity] { try await entities(matching: "") }
  @MainActor func entities(for identifiers: [String]) async throws -> [TeamConversationEntity] {
    let client = try await SystemIntentClient.connect()
    return try identifiers.map {
      TeamConversationEntity(try client.destination($0, kind: .conversation), scope: client.scope)
    }
  }
  @MainActor func suggestedEntities() async throws -> [TeamConversationEntity] { try await entities(matching: "") }
  @MainActor func entities(matching string: String) async throws -> [TeamConversationEntity] {
    let client = try await SystemIntentClient.connect()
    return ShareDirectory.visible(client.destinations, query: string, selected: []).map {
      TeamConversationEntity($0, scope: client.scope)
    }
  }
}

struct TeamMessageEntity: IndexedEntity, Transferable {
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Message"
  static let defaultQuery = TeamMessageQuery()
  var id: String
  @Property(title: "Text") var text: String
  @Property(title: "Conversation") var conversation: String
  @Property(title: "Date") var date: Date
  @Property(title: "Attachments") var attachments: [TeamAttachmentEntity]
  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(String(text.prefix(160)))", subtitle: "\(conversation)")
  }
  var attributeSet: CSSearchableItemAttributeSet {
    let attributes = CSSearchableItemAttributeSet(contentType: .text)
    attributes.title = String(text.prefix(160))
    attributes.contentDescription = String(text.prefix(16_000))
    attributes.contentCreationDate = date
    attributes.relatedUniqueIdentifier = SystemEntityID(id)?.channelID
    return attributes
  }
  init(_ message: Message, name: String, scope: String) {
    id = SystemEntityID(scope: scope, kind: .message, channelID: message.channelId, localID: message.id).value
    text = message.displayContent
    conversation = name
    date = message.date ?? .distantPast
    attachments = message.attachments.map { TeamAttachmentEntity($0, message: message, scope: scope) }
  }
  static var transferRepresentation: some TransferRepresentation {
    DataRepresentation(exportedContentType: .plainText) { entity in
      let client = try await SystemIntentClient.connect()
      guard let message = try await client.messages(for: [entity.id]).first else {
        throw APIError("This message is no longer available.")
      }
      return Data(message.content.utf8)
    }
  }
}

struct TeamMessageQuery: EntityStringQuery {
  @MainActor func entities(for identifiers: [String]) async throws -> [TeamMessageEntity] {
    let client = try await SystemIntentClient.connect()
    let messages = try await client.messages(for: identifiers)
    return messages.map { message in
      TeamMessageEntity(message,
        name: client.destinations.first { $0.id == message.channelId }?.name ?? "OpenTeam",
        scope: client.scope)
    }
  }
  @MainActor func suggestedEntities() async throws -> [TeamMessageEntity] {
    let client = try await SystemIntentClient.connect()
    return client.bootstrap.latestMessages.prefix(10).map { message in
      TeamMessageEntity(message,
        name: client.destinations.first { $0.id == message.channelId }?.name ?? "OpenTeam",
        scope: client.scope)
    }
  }
  @MainActor func entities(matching string: String) async throws -> [TeamMessageEntity] {
    let client = try await SystemIntentClient.connect()
    let messages = try await client.searchMessages(string)
    return messages.map { message in
      TeamMessageEntity(message,
        name: client.destinations.first { $0.id == message.channelId }?.name ?? "OpenTeam",
        scope: client.scope)
    }
  }
}

struct TeamRoutineEntity: AppEntity, Transferable {
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Routine"
  static let defaultQuery = TeamRoutineQuery()
  var id: String
  @Property(title: "Name") var name: String
  @Property(title: "Conversation") var conversation: String
  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(name)", subtitle: "\(conversation)")
  }
  init(id: String, name: String, conversation: String) {
    self.id = id; self.name = name; self.conversation = conversation
  }
  static var transferRepresentation: some TransferRepresentation {
    DataRepresentation(exportedContentType: .plainText) { entity in try await exportText(entity) }
  }
  @MainActor private static func exportText(_ entity: TeamRoutineEntity) async throws -> Data {
    // Resolve against the live account before exporting content to another app.
    let client = try await SystemIntentClient.connect()
    _ = try client.identifier(entity.id, kind: .routine)
    let live: TeamRoutineEntity
    let routine = try await client.routine(entity.id)
    let target = try client.destination(entity.id, kind: .routine)
    live = TeamRoutineEntity(id: entity.id, name: routine.name, conversation: target.name)
    try client.validateSession()
    return Data((live.name + " (" + live.conversation + ")").utf8)
  }
}

struct TeamRoutineQuery: EntityStringQuery, EnumerableEntityQuery {
  @MainActor func allEntities() async throws -> [Entity] { try await entities(matching: "") }
  @MainActor func entities(for identifiers: [String]) async throws -> [TeamRoutineEntity] {
    let client = try await SystemIntentClient.connect()
    var results: [TeamRoutineEntity] = []
    for value in identifiers {
      let routine = try await client.routine(value)
      let target = try client.destination(value, kind: .routine)
      results.append(TeamRoutineEntity(id: value, name: routine.name, conversation: target.name))
    }
    return results
  }
  @MainActor func suggestedEntities() async throws -> [TeamRoutineEntity] { try await entities(matching: "") }
  @MainActor func entities(matching string: String) async throws -> [TeamRoutineEntity] {
    let client = try await SystemIntentClient.connect()
    return try await client.routines(matching: string)
  }
}

struct TeamAttachmentEntity: AppEntity, Transferable {
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Attachment"
  static let defaultQuery = TeamAttachmentQuery()
  var id: String
  @Property(title: "File name") var fileName: String
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(fileName)") }
  init(_ asset: Asset, message: Message, scope: String) {
    let localID = (try! JSONEncoder().encode([message.id, asset.assetId, asset.fileName])).base64EncodedString()
    id = SystemEntityID(scope: scope, kind: .attachment, channelID: message.channelId, localID: localID).value
    fileName = asset.fileName
  }
  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(exportedContentType: .data) { entity in
      let client = try await SystemIntentClient.connect()
      return SentTransferredFile(try await client.exportAttachment(entity.id))
    }
  }
}

struct TeamAttachmentQuery: EntityQuery {
  @MainActor func entities(for identifiers: [String]) async throws -> [TeamAttachmentEntity] {
    let client = try await SystemIntentClient.connect()
    var results: [TeamAttachmentEntity] = []
    for value in identifiers {
      let (message, asset) = try await client.attachment(value)
      results.append(TeamAttachmentEntity(asset, message: message, scope: client.scope))
    }
    return results
  }
}
