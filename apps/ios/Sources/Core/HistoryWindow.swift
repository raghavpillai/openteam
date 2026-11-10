import Foundation

/// A contiguous slice of a conversation. Context roots can live outside this
/// interval for thread navigation, without appearing as adjacent timeline rows.
public struct HistoryWindow: Sendable, Equatable {
  /// Page requests belong to this window across extensions, until it is replaced.
  public let id = UUID()
  public var firstSequence: String?
  public var lastSequence: String?
  public var hasEarlier: Bool
  public var hasLater: Bool
  public init(messages: [Message], hasEarlier: Bool, hasLater: Bool) {
    firstSequence = messages.first?.sequence
    lastSequence = messages.last?.sequence
    self.hasEarlier = hasEarlier
    self.hasLater = hasLater
  }
  public static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.firstSequence == rhs.firstSequence && lhs.lastSequence == rhs.lastSequence
      && lhs.hasEarlier == rhs.hasEarlier && lhs.hasLater == rhs.hasLater
  }
  public func contains(_ message: Message) -> Bool {
    if let firstSequence, MessageMerge.less(message.sequence, firstSequence) { return false }
    if hasLater, let lastSequence, MessageMerge.less(lastSequence, message.sequence) { return false }
    return true
  }
  public mutating func extend(_ messages: [Message], earlier: Bool, hasMore: Bool) {
    if earlier {
      firstSequence = messages.first?.sequence ?? firstSequence
      hasEarlier = hasMore
    } else {
      lastSequence = messages.last?.sequence ?? lastSequence
      hasLater = hasMore
    }
  }
}
