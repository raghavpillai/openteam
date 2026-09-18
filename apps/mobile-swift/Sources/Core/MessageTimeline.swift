import Foundation

/// Derive display metadata once when history changes, never from an individual
/// row's layout. Dates and the filtered history used to be rebuilt per row.
public struct MessageTimeline: Sendable {
  public struct Entry: Identifiable, Sendable {
    public let message: Message
    public let timestamp: Date?
    public var id: String { message.id }
  }
  public let entries: [Entry]
  public let replyCounts: [String: Int]
  public init(_ messages: [Message]) {
    var previous: Date?
    var first = true
    let entries = messages.filter { !$0.metadata["branched"].bool }.map {
      message in
      let date = message.date
      let showsTimestamp =
        first
        || (date != nil && previous != nil
          && date!.timeIntervalSince(previous!) > 300)
      first = false
      previous = date
      return Entry(message: message, timestamp: showsTimestamp ? date : nil)
    }
    self.entries = entries
    replyCounts = ThreadProjection.replyCounts(in: messages)
  }
}
