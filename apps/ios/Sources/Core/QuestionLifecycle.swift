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
