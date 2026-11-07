import Foundation

/// Derive display metadata once when history changes, never from an individual
/// row's layout. Dates and the filtered history used to be rebuilt per row.
public struct MessageTimeline: Sendable {
  public struct Entry: Identifiable, Sendable {
    public let message: Message
    public let timestamp: Date?
    public let showsReplyContext: Bool
    /// Set on the first entry of a realtime voice run: every message of the run, which the
    /// chat shows as one collapsed card. Later messages of the run have no entry of their own.
    public var voiceRun: [Message] = []
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
    self.entries = Self.foldingVoiceRuns(entries)
    replyCounts = ThreadProjection.replyCounts(in: messages)
  }
  /// Consecutive messages of one voice session become a single entry that keeps the run.
  private static func foldingVoiceRuns(_ entries: [Entry]) -> [Entry] {
    var result: [Entry] = []
    var session: String?
    for entry in entries {
      guard let id = entry.message.voiceSessionID else {
        session = nil
        result.append(entry)
        continue
      }
      if session == id, !result.isEmpty {
        result[result.count - 1].voiceRun.append(entry.message)
      } else {
        session = id
        var first = entry
        first.voiceRun = [entry.message]
        result.append(first)
      }
    }
    return result
  }
}
