import Foundation

/// Matches product-core/messages.ts: only branched replies belong to a thread.
/// Resolve ancestry independently of input order; broken chains and cycles stay out.
public enum ThreadProjection {
  public static func root(for message: Message, in messages: [Message]) -> Message? {
    let byID = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
    var current = message
    var visited: Set<String> = []
    while current.metadata["branched"].bool {
      guard visited.insert(current.id).inserted, let id = current.replyTo, let parent = byID[id]
      else { return nil }
      current = parent
    }
    return current
  }
  public static func replyCounts(in messages: [Message]) -> [String: Int] {
    let byID = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
    var children: [String: [String]] = [:]
    var ordered: [String] = []
    for message in byID.values {
      if !message.metadata["branched"].bool { ordered.append(message.id) }
      else if let parent = message.replyTo, byID[parent] != nil {
        children[parent, default: []].append(message.id)
      }
    }
    // Only trees reachable from non-branched roots are valid. Cycles and
    // missing-parent chains are unreachable. Visit each edge once, then count
    // descendants from leaves upward instead of walking every ancestry again.
    var cursor = 0
    while cursor < ordered.count {
      ordered.append(contentsOf: children[ordered[cursor]] ?? [])
      cursor += 1
    }
    var counts: [String: Int] = [:]
    for id in ordered.reversed() {
      if let message = byID[id], message.metadata["branched"].bool, let parent = message.replyTo {
        counts[parent, default: 0] += 1 + (counts[id] ?? 0)
      }
    }
    return counts
  }
  public static func messages(root: Message, in messages: [Message], includeInlineReplies: Bool = false) -> [Message] {
    var byID = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
    byID[root.id] = byID[root.id] ?? root
    guard Self.root(for: root, in: Array(byID.values)) != nil else { return [root] }
    var children: [String: [Message]] = [:]
    for message in byID.values where includeInlineReplies || message.metadata["branched"].bool {
      if let parent = message.replyTo { children[parent, default: []].append(message) }
    }
    var visited: Set<String> = [root.id]
    var pending = children[root.id] ?? []
    var descendants: [Message] = []
    while let message = pending.popLast() {
      guard visited.insert(message.id).inserted else { continue }
      descendants.append(message)
      pending.append(contentsOf: children[message.id] ?? [])
    }
    let replies = descendants.map { (message: $0, date: $0.date ?? .distantPast) }.sorted {
      if $0.message.createdAt == $1.message.createdAt { return $0.message.id < $1.message.id }
      return $0.date < $1.date
    }.map(\.message)
    return [byID[root.id] ?? root] + replies
  }
}
