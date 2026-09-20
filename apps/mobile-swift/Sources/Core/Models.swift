import Foundation

/// Only open-ended metadata uses JSON. Stable transport fields remain typed and validated.
public enum JSON: Codable, Sendable, Equatable, Hashable {
  case object([String: JSON])
  case array([JSON])
  case string(String)
  case number(Double)
  case bool(Bool)
  case null
  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let v = try? c.decode(Bool.self) {
      self = .bool(v)
    } else if let v = try? c.decode(String.self) {
      self = .string(v)
    } else if let v = try? c.decode(Double.self) {
      self = .number(v)
    } else if let v = try? c.decode([JSON].self) {
      self = .array(v)
    } else {
      self = .object(try c.decode([String: JSON].self))
    }
  }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .object(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .string(let v): try c.encode(v)
    case .number(let v): try c.encode(v)
    case .bool(let v): try c.encode(v)
    case .null: try c.encodeNil()
    }
  }
  public subscript(_ key: String) -> JSON {
    get {
      if case .object(let o) = self { return o[key] ?? .null }
      return .null
    }
    set {
      var o = object
      o[key] = newValue
      self = .object(o)
    }
  }
  public var object: [String: JSON] {
    if case .object(let v) = self { return v }
    return [:]
  }
  public var array: [JSON] {
    if case .array(let v) = self { return v }
    return []
  }
  public var string: String {
    if case .string(let v) = self { return v }
    return ""
  }
  public var bool: Bool {
    if case .bool(let v) = self { return v }
    return false
  }
  public var int: Int {
    if case .number(let v) = self { return Int(v) }
    return 0
  }
  public func decode<T: Decodable>(_ type: T.Type) throws -> T {
    try JSONDecoder().decode(type, from: JSONEncoder().encode(self))
  }
  public static func encode<T: Encodable>(_ value: T) throws -> JSON {
    try JSONDecoder().decode(JSON.self, from: JSONEncoder().encode(value))
  }
}

