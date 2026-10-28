import AppIntents
import CoreSpotlight
import CoreTransferable
import GeoToolbox
import LinkPresentation
import UniformTypeIdentifiers

// The Messages domain arrived in iOS 27. Older systems use TeamEntities and
// explicit App Shortcut phrases, while these schemas enable Siri AI reasoning.
@available(iOS 27.0, *)
@AppEntity(schema: .messages.messagePerson)
struct TeamSiriPerson: IndexedEntity, Transferable {
  static let defaultQuery = TeamSiriPersonQuery()
  var id: String
  var person: IntentPerson
  let name: String
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
  init(id: String, name: String, isMe: Bool = false) {
    self.id = id
    self.name = name
    person = IntentPerson(identifier: .applicationDefined(id), name: .displayName(name),
      handle: nil, isMe: isMe)
  }
  init(_ bot: Bot, scope: String) {
    self.init(id: TeamBotEntity(bot, scope: scope).id, name: bot.name)
  }
  static var transferRepresentation: some TransferRepresentation {
    IntentValueRepresentation(exporting: \.person)
  }
}

@available(iOS 27.0, *)
struct TeamSiriPersonQuery: EntityStringQuery, IntentValueQuery, IndexedEntityQuery {
  @MainActor func entities(for identifiers: [String]) async throws -> [TeamSiriPerson] {
    let client = try await SystemIntentClient.connect()
    return try identifiers.compactMap { value in
      let id = try client.identifier(value, kind: .bot)
      // User authors are resolvable for message context but never send targets.
      if id.localID == "owner" {
        return TeamSiriPerson(id: value, name: client.session.displayName, isMe: true)
      }
      return try client.destination(value, kind: .bot).bot.map { TeamSiriPerson($0, scope: client.scope) }
    }
  }
  @MainActor func suggestedEntities() async throws -> [TeamSiriPerson] { try await entities(matching: "") }
  @MainActor func entities(matching string: String) async throws -> [TeamSiriPerson] {
    let client = try await SystemIntentClient.connect()
    return client.destinations.filter {
      string.isEmpty ? !$0.hidden : $0.name.localizedStandardContains(string)
    }.compactMap { $0.bot.map { TeamSiriPerson($0, scope: client.scope) } }
  }
  @MainActor func values(for input: [IntentPerson]) async throws -> [TeamSiriPerson] {
    let client = try await SystemIntentClient.connect()
    return client.destinations.compactMap { target in
      guard let bot = target.bot else { return nil }
      let entity = TeamSiriPerson(bot, scope: client.scope)
      return input.contains { person in
        if case .applicationDefined(let id) = person.identifier { return id == entity.id }
        if case .displayName(let name) = person.name {
          return name.localizedCaseInsensitiveCompare(bot.name) == .orderedSame
        }
        return false
      } ? entity : nil
    }
  }
  func reindexEntities(for identifiers: [String], indexDescription: CSSearchableIndexDescription) async throws {
    try await SystemDiscovery.shared.reindex()
  }
  func reindexAllEntities(indexDescription: CSSearchableIndexDescription) async throws {
    try await SystemDiscovery.shared.reindex()
  }
}

@available(iOS 27.0, *)
@AppEntity(schema: .messages.conversation)
struct TeamSiriConversation: IndexedEntity {
  static let defaultQuery = TeamSiriConversationQuery()
  var id: String
  var recipients: [TeamSiriPerson]
  var displayName: String
  var previewText: AttributedString
  var conversationName: String?
  var isRead: Bool
  var attributes: Set<TeamSiriConversationAttribute>
  var dateLastActive: Date?
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(displayName)") }
  init(_ target: ShareDestination, scope: String) {
    id = TeamConversationEntity(target, scope: scope).id
    recipients = target.members.map { TeamSiriPerson($0, scope: scope) }
    displayName = target.name
    previewText = AttributedString("")
    conversationName = target.channel.isGroup ? target.name : nil
    isRead = (target.channel.unreadCount ?? 0) == 0
    attributes = []
    dateLastActive = target.lastActivity
  }
}

