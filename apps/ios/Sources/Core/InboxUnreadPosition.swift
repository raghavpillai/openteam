import Foundation

/// Uses rendered order rather than lazy row geometry, which is unavailable offscreen.
public struct InboxUnreadPosition: Equatable, Sendable {
  public let above: [String]
  public let below: [String]
  public var nearestAbove: String? { above.last }
  public var nearestBelow: String? { below.first }

  public init(orderedIDs: [String], visibleIDs: Set<String>, unreadIDs: Set<String>) {
    let visibleIndices = orderedIDs.indices.filter { visibleIDs.contains(orderedIDs[$0]) }
    guard let first = visibleIndices.first, let last = visibleIndices.last else {
      // Wait for the native viewport report instead of guessing during initial layout.
      above = []
      below = []
      return
    }
    above = orderedIDs[..<first].filter { unreadIDs.contains($0) && !visibleIDs.contains($0) }
    below = orderedIDs.dropFirst(last + 1).filter {
      unreadIDs.contains($0) && !visibleIDs.contains($0)
    }
  }
}
