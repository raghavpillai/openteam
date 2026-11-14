import Foundation

/// A normal message moves past a question; it is not a structured card answer.
/// Project without modifying the cache so failed/removed sends can restore the card.
public enum QuestionLifecycle {
  private static func scope(_ message: Message) -> String {
    let meta = message.metadata
    let branch = meta["questionScopeId"].string
    return message.channelId + ":" + (meta["branched"].bool
      ? (branch.isEmpty ? (message.replyTo ?? message.id) : branch) : "main")
  }

  public static func project(_ messages: [Message], pending: [PendingSend] = []) -> [Message] {
    var boundaries: [String: String] = [:]
    var result = messages
    for index in result.indices.reversed() {
      let message = result[index]
      let key = scope(message)
      if message.isUser { boundaries[key] = "moved-on"; continue }
      guard message.sender == "agent", message.metadata["type"].string == "widget" else { continue }
      if message.metadata["respondedValue"] != .null || message.metadata["widgetDismissed"].bool {
        boundaries[key] = "superseded"
        continue
      }
      let movedOn = pending.contains { send in
        guard send.channelId == message.channelId,
          send.failure == nil || send.deliveryUnconfirmed == true,
          let date = message.date, send.createdAt >= date else { return false }
        if send.input.isFork != true { return !message.metadata["branched"].bool }
        guard message.metadata["branched"].bool, let replyID = send.input.replyToMessageId else { return false }
        let reply = messages.first { $0.id == replyID }
        let root = reply?.metadata["questionScopeId"].string ?? ""
        return message.metadata["questionScopeId"].string == (root.isEmpty ? replyID : root)
      }
      if boundaries[key] != nil || movedOn {
        result[index].metadata["widgetDismissed"] = .bool(true)
        result[index].metadata["widgetDismissalReason"] = .string(boundaries[key] ?? "moved-on")
      } else { boundaries[key] = "superseded" }
    }
    return result
  }

  public static func current(_ messages: [Message], pending: [PendingSend] = []) -> Message? {
    project(messages, pending: pending).last {
      $0.sender == "agent" && $0.metadata["type"].string == "widget"
        && !$0.metadata["branched"].bool && $0.metadata["respondedValue"] == .null
        && !$0.metadata["widgetDismissed"].bool
    }
  }
}

/// Session-local receipts outlive a visible history window, without retaining card bodies.
public struct QuestionReceiptCache: Sendable {
  private static let keys = ["respondedValue", "respondedLabel", "widgetDismissed",
    "widgetDismissalReason", "widgetDismissClientId", "widgetResponseClientId"]
  private var receipts: [String: [String: JSON]] = [:]
  private var sizes: [String: Int] = [:]
  private var order: [String] = []
  public private(set) var bytes = 0
  public var count: Int { receipts.count }
  private let limit: Int
  private let maxBytes: Int
  public init(limit: Int = 500, maxBytes: Int = 256 * 1024) {
    self.limit = max(0, limit); self.maxBytes = max(0, maxBytes)
  }
  public mutating func observe(_ messages: [Message]) {
    for message in messages {
      let key = message.channelId + ":" + message.id
      guard receipts[key] == nil, message.metadata["type"].string == "widget" else { continue }
      let metadata = message.metadata.object
      guard metadata["respondedValue"].map({ if case .string = $0 { return true }; return false }) == true
        || message.metadata["widgetDismissed"].bool else { continue }
      let receipt = metadata.filter { Self.keys.contains($0.key) }
      let size = 128 + key.utf16.count * 2 + ((try? JSONEncoder().encode(JSON.object(receipt)).count) ?? 0) * 2
      receipts[key] = receipt; sizes[key] = size; order.append(key); bytes += size
      while order.count > limit || bytes > maxBytes {
        let oldest = order.removeFirst()
        bytes -= sizes.removeValue(forKey: oldest) ?? 0
        receipts.removeValue(forKey: oldest)
      }
    }
  }
  public func restore(_ message: Message) -> Message {
    guard let receipt = receipts[message.channelId + ":" + message.id] else { return message }
    if Self.keys.allSatisfy({ message.metadata[$0] == (receipt[$0] ?? .null) }) { return message }
    var next = message, metadata = message.metadata.object
    for key in Self.keys { metadata.removeValue(forKey: key) }
    for (key, value) in receipt { metadata[key] = value }
    next.metadata = .object(metadata)
    return next
  }
  public mutating func merge(_ existing: [Message], _ incoming: [Message], remembering: [Message] = []) -> [Message] {
    observe(remembering + existing + incoming)
    return MessageMerge.merge(existing, incoming).map(restore)
  }
}