@available(iOS 27.0, *)
struct TeamSiriConversationQuery: EntityStringQuery, IndexedEntityQuery {
  @MainActor func entities(for identifiers: [String]) async throws -> [TeamSiriConversation] {
    let client = try await SystemIntentClient.connect()
    return try identifiers.map {
      TeamSiriConversation(try client.destination($0, kind: .conversation), scope: client.scope)
    }
  }
  @MainActor func suggestedEntities() async throws -> [TeamSiriConversation] { try await entities(matching: "") }
  @MainActor func entities(matching string: String) async throws -> [TeamSiriConversation] {
    let client = try await SystemIntentClient.connect()
    return ShareDirectory.visible(client.destinations, query: string, selected: []).map {
      TeamSiriConversation($0, scope: client.scope)
    }
  }
  func reindexEntities(for identifiers: [String], indexDescription: CSSearchableIndexDescription) async throws {
    try await SystemDiscovery.shared.reindex()
  }
  func reindexAllEntities(indexDescription: CSSearchableIndexDescription) async throws {
    try await SystemDiscovery.shared.reindex()
  }
}

@available(iOS 27.0, *)
@AppEntity(schema: .messages.message)
struct TeamSiriMessage: IndexedEntity, Transferable {
  static let defaultQuery = TeamSiriMessageQuery()
  var id: String
  var messageType: TeamSiriMessageType
  var author: TeamSiriPerson
  var isRead: Bool
  var attributes: Set<TeamSiriMessageAttribute>
  var conversation: TeamSiriConversation
  var date: Date
  var subject: AttributedString?
  var body: AttributedString?
  // Download only when Siri asks for files, never while indexing text.
  @DeferredProperty var attachments: [IntentFile] {
    get async throws {
      let client = try await SystemIntentClient.connect()
      guard let message = try await client.messages(for: [id]).first else { return [] }
      var files: [IntentFile] = []
      for asset in message.attachments {
        let entity = await TeamAttachmentEntity(asset, message: message, scope: client.scope)
        files.append(IntentFile(fileURL: try await client.exportAttachment(entity.id), filename: asset.fileName,
          type: UTType(mimeType: asset.mimeType)))
      }
      return files
    }
  }
  var audioMessage: IntentFile?
  var customAttachments: [TeamSiriCustomAttachment]
  var locations: [PlaceDescriptor]
  var links: [LinkPresentation.LinkMetadata]
  var messageEffect: TeamSiriMessageEffect?
  var reaction: TeamSiriMessageReaction?
  var referencedMessage: TeamSiriMessage?
  var notificationIdentifier: String?
  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(String((body ?? AttributedString("")).characters.prefix(160)))",
      subtitle: "\(conversation.displayName)")
  }
  var attributeSet: CSSearchableItemAttributeSet {
    let attributes = CSSearchableItemAttributeSet(contentType: .text)
    attributes.contentDescription = String((body ?? AttributedString("")).characters.prefix(16_000))
    attributes.contentCreationDate = date
    return attributes
  }
  init(_ message: Message, target: ShareDestination, scope: String, owner: String) {
    id = SystemEntityID(scope: scope, kind: .message, channelID: message.channelId, localID: message.id).value
    messageType = .unspecified
    if message.isUser {
      author = TeamSiriPerson(id: SystemEntityID(scope: scope, kind: .bot,
        channelID: message.channelId, localID: "owner").value, name: owner, isMe: true)
    } else if let bot = target.members.first(where: { $0.id == message.senderBotId }) ?? target.bot {
      author = TeamSiriPerson(bot, scope: scope)
    } else {
      author = TeamSiriPerson(id: id, name: "OpenTeam")
    }
    isRead = (target.channel.unreadCount ?? 0) == 0
    attributes = []
    conversation = TeamSiriConversation(target, scope: scope)
    date = message.date ?? .distantPast
    body = AttributedString(message.displayContent)
    customAttachments = []
    locations = []
    links = []
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

@available(iOS 27.0, *)
struct TeamSiriMessageQuery: EntityStringQuery, IndexedEntityQuery {
  @MainActor func entities(for identifiers: [String]) async throws -> [TeamSiriMessage] {
    let client = try await SystemIntentClient.connect()
    return try await client.messages(for: identifiers).compactMap { message in
      guard let target = client.destinations.first(where: { $0.id == message.channelId }) else { return nil }
      return TeamSiriMessage(message, target: target, scope: client.scope, owner: client.session.displayName)
    }
  }
  @MainActor func entities(matching string: String) async throws -> [TeamSiriMessage] {
    let client = try await SystemIntentClient.connect()
    return try await client.searchMessages(string).compactMap { message in
      guard let target = client.destinations.first(where: { $0.id == message.channelId }) else { return nil }
      return TeamSiriMessage(message, target: target, scope: client.scope, owner: client.session.displayName)
    }
  }
  func reindexEntities(for identifiers: [String], indexDescription: CSSearchableIndexDescription) async throws {
    try await SystemDiscovery.shared.reindex()
  }
  func reindexAllEntities(indexDescription: CSSearchableIndexDescription) async throws {
    try await SystemDiscovery.shared.reindex()
  }
}

@available(iOS 27.0, *)
@AppEnum(schema: .messages.conversationAttribute)
enum TeamSiriConversationAttribute: String, AppEnum {
  case favorited
  static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [.favorited: "Favorited"]
}
@available(iOS 27.0, *)
@AppEnum(schema: .messages.messageType)
enum TeamSiriMessageType: String, AppEnum {
  case unspecified
  static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [.unspecified: "Message"]
}
@available(iOS 27.0, *)
@AppEnum(schema: .messages.messageAttribute)
enum TeamSiriMessageAttribute: String, AppEnum {
  case favorited
  static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [.favorited: "Favorited"]
}
@available(iOS 27.0, *)
@AppEnum(schema: .messages.messageEffect)
enum TeamSiriMessageEffect: String, AppEnum {
  case love
  static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [.love: "Love"]
}
@available(iOS 27.0, *)
@AppEnum(schema: .messages.customReaction)
enum TeamSiriCustomReaction: String, AppEnum {
  case sticker
  static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [.sticker: "Sticker"]
}
@available(iOS 27.0, *)
@UnionValue enum TeamSiriMessageReaction: Sendable { case customReaction(TeamSiriCustomReaction) }

@available(iOS 27.0, *)
@AppEntity(schema: .messages.customAttachment)
struct TeamSiriCustomAttachment: AppEntity {
  static let defaultQuery = Query()
  var id: String
  var sourceName: AttributedString?
  var description: AttributedString?
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "Attachment") }
  struct Query: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [TeamSiriCustomAttachment] { [] }
  }
}

