import Foundation

/// A send retains its display identity when the server replaces the queued copy.
/// Arrival tracking is independent of scroll/layout updates and older-page loads.
public struct MessagePresentation {
  public struct Row: Identifiable, Sendable {
    public enum Content: Sendable {
      case confirmed(MessageTimeline.Entry)
      case pending(PendingSend)
    }
    public let id: String
    public let content: Content
    public let timestamp: Date?
    public let animatesArrival: Bool
    public let groupsWithPrevious: Bool
    public var isUser: Bool {
      if case .confirmed(let entry) = content { return entry.message.isUser }
      return true
    }
    public var scrollID: String {
      switch content {
      case .confirmed(let entry): entry.message.id
      case .pending(let send): send.id
      }
    }
  }
  private var known: Set<String> = []
  private var arrivals: Set<String> = []
  private var latestSequence: String?
  public private(set) var arrivalRevision = 0
  public init() {}

  public mutating func project(
    _ timeline: MessageTimeline, pending: [PendingSend], animateNew: Bool
  ) -> [Row] {
    var result: [Row] = []
    let previousLatest = latestSequence
    var addedArrival = false
    var lastDate = timeline.entries.last?.message.date
    var previousSpeaker: String?
    for entry in timeline.entries {
      let message = entry.message
      let speaker = Self.groupingSpeaker(message)
      let id =
        message.clientId.map { "client:\(message.channelId):\($0)" }
        ?? "server:\(message.channelId):\(message.id)"
      if animateNew, !known.contains(id),
        previousLatest == nil || MessageMerge.less(previousLatest!, message.sequence)
      {
        arrivals.insert(id)
        addedArrival = true
      }
      known.insert(id)
      if latestSequence == nil || MessageMerge.less(latestSequence!, message.sequence) {
        latestSequence = message.sequence
      }
      result.append(
        Row(
          id: id, content: .confirmed(entry), timestamp: entry.timestamp,
          animatesArrival: arrivals.contains(id),
          groupsWithPrevious: entry.timestamp == nil && speaker != nil
            && speaker == previousSpeaker))
      previousSpeaker = speaker
    }
    let confirmed = Set(result.map(\.id))
    for send in pending {
      let id = "client:\(send.channelId):\(send.id)"
      guard !confirmed.contains(id) else { continue }
      if animateNew, !known.contains(id) {
        arrivals.insert(id)
        addedArrival = true
      }
      known.insert(id)
      let showsDate = lastDate == nil || send.createdAt.timeIntervalSince(lastDate!) > 300
      lastDate = send.createdAt
      result.append(
        Row(
          id: id, content: .pending(send),
          timestamp: showsDate ? send.createdAt : nil, animatesArrival: arrivals.contains(id),
          groupsWithPrevious: !showsDate && previousSpeaker == "user"))
      previousSpeaker = "user"
    }
    arrivals.formIntersection(result.map(\.id))
    if addedArrival { arrivalRevision += 1 }
    return result
  }

  private static func groupingSpeaker(_ message: Message) -> String? {
    // Events and agent-to-agent handoffs interrupt the visible speaker group.
    guard message.metadata["event"]["type"].string.isEmpty,
      message.metadata["fromAgent"] == .null, message.metadata["toAgent"] == .null
    else { return nil }
    if message.isUser { return "user" }
    return message.sender == "agent" ? "agent:" + (message.senderBotId ?? "") : nil
  }
}
