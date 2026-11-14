import Foundation

/// What a running Bot is doing right now, from its newest live run item. The same rules as
/// the desktop's `botActivityKind`; keep the two tables in step.
public enum BotActivityKind: String, Sendable {
  case thinking, typing, searching, readingWeb, browsing, readingFile, runningCommands,
    waitingCommand, waitingYou, connecting, computer, messaging, delegating, generating,
    drafting, organizing, working

  private static let tools: [String: Self] = [
    "SendToUser": .typing,
    "read": .readingFile, "Read": .readingFile, "ReadFile": .readingFile, "BoxRead": .readingFile,
    "Skill": .readingFile,
    "WebSearch": .searching, "web_search": .searching, "PlacesSearch": .searching,
    "WeatherForecast": .searching,
    "WebFetch": .readingWeb, "web_fetch": .readingWeb,
    "RemapUserFormTargets": .browsing,
    "write": .drafting, "edit": .drafting, "Write": .drafting, "Edit": .drafting,
    "Shell": .runningCommands, "ExternalShell": .runningCommands, "bash": .runningCommands,
    "BoxShell": .runningCommands,
    "Await": .waitingCommand, "AwaitProcess": .waitingCommand, "AwaitShell": .waitingCommand,
    "RequestUserForm": .waitingYou,
    "Computer": .computer, "Screenshot": .computer, "request_box_help": .computer,
    "SendToAgent": .messaging, "UpdateAgent": .messaging, "CreateAgent": .messaging,
    "ReactToMessage": .messaging, "SendIMessage": .messaging,
    "CallDynamicTool": .connecting, "GetDynamicTools": .connecting, "SearchPlugins": .connecting,
    "GetPlugin": .connecting, "InstallPlugin": .connecting, "UninstallPlugin": .connecting,
    "GetMcpServerStatus": .connecting, "AddMcpServer": .connecting,
    "UninstallMcpServer": .connecting, "AuthenticateMcpServer": .connecting,
    "RestartMcpServers": .connecting, "SetMcpInstructions": .connecting,
    "Task": .delegating, "CheckSubagent": .delegating,
    "GenerateImage": .generating,
  ]

  /// Project only active runtime items; never read tool arguments or reasoning text.
  public init(items: [RunItem]) {
    var latest: RunItem?
    for item in items where item.status == "running" || item.status == "pending" {
      if let current = latest {
        if item.createdAt > current.createdAt
          || (item.createdAt == current.createdAt && item.updatedAt >= current.updatedAt)
        {
          latest = item
        }
      } else {
        latest = item
      }
    }
    // Clients never receive reasoning steps, so a running Bot with no live step is thinking.
    guard let latest else {
      self = .thinking
      return
    }
    switch latest.kind {
    case "reasoning": self = .thinking
    case "command": self = .runningCommands
    case "file_change": self = .drafting
    case "compaction": self = .organizing
    default:
      let named = latest.content["tool"].string
      let tool = named.isEmpty ? (latest.title ?? "") : named
      self =
        Self.tools[tool]
        ?? (tool.hasPrefix("browser_")
          ? .browsing : latest.kind == "agent_message" ? .thinking : .working)
    }
  }

  /// Reasoning, searching, generating, apps and waits, writing a file and messaging get a
  /// glyph; hands-on work keeps the robot working.
  public var avatarMode: RobotAvatarMode {
    switch self {
    case .thinking: .thinking
    case .typing: .typing
    case .searching: .searching
    case .generating: .generating
    case .connecting, .waitingCommand, .waitingYou: .connecting
    case .drafting: .writing
    case .messaging: .sending
    default: .working
    }
  }
}

/// A run that settled while this client watched it.
public struct SettledBotRun: Sendable, Equatable {
  public var completed: Bool
  public var at: Double
  public init(completed: Bool, at: Double) {
    self.completed = completed
    self.at = at
  }
}

/// Remembers runs this client saw finish, so an avatar can react to the finish once.
public struct WatchedBotRuns: Sendable {
  /// A settled run shows its outcome this long; the avatar plays its reaction, then rests.
  public static let outcomeSeconds = 8.0
  private struct Watched: Sendable { var status: String, channelId: String, botId: String }
  private var runs: [String: Watched] = [:]
  public private(set) var settled: [String: SettledBotRun] = [:]
  public init() {}
  public static func key(_ channelId: String, _ botId: String) -> String { channelId + "\u{0}" + botId }