@available(iOS 27.0, *)
typealias TeamSiriRecipients = [TeamSiriPerson]

@available(iOS 27.0, *)
@UnionValue enum TeamSiriDestination {
  case contact(TeamSiriPerson)
  case recipients(TeamSiriRecipients)

  @MainActor func resolve(_ client: SystemIntentClient) throws -> ShareDestination {
    switch self {
    case .contact(let person): return try client.destination(person.id, kind: .bot)
    case .recipients(let people):
      let targets = try people.map { try client.destination($0.id, kind: .bot) }
      if targets.count == 1, let target = targets.first { return target }
      let botIDs = Set(targets.compactMap { $0.bot?.id })
      let groups = client.destinations.filter {
        $0.channel.isGroup && Set($0.members.map(\.id)) == botIDs
      }
      guard !botIDs.isEmpty, groups.count == 1, let group = groups.first else {
        throw APIError("Choose one Bot, or open the group conversation in OpenTeam.")
      }
      return group
    }
  }
}

@available(iOS 27.0, *)
@AppIntent(schema: .messages.sendMessage)
struct SendTeamSiriMessage: AppIntent {
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  var destination: TeamSiriDestination
  var subject: AttributedString?
  var content: AttributedString?
  var attachments: [IntentFile]
  var audioMessage: IntentFile?
  var locations: [PlaceDescriptor]
  var links: [URL]
  var scheduledDate: Date?
  @MainActor func perform() async throws -> some ReturnsValue<[TeamSiriMessage]> & ProvidesDialog {
    // Never silently discard unsupported fields or send a scheduled message now.
    guard subject == nil, locations.isEmpty, scheduledDate == nil else {
      throw APIError("OpenTeam supports immediate messages with text, links and attachments.")
    }
    let client = try await SystemIntentClient.connect()
    let target = try destination.resolve(client)
    let text = ([content.map { String($0.characters) }] + links.map { Optional($0.absoluteString) })
      .compactMap { $0 }.joined(separator: "\n")
    let message = try await client.send(to: target, text: text,
      files: attachments + (audioMessage.map { [$0] } ?? []))
    return .result(value: [TeamSiriMessage(message, target: target, scope: client.scope,
      owner: client.session.displayName)], dialog: "Sent to \(target.name).")
  }
}

