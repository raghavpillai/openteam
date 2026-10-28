import CryptoKit
import Foundation

/// System identifiers are scoped to a server AND account. A saved shortcut must
/// never resolve an old account's identifier against the newly connected server.
struct SystemEntityID: Equatable, Sendable {
  enum Kind: String, Sendable { case bot, conversation, message, routine, attachment }
  let scope: String
  let kind: Kind
  let channelID: String
  let localID: String

  static func scope(server: String, userID: String) -> String {
    SHA256.hash(data: Data((server + "\n" + userID).utf8))
      .map { String(format: "%02x", $0) }.joined()
  }

  init(scope: String, kind: Kind, channelID: String, localID: String) {
    self.scope = scope
    self.kind = kind
    self.channelID = channelID
    self.localID = localID
  }

  init?(_ value: String) {
    guard value.utf8.count < 8_192,
      let data = Data(base64Encoded: value),
      let parts = try? JSONDecoder().decode([String].self, from: data), parts.count == 4,
      !parts[0].isEmpty, let kind = Kind(rawValue: parts[1]),
      !parts[2].isEmpty, !parts[3].isEmpty
    else { return nil }
    self.init(scope: parts[0], kind: kind, channelID: parts[2], localID: parts[3])
  }

  var value: String {
    // Encoding an array of strings cannot fail.
    (try! JSONEncoder().encode([scope, kind.rawValue, channelID, localID])).base64EncodedString()
  }

  func matches(scope: String, kind: Kind) -> Bool { self.scope == scope && self.kind == kind }
}

/// Only a small, recent projection is donated. Drafts, pending sends, Bot
/// instructions, hidden conversations and message metadata never enter the index.
struct SystemDiscoverySnapshot: Sendable {
  static let conversationLimit = 30
  static let messagesPerConversation = 20
  static let messageLimit = 200
  let destinations: [ShareDestination]
  let messages: [Message]

  init(bootstrap: Bootstrap, messages cached: [String: [Message]]) {
    let activeBots = Set(bootstrap.bots.filter { $0.status != "archived" }.map(\.id))
    destinations = Array(ShareDirectory.destinations(bootstrap).filter {
      !$0.hidden && $0.members.contains { activeBots.contains($0.id) }
    }.prefix(Self.conversationLimit))
    let channels = Set(destinations.map(\.id))
    var byID: [String: Message] = [:]
    for message in cached.values.flatMap({ $0 }) where channels.contains(message.channelId) {
      byID[message.id] = message
    }
    // The server bootstrap wins over any older cached copy of the same message.
    for message in bootstrap.latestMessages where channels.contains(message.channelId) {
      byID[message.id] = message
    }
    var counts: [String: Int] = [:]
    messages = Array(byID.values.sorted {
      if $0.date != $1.date { return ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
      return $0.id < $1.id
    }.filter {
      guard !$0.content.isEmpty || !$0.attachments.isEmpty,
        $0.metadata["event"] == .null,
        counts[$0.channelId, default: 0] < Self.messagesPerConversation else { return false }
      counts[$0.channelId, default: 0] += 1
      return true
    }.prefix(Self.messageLimit))
  }
}
