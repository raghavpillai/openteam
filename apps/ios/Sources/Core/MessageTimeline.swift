import Foundation

/// Derive display metadata once when history changes, never from an individual
/// row's layout. Dates and the filtered history used to be rebuilt per row.
public struct MessageTimeline: Sendable {
  public struct Entry: Identifiable, Sendable {
    public let message: Message
    public let timestamp: Date?
    public let showsReplyContext: Bool
    public var id: String { message.id }
  }
  public let entries: [Entry]
  public let replyCounts: [String: Int]
  public init(_ messages: [Message], includeBranched: Bool = false) {
    var previous: Date?
    var first = true
    var previousMessage: Message?
    let entries = messages.filter { includeBranched || !$0.metadata["branched"].bool }.map {
      message in
      let date = message.date
      let showsTimestamp =
        first
        || (date != nil && previous != nil
          && date!.timeIntervalSince(previous!) > 300)
      first = false
      previous = date
      // Keep an explicit reply discoverable in the main transcript, without
      // repeating the same quote above every bot response in that exchange.
      // A forked delivery answers the triggering user message, while older
      // histories can attach every response directly to the original root.
      let continuesReply = message.replyTo == previousMessage?.replyTo
        || (message.replyTo == previousMessage?.id && previousMessage?.replyTo != nil)
      let showsReplyContext = message.replyTo != nil
        && (message.isUser || !continuesReply || showsTimestamp)
      previousMessage = message
      return Entry(message: message, timestamp: showsTimestamp ? date : nil,
        showsReplyContext: showsReplyContext)
    }
    self.entries = entries
    replyCounts = ThreadProjection.replyCounts(in: messages)
  }
}
