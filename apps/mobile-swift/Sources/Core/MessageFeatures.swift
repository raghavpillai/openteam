import Foundation

public struct MessageReaction: Identifiable, Equatable, Sendable {
  public var id: String { emoji }
  public let emoji: String
  public let count: Int
  public let isOwn: Bool
  public static func project(_ metadata: JSON) -> [Self] {
    var order: [String] = []
    var counts: [String: Int] = [:]
    var own: Set<String> = []
    for reaction in metadata["reactions"].array {
      let emoji = reaction["emoji"].string
      guard !emoji.isEmpty else { continue }
      if counts[emoji] == nil { order.append(emoji) }
      counts[emoji, default: 0] += 1
      if reaction["by"].string == "me" { own.insert(emoji) }
    }
    return order.map { Self(emoji: $0, count: counts[$0]!, isOwn: own.contains($0)) }
  }
}

public struct BotExchangePeer: Identifiable, Hashable, Sendable {
  public let id: String
  public let name: String
  public let incoming: Bool
  public var focusedMessageID: String? = nil
  public init?(_ metadata: JSON) {
    let from = metadata["fromAgent"]
    let peer = from != .null ? from : metadata["toAgent"]
    guard !peer["id"].string.isEmpty else { return nil }
    id = peer["id"].string
    name = peer["name"].string.isEmpty ? "Bot" : peer["name"].string
    incoming = from != .null
  }
}

public struct RoutineMessageEvent: Sendable {
  public let id: String
  public let name: String
  public let action: String
  public var canOpen: Bool { action != "deleted" }
  public var label: String {
    let verb = action == "created" ? "New" : action.capitalized
    return "\(verb) routine “\(name)”"
  }
  public init?(_ metadata: JSON) {
    let event = metadata["event"]
    guard metadata["type"].string == "event", event["type"].string == "automation-changed",
      ["created", "updated", "enabled", "disabled", "deleted"].contains(event["action"].string),
      !event["automationId"].string.isEmpty, !event["automationName"].string.isEmpty
    else { return nil }
    id = event["automationId"].string
    name = event["automationName"].string
    action = event["action"].string
  }
}

/// Labels and statuses only. Never project entered values, screenshots or secrets.
public struct UserFormOutcome: Sendable {
  public struct Field: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let status: String
  }
  public let summary: String
  public let fields: [Field]
  public let needsRecovery: Bool
  public init(_ metadata: JSON) {
    let state = metadata["cardState"].string
    let receipt = metadata["formReceipt"]
    let definitions = metadata["form"]["fields"].array
    let labels = ["filled": "Filled", "held": "Held for recovery", "unfilled": "Not filled",
                  "dropped": "Discarded", "unknown": "Check the page"]
    fields = receipt["fields"].array.compactMap { field in
      guard let definition = definitions.first(where: { $0["id"] == field["id"] }),
        let status = labels[field["status"].string] else { return nil }
      return Field(id: field["id"].string, label: definition["label"].string, status: status)
    }
    let partial = fields.contains { ["Held for recovery", "Discarded", "Check the page"].contains($0.status) }
    let submissionFailed = receipt["submitAttempted"].bool && !receipt["submitSucceeded"].bool
    func flagged(_ value: JSON) -> Bool { value != .null && value != .bool(false) && value != .string("") }
    needsRecovery = state == "fill_failed" || receipt["interrupted"].bool
      || flagged(receipt["domainMismatch"]) || flagged(receipt["pageMoved"]) || partial || submissionFailed
    switch state {
    case "dismissed": summary = "Form dismissed."
    case "expired": summary = "This form expired. Request a new form to continue."
    case "escalated": summary = "You chose to do this step on the screen instead."
    default:
      if receipt["interrupted"].bool {
        summary = "The fill was interrupted. Check the page before trying again."
      } else if flagged(receipt["domainMismatch"]) {
        summary = "The destination changed. No further fields were filled. Check the page before continuing."
      } else if flagged(receipt["pageMoved"]) {
        summary = "The page moved or changed. Check the page before continuing."
      } else if state == "fill_failed" || partial {
        summary = "Some fields could not be filled. Your bot can check the destination and recover held fields."
      } else if submissionFailed {
        summary = "The form was received, but pressing Enter failed. Check the page before continuing."
      } else {
        summary = metadata["form"]["domain"].string.isEmpty
          ? "Form submitted. Secret values were never shown to your Bot."
          : "Filled into the page. Secret values were never shown to your Bot."
      }
    }
  }
}
