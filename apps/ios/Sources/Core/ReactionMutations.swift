import Foundation
import Observation

/// The reaction endpoint toggles an emoji, so overlapping requests cannot safely
/// be replayed. Keep one request per message and coalesce taps to the latest choice.
@MainActor @Observable
public final class ReactionMutations {
  private struct Intent {
    var confirmed: String?
    var desired: String?
  }
  private var intents: [String: Intent] = [:]
  public private(set) var uncertain: Set<String> = []
  private var revision: UInt64 = 0
  @ObservationIgnored private var tasks: [String: (id: UUID, task: Task<Void, Never>)] = [:]
  public var pendingCount: Int { tasks.count }
  public init() {}

  /// Reads begun before a tap/acknowledgement must not restore an older emoji.
  /// Retry a GET once; continuous edits leave the cached transcript for polling.
  public func read<Value: Sendable>(
    _ fetch: @MainActor () async throws -> Value
  ) async throws -> Value {
    for _ in 0..<2 {
      let started = revision
      let value = try await fetch()
      try Task.checkCancellation()
      if started == revision { return value }
    }
    throw CancellationError()
  }

  nonisolated public static func ownEmoji(_ metadata: JSON) -> String? {
    metadata["reactions"].array.first { $0["by"].string == "me" }?["emoji"].string
  }

  nonisolated public static func replacingOwn(_ metadata: JSON, with emoji: String?) -> JSON {
    var result = metadata
    var reactions = metadata["reactions"].array.filter { $0["by"].string != "me" }
    if let emoji { reactions.append(.object(["emoji": .string(emoji), "by": .string("me")])) }
    result["reactions"] = .array(reactions)
    return result
  }

  /// Overlay only this actor; polling may still update everyone else's reactions.
  public func project(_ metadata: JSON, messageID: String) -> JSON {
    guard let intent = intents[messageID], !uncertain.contains(messageID) else { return metadata }
    return Self.replacingOwn(metadata, with: intent.desired)
  }

  /// Failure recovery must be a read, never another toggle. Return true only
  /// after an authoritative read succeeded; an unknown result blocks mutations.
  @discardableResult
  public func toggle(
    messageID: String, metadata: JSON, emoji: String,
    send: @escaping @MainActor (String) async throws -> Message,
    confirmed: @escaping @MainActor (Message) -> Void,
    recover: @escaping @MainActor (Error) async -> Bool
  ) -> Bool {
    guard !emoji.isEmpty else { return false }
    if uncertain.contains(messageID) {
      if tasks[messageID] == nil {
        let id = UUID()
        let task = Task { [weak self] in
          guard !Task.isCancelled else { return }
          let recovered = await recover(APIError("Couldn't confirm this reaction. Refreshing it; tap again after it loads."))
          guard let self, self.tasks[messageID]?.id == id else { return }
          if recovered {
            self.uncertain.remove(messageID)
            self.revision &+= 1
          }
          self.tasks.removeValue(forKey: messageID)
        }
        tasks[messageID] = (id, task)
      }
      return false
    }
    let own = Self.ownEmoji(metadata)
    var intent = intents[messageID] ?? Intent(confirmed: own, desired: own)
    intent.desired = intent.desired == emoji ? nil : emoji
    intents[messageID] = intent
    revision &+= 1
    guard tasks[messageID] == nil else { return true }
    let id = UUID()
    let task = Task { [weak self] in
      guard let self else { return }
      await self.drain(messageID, id: id, send: send, confirmed: confirmed, recover: recover)
    }
    tasks[messageID] = (id, task)
    return true
  }

  private func drain(
    _ messageID: String, id: UUID,
    send: @MainActor (String) async throws -> Message,
    confirmed: @MainActor (Message) -> Void,
    recover: @MainActor (Error) async -> Bool
  ) async {
    defer {
      if tasks[messageID]?.id == id {
        tasks.removeValue(forKey: messageID)
        intents.removeValue(forKey: messageID)
      }
    }
    while !Task.isCancelled, tasks[messageID]?.id == id,
      let intent = intents[messageID], intent.desired != intent.confirmed,
      let emoji = intent.desired ?? intent.confirmed
    {
      do {
        let message = try await send(emoji)
        guard !Task.isCancelled, tasks[messageID]?.id == id else { return }
        guard message.id == messageID else { throw APIError("The server returned a different message.") }
        guard Self.ownEmoji(message.metadata) == intent.desired else {
          throw APIError("The server didn't confirm the selected reaction.")
        }
        revision &+= 1
        confirmed(message)
        // Taps received during the await own `desired`; do not overwrite it.
        intents[messageID]?.confirmed = Self.ownEmoji(message.metadata)
      } catch {
        guard !Task.isCancelled, tasks[messageID]?.id == id else { return }
        uncertain.insert(messageID)
        revision &+= 1
        let recovered = await recover(error)
        guard !Task.isCancelled, tasks[messageID]?.id == id else { return }
        if recovered {
          uncertain.remove(messageID)
          revision &+= 1
        }
        return
      }
    }
  }

  /// Account/session replacement owns cancellation; leaving a chat does not
  /// discard an already submitted action or retain the dismissed view.
  public func cancelAll() {
    revision &+= 1
    for pending in tasks.values { pending.task.cancel() }
    tasks.removeAll()
    intents.removeAll()
    uncertain.removeAll()
  }
}