public struct Bot: Codable, Identifiable, Sendable, Hashable {
  public var id: String
  public var name: String
  public var title: String
  public var description: String
  public var instructions: String
  public var icon: String
  public var color: String
  public var hasAvatar: Bool
  public var notificationsEnabled: Bool
  public var hiddenFromSidebar: Bool
  public var status: String
  public var conversationId: String
  public var dmChannelId: String
  public var updatedAt: String?
}
public struct Channel: Codable, Identifiable, Sendable, Hashable {
  public struct Member: Codable, Sendable, Hashable {
    public var botId: String
    public var ordinal: Int
  }
  public var id: String
  public var kind: String
  public var name: String
  public var description: String
  public var hasAvatar: Bool
  public var directKey: String?
  public var hiddenFromSidebar: Bool?
  public var members: [Member]
  public var unreadCount: Int?
  public var notificationState: JSON?
  public var updatedAt: String
  public var isGroup: Bool { kind == "group" }
}
public struct Asset: Codable, Sendable, Hashable, Identifiable {
  public var assetId: String
  public var fileName: String
  public var mimeType: String
  public var byteSize: Int
  public var kind: String
  public var width: Int?
  public var height: Int?
  public var alt: String?
  public var id: String { assetId }
}
public struct Message: Codable, Identifiable, Sendable, Hashable {
  public var id: String
  public var clientId: String?
  public var sequence: String
  public var channelId: String
  public var sender: String
  public var senderBotId: String?
  public var sourceRunId: String?
  public var content: String
  public var metadata: JSON
  public var createdAt: String
  public var isUser: Bool { sender == "user" && senderBotId == nil }
  public var replyTo: String? {
    let s = metadata["replyTo"].string
    return s.isEmpty ? nil : s
  }
  public var attachments: [Asset] {
    var seen = Set<String>()
    return (metadata["attachments"].array + [metadata["attachment"]]).compactMap { value in
      guard let asset = try? value.decode(Asset.self),
        seen.insert(asset.assetId + ":" + asset.fileName).inserted else { return nil }
      return asset
    }
  }
  public var displayContent: String {
    let assets = attachments
    if assets.count == 1, content == assets[0].fileName,
      metadata["type"].string == "attachment" || metadata["attachment"] != .null
    { return "" }
    return content
  }
  public var date: Date? {
    ISO8601DateFormatter().date(from: createdAt)
      ?? ISO8601DateFormatter.fractional.date(from: createdAt)
  }
}
extension ISO8601DateFormatter {
  static var fractional: ISO8601DateFormatter {
    let f = ISO8601DateFormatter()
    f.formatOptions.insert(.withFractionalSeconds)
    return f
  }
}
public struct Run: Codable, Identifiable, Sendable {
  public var id: String
  public var botId: String
  public var channelId: String?
  public var status: String
  public var isActive: Bool { ["queued", "running", "waiting_approval"].contains(status) }
}
public struct Approval: Codable, Identifiable, Sendable {
  public var id: String
  public var runId: String
  public var kind: String
  public var status: String
  public var details: JSON
  public var ownerConversationId: String
}
public struct Bootstrap: Codable, Sendable {
  public var cursor: String
  public var bots: [Bot]
  public var channels: [Channel]
  public var latestMessages: [Message]
  public var activeRuns: [Run]
  public var pendingApprovals: [Approval]
  public var runtime: JSON
}
public struct History: Codable, Sendable {
  public var channelId: String
  public var messages: [Message]
  public var threadContext: [Message]
  public var threadContextTruncated: Bool?
  public var beforeSequence: String?
  public var hasMore: Bool
  public var revision: String
}
public struct MessageContext: Decodable, Sendable {
  public var channelId: String
  public var targetMessageId: String
  public var messages: [Message]
  public var threadContext: [Message]
  public var threadContextTruncated: Bool?
  public var beforeSequence: String?
  public var afterSequence: String?
  public var hasMoreBefore: Bool
  public var hasMoreAfter: Bool
  public var revision: String
}
public struct ChannelState: Decodable, Sendable {
  public var channelId: String
  public var revision: String
  public var runs: [Run]
  public var approvals: [Approval]
}
public struct ProductEvent: Decodable, Sendable {
  public var sequence: String
  public var topic: String
  public var entityId: String?
  public var payload: JSON
}
public struct EventBatch: Decodable, Sendable { public var events: [ProductEvent] }
public struct SearchResult: Decodable, Identifiable, Sendable {
  public var id: String
  public var kind: String
  public var title: String
  public var subtitle: String
  public var channelId: String?
  public var messageId: String?
  public var botId: String?
  public var url: String?
}
public struct SearchResponse: Decodable, Sendable { public var results: [SearchResult] }
public struct Routine: Codable, Identifiable, Sendable {
  public var id: String
  public var name: String
  public var prompt: String
  public var schedule: String
  public var scheduleKind: String
  public var timezone: String
  public var enabled: Bool
  public var revision: Int
  public var nextRunAt: String?
  public var latestExecution: JSON?
  public var schedules: [String]?
  public var trigger: JSON?
  public var triggerPresentation: JSON?
  public var scheduleIsEditable: Bool {
    scheduleKind != "event" && (schedules?.count ?? 0) <= 1 && trigger?["type"].string != "group"
  }
}
public struct SendInput: Codable, Sendable, Equatable {
  public var content: String
  public var clientId: String
  public var attachments: [Asset]
  public var replyToMessageId: String?
  public var isFork: Bool?
  public var timeZone: String
  public init(
    content: String, clientId: String = UUID().uuidString, attachments: [Asset] = [],
    replyToMessageId: String? = nil, isFork: Bool? = nil
  ) {
    self.content = content
    self.clientId = clientId
    self.attachments = attachments
    self.replyToMessageId = replyToMessageId
    self.isFork = isFork
    self.timeZone = TimeZone.current.identifier
  }
}
public struct DeliveryStatus: Decodable, Sendable {
  public var status: String
  public var message: Message?
  public var messageText: String?
}
public struct MessageResponse: Decodable, Sendable { public var message: Message }

public enum MessageMerge {
  /// Server sequences are decimal strings, potentially larger than a machine integer.
  public static func less(_ lhs: String, _ rhs: String) -> Bool {
    let l = String(lhs.drop(while: { $0 == "0" }))
    let r = String(rhs.drop(while: { $0 == "0" }))
    return l.count == r.count ? l < r : l.count < r.count
  }
  public static func merge(_ existing: [Message], _ incoming: [Message]) -> [Message] {
    var byID = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
    for message in incoming {
      if let nonce = message.clientId {
        byID = byID.filter { $0.value.clientId != nonce || $0.key == message.id }
      }
      byID[message.id] = message
    }
    return byID.values.sorted {
      $0.sequence == $1.sequence ? $0.id < $1.id : less($0.sequence, $1.sequence)
    }
  }
}