@available(iOS 27.0, *)
@AppIntent(schema: .messages.draftMessage)
struct DraftTeamSiriMessage: AppIntent {
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let openAppWhenRun = true
  var destination: TeamSiriDestination?
  var subject: AttributedString?
  var content: AttributedString?
  var attachments: [IntentFile]
  var audioMessage: IntentFile?
  var locations: [PlaceDescriptor]
  var links: [URL]
  var scheduledDate: Date?
  @Dependency var store: AppStore
  @MainActor func perform() async throws -> some IntentResult {
    guard subject == nil, locations.isEmpty, scheduledDate == nil else {
      throw APIError("OpenTeam supports immediate messages with text, links and attachments.")
    }
    let client = try await SystemIntentClient.connect()
    let text = ([content.map { String($0.characters) }] + links.map { Optional($0.absoluteString) })
      .compactMap { $0 }.joined(separator: "\n")
    let assets = try await client.upload(attachments + (audioMessage.map { [$0] } ?? []))
    if let destination {
      let target = try destination.resolve(client)
      try await store.openSystemItem(TeamConversationEntity(target, scope: client.scope).id,
        draft: text, attachments: assets)
    } else {
      store.systemDraft = SystemMessageDraft(scope: client.scope, text: text, attachments: assets)
    }
    return .result()
  }
}

@available(iOS 27.0, *)
struct OpenTeamSiriConversation: OpenIntent {
  static let title: LocalizedStringResource = "Open conversation"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let openAppWhenRun = true
  @Parameter(title: "Conversation") var target: TeamSiriConversation
  @Dependency var store: AppStore
  @MainActor func perform() async throws -> some IntentResult {
    try await store.openSystemItem(target.id)
    return .result()
  }
}

@available(iOS 27.0, *)
struct OpenTeamSiriMessage: OpenIntent {
  static let title: LocalizedStringResource = "Open message"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let openAppWhenRun = true
  @Parameter(title: "Message") var target: TeamSiriMessage
  @Dependency var store: AppStore
  @MainActor func perform() async throws -> some IntentResult {
    try await store.openSystemItem(target.id)
    return .result()
  }
}

@available(iOS 27.0, *)
struct OpenTeamSiriBot: OpenIntent {
  static let title: LocalizedStringResource = "Open Bot"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let openAppWhenRun = true
  @Parameter(title: "Bot") var target: TeamSiriPerson
  @Dependency var store: AppStore
  @MainActor func perform() async throws -> some IntentResult {
    try await store.openSystemItem(target.id)
    return .result()
  }
}