  /// Fold a new snapshot of runs into what has been watched. A run that goes from queued or
  /// running to completed or failed records a reaction; one first seen already settled never
  /// does. Background conversations only list active runs, so a run that disappears there
  /// counts as completed when its Bot wrote the conversation's newest message.
  public mutating func observe(runs snapshot: [Run], at: Double, latest: (String) -> Message?) {
    var seen = Set<String>()
    for run in snapshot {
      guard let channelId = run.channelId else { continue }
      seen.insert(run.id)
      let previous = runs[run.id]?.status
      runs[run.id] = .init(status: run.status, channelId: channelId, botId: run.botId)
      let key = Self.key(channelId, run.botId)
      if run.isActive {
        settled[key] = nil
        continue
      }
      guard let previous, ["queued", "running"].contains(previous) else { continue }
      if run.status == "completed" || run.status == "failed" {
        settled[key] = .init(completed: run.status == "completed", at: at)
      } else {
        settled[key] = nil
      }
    }
    for (id, run) in runs where !seen.contains(id) {
      runs[id] = nil
      guard ["queued", "running"].contains(run.status) else { continue }
      let message = latest(run.channelId)
      guard message?.sender == "agent", message?.senderBotId == run.botId else { continue }
      settled[Self.key(run.channelId, run.botId)] = .init(completed: true, at: at)
    }
    settled = settled.filter { at - $0.value.at < Self.outcomeSeconds }
  }
}

public enum BotAvatarActivity {
  private static let waitingCards: Set<String> = [
    "external-draft", "imessage-send", "user-form", "secret-request",
  ]
  /// A card the Bot left for the person, still waiting for their answer.
  public static func isWaitingOnUser(_ message: Message?, botId: String) -> Bool {
    guard let message, message.sender == "agent", message.senderBotId == botId else { return false }
    let type = message.metadata["type"].string
    guard waitingCards.contains(type) else { return false }
    if type == "secret-request" { return !message.metadata["secretProvided"].bool }
    let state = message.metadata["cardState"]
    return state == .null || state.string == "pending"
  }

  /// Running beats waiting on the person, which beats the outcome of a settled run.
  /// - Parameter items: the active run's items, known only for the open conversation.
  public static func mode(
    botId: String, activeRun: Run?, items: [RunItem]?, latest: Message?, settled: SettledBotRun?,
    now: Double
  ) -> RobotAvatarMode {
    if activeRun != nil {
      // Elsewhere the Bot is busy at something unknown, which the working robot shows best.
      guard let items else { return .working }
      return BotActivityKind(items: items).avatarMode
    }
    if isWaitingOnUser(latest, botId: botId) { return .waiting }
    if let settled, now >= settled.at, now - settled.at < WatchedBotRuns.outcomeSeconds {
      return settled.completed ? .done : .failed
    }
    return .idle
  }
}

/// Paces what an avatar shows. Busy modes flip often while a run moves between tools, so each
/// holds long enough to read; and some states play out and hand over on their own.
public struct RobotModePacer: Sendable {
  public static let busyDwell = 0.9
  private static let handOffs: [RobotAvatarMode: (after: Double, next: RobotAvatarMode)] = [
    .done: (5.5, .idle), .failed: (3, .idle), .waking: (1.6, .idle), .waiting: (120, .drowsy),
  ]
  public private(set) var requested: RobotAvatarMode
  private var held: RobotAvatarMode
  private var since: Double
  public init(_ mode: RobotAvatarMode = .still, at now: Double = 0) {
    requested = mode
    held = mode
    since = now
  }
  public mutating func request(_ mode: RobotAvatarMode) { requested = mode }
  /// The mode to show at `now`.
  public mutating func shown(at now: Double) -> RobotAvatarMode {
    if requested != held,
      // An arrival never waits its turn: it is the first thing a row shows.
      !(requested.isBusy && held.isBusy && requested != .spawning && now - since < Self.busyDwell)
    {
      held = requested
      since = now
    }
    if let handOff = Self.handOffs[held], now - since >= handOff.after { return handOff.next }
    return held
  }
  /// Whether the shown mode will change by itself, so the owner should keep its clock running.
  public var isPending: Bool { requested != held || Self.handOffs[held] != nil }
}
