import Foundation

/// A small, committed-message projection for Siri conversation context. Never includes drafts/outbox.
enum SystemConversationProjection {
  static func latestMessage(in messages: [Message], channelID: String) -> Message? {
    messages.filter {
      $0.channelId == channelID && $0.metadata["event"] == .null
        && (!$0.displayContent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !$0.attachments.isEmpty)
    }.max { MessageMerge.less($0.sequence, $1.sequence) }
  }

  static func preview(_ message: Message?) -> String {
    guard let message else { return "" }
    let text = message.displayContent.trimmingCharacters(in: .whitespacesAndNewlines)
    return String((text.isEmpty ? message.attachments.map(\.fileName).joined(separator: ", ") : text).prefix(1_000))
  }

  static func isRead(_ message: Message, channel: Channel) -> Bool {
    guard message.channelId == channel.id else { return false }
    if let through = NotificationReads.sequence(channel.notificationState?["lastReadSequence"].string ?? ""),
      let sequence = NotificationReads.sequence(message.sequence) {
      return !MessageMerge.less(through, sequence)
    }
    return (channel.unreadCount ?? 0) == 0
  }
}
