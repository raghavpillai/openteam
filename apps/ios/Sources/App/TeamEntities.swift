import AppIntents
import CoreSpotlight
import CoreTransferable
import UniformTypeIdentifiers

struct TeamBotEntity: IndexedEntity {
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
}

struct TeamBotQuery: EntityStringQuery {
  @MainActor func entities(for identifiers: [String]) async throws -> [TeamBotEntity] {
    let client = try await SystemIntentClient.connect()
    return try identifiers.compactMap { value in
      try client.destination(value, kind: .bot).bot.map { TeamBotEntity($0, scope: client.scope) }
    }
  }
  @MainActor func suggestedEntities() async throws -> [TeamBotEntity] { try await entities(matching: "") }
  @MainActor func entities(matching string: String) async throws -> [TeamBotEntity] {
    let client = try await SystemIntentClient.connect()
    return client.destinations.filter {
      string.isEmpty ? !$0.hidden : $0.name.localizedStandardContains(string)
    }.compactMap { $0.bot.map { TeamBotEntity($0, scope: client.scope) } }
  }
}

struct TeamConversationEntity: IndexedEntity {
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
}

struct TeamConversationQuery: EntityStringQuery {
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

struct TeamRoutineEntity: AppEntity {
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
}

struct TeamRoutineQuery: EntityStringQuery {
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
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Attachment"
  static let defaultQuery = TeamAttachmentQuery()
  var id: String
  @Property(title: "File name") var fileName: String
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(fileName)") }
  init(_ asset: Asset, message: Message, scope: String) {
    let localID = (try! JSONEncoder().encode([message.id, asset.assetId])).base64EncodedString()
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
