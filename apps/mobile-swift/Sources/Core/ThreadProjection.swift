import Foundation

/// Matches product-core/messages.ts: only branched replies belong to a thread.
/// Resolve ancestry independently of input order; broken chains and cycles stay out.
public enum ThreadProjection {
  public static func messages(root: Message, in messages: [Message]) -> [Message] {
    var byID = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
    byID[root.id] = byID[root.id] ?? root
    let replies = byID.values.filter { message in
      guard message.id != root.id, message.metadata["branched"].bool else { return false }
      var current = message
      var visited: Set<String> = []
      while current.metadata["branched"].bool {
        guard visited.insert(current.id).inserted, let id = current.replyTo,
          let parent = byID[id]
        else { return false }
        if !parent.metadata["branched"].bool { return parent.id == root.id }
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
