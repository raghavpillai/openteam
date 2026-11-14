import Foundation

public enum InboxActivity: Equatable, Sendable {
  case idle
  case working
  case needsAnswer
}

public enum InboxPresentation {
  /// Runs and current history must already be scoped to the row's bot or channel,
  /// including background work. Latest supplies previews independently of pending cards
  /// in history and overrides a history copy of the same message.
  public static func activity(
    latest: Message?, runs: [Run], messages: [Message] = []
  ) -> InboxActivity {
    if let latest, needsAnswer(latest) { return .needsAnswer }
    if messages.contains(where: { $0.id != latest?.id && needsAnswer($0) }) {
      return .needsAnswer
    }
    return runs.contains(where: \.isActive) ? .working : .idle
  }

  public static func preview(_ message: Message) -> String {
    guard message.metadata["type"].string == "widget" else { return message.previewText }
    let widget = message.metadata["widget"]
    let help = widget["helpText"].string
    let detail = MessagePreview.trim(help).isEmpty
      ? widget["options"].array.map { $0["label"].string }.filter { !$0.isEmpty }.joined(separator: ", ")
      : help
    let parts = [widget["prompt"].string, detail]
      .map(MessagePreview.plainText).filter { !$0.isEmpty }
    return parts.isEmpty ? message.previewText : MessagePreview.truncate(parts.joined(separator: " — "))
  }

  public static func previewSymbol(_ message: Message) -> String? {
    if message.metadata["type"].string == "widget" { return "checklist" }
    return message.isAttachmentOnly ? "paperclip" : nil
  }

  public static func dateLabel(
    _ date: Date, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current
  ) -> String {
    let days = calendar.dateComponents(
      [.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)
    ).day ?? Int.max
    if days == 1 { return "Yesterday" }
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.calendar = calendar
    formatter.timeZone = calendar.timeZone
    switch days {
    case 0: formatter.dateFormat = "h:mm a"
    case 2..<7: formatter.dateFormat = "EEEE"
    default: formatter.dateFormat = "MMM d"
    }
    return formatter.string(from: date)
  }

  private static func needsAnswer(_ message: Message) -> Bool {
    guard message.sender == "agent", !message.metadata["branched"].bool else { return false }
    let metadata = message.metadata
    let state = metadata["cardState"].string
    guard state.isEmpty || state == "pending" else { return false }
    switch metadata["type"].string {
    case "widget":
      // Ordinary questions use their card, composer hint, and unread state.
      // Persistent attention badges belong to requests that still need an action.
      return false
    case "secret-request":
      return !metadata["secretProvided"].bool
    case "user-form", "external-draft", "imessage-send":
      return true
    case "computer-handoff":
      return ["", "requested", "active", "started"].contains(metadata["computerHandoffState"].string)
    default:
      return false
    }
  }
}
