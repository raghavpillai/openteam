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
    var counts: [String: Int] = [:]
    for message in byID.values where message.metadata["branched"].bool {
      var current = message
      var visited: Set<String> = [message.id]
      var ancestors: [String] = []
      while current.metadata["branched"].bool {
        guard let id = current.replyTo, visited.insert(id).inserted, let parent = byID[id] else {
          ancestors = []
          break
        }
        ancestors.append(id)
        current = parent
      }
      for id in ancestors { counts[id, default: 0] += 1 }
    }
    return counts
  }
  public static func messages(root: Message, in messages: [Message]) -> [Message] {
    var byID = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
    byID[root.id] = byID[root.id] ?? root
    guard Self.root(for: root, in: Array(byID.values)) != nil else { return [root] }
    let replies = byID.values.filter { message in
      guard message.id != root.id, message.metadata["branched"].bool else { return false }
      var current = message
      var visited: Set<String> = []
      while current.metadata["branched"].bool {
        guard visited.insert(current.id).inserted, let id = current.replyTo,
          let parent = byID[id]
        else { return false }
        if parent.id == root.id { return true }
        if !parent.metadata["branched"].bool { return false }
        current = parent
      }
      return false
    }.sorted {
      if $0.createdAt == $1.createdAt { return $0.id < $1.id }
      return ($0.date ?? .distantPast) < ($1.date ?? .distantPast)
    }
    return [byID[root.id] ?? root] + replies
  }
}
