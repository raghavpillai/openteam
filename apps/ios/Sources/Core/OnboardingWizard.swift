import Foundation

/// The four stages the first-run wizard shows at the top, in order.
public enum WizardStage: Int, CaseIterable, Sendable, Comparable {
  case server, model, voice, bot
  public var title: String {
    switch self {
    case .server: return "Server"
    case .model: return "AI model"
    case .voice: return "Voice"
    case .bot: return "First bot"
    }
  }
  public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// The screens after sign-in (W3–W7). W0–W2 are the sign-in screens; W8 is the chat.
public enum WizardStep: String, Hashable, Sendable {
  /// `method`: ChatGPT or Claude, by plan (a sign-in) or by API key.
  case health, choose, method, signIn, apiKey, test, voice, bot
  public var stage: WizardStage {
    switch self {
    case .health: return .server
    case .choose, .method, .signIn, .apiKey, .test: return .model
    case .voice: return .voice
    case .bot: return .bot
    }
  }
  /// The step after a working model: voice notes, unless they're already set up.
  public static func afterModel(voiceConfigured: Bool) -> Self {
    voiceConfigured ? .bot : .voice
  }
}

/// ChatGPT and Claude are one card each on "Choose your bots' AI"; the next step
/// picks how to pay: the plan someone already has (a sign-in) or an API key.
public struct ProviderFamily: Sendable, Hashable, Identifiable {
  public struct Method: Sendable, Hashable, Identifiable {
    /// The server's provider, such as "openai-codex" (the plan) or "openai" (a key).
    public let providerId: String
    /// "oauth" or "api_key".
    public let authType: String
    public let title: String
    public let detail: String
    public var id: String { providerId }
  }
  public let id: String
  public let title: String
  public let detail: String
  public let methods: [Method]
}

public enum ProviderFamilies {
  public static let chatgpt = ProviderFamily(
    id: "chatgpt", title: "ChatGPT", detail: "Your plan or an OpenAI key",
    methods: [
      .init(
        providerId: "openai-codex", authType: "oauth", title: "Sign in with ChatGPT",
        detail: "Uses your ChatGPT Plus or Pro plan"),
      .init(
        providerId: "openai", authType: "api_key", title: "Use an OpenAI API key",
        detail: "Pay per use with a key from platform.openai.com"),
    ])
  public static let claude = ProviderFamily(
    id: "claude", title: "Claude", detail: "Your plan or an Anthropic key",
    methods: [
      .init(
        providerId: "claude-code", authType: "oauth", title: "Sign in with Claude",
        detail: "Uses your Claude Pro or Max plan"),
      .init(
        providerId: "anthropic", authType: "api_key", title: "Use an Anthropic API key",
        detail: "Pay per use with a key from console.anthropic.com"),
    ])
  public static let all = [chatgpt, claude]
  /// The card a provider sits under, so "More providers" never lists it again.
  public static func family(of providerId: String) -> ProviderFamily? {
    all.first { $0.methods.contains { $0.providerId == providerId } }
  }
}

/// Providers the API-key screen offers, guessed from the key's prefix.
public enum APIKeyProviders {
  public struct Option: Sendable, Hashable, Identifiable {
    public let id: String
    public let title: String
    /// Where to create a key.
    public let keyPage: URL
    /// What the key gets you, under the provider's name in the art.
    public let tagline: String
  }
  public static let options: [Option] = [
    .init(
      id: "openai", title: "OpenAI", keyPage: URL(string: "https://platform.openai.com/api-keys")!,
      tagline: "GPT models, billed per use"),
    .init(
      id: "anthropic", title: "Anthropic",
      keyPage: URL(string: "https://console.anthropic.com/settings/keys")!,
      tagline: "Claude models, billed per use"),
    .init(
      id: "openrouter", title: "OpenRouter", keyPage: URL(string: "https://openrouter.ai/keys")!,
      tagline: "Hundreds of models, one key"),
  ]
  public static func option(_ id: String) -> Option? { options.first { $0.id == id } }
  /// `sk-ant-` is Anthropic, `sk-or-` OpenRouter, any other `sk-` OpenAI.
  public static func guess(_ key: String) -> String? {
    let value = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if value.hasPrefix("sk-ant-") { return "anthropic" }
    if value.hasPrefix("sk-or-") { return "openrouter" }
    if value.hasPrefix("sk-") { return "openai" }
    return nil
  }
}

/// What the first bot is for. The description is sent with the bot and shapes its greeting.
public struct BotRole: Sendable, Hashable, Identifiable {
  public let id: String
  public let title: String
  public let description: String
  /// The same job in the bot's own words, for the wizard's preview.
  public let intro: String
}

/// Defaults and the request for the wizard's "Create your first bot" screen.
public enum FirstBot {
  public static let names = ["Atlas", "Nova", "Juniper", "Pixel", "Sage", "Orbit"]
  public static let roles: [BotRole] = [
    .init(
      id: "general", title: "General helper",
      description: "Helps with research, writing, and everyday tasks on the web.",
      intro: "I can help with research, writing, and everyday tasks on the web."),
    .init(
      id: "researcher", title: "Researcher",
      description: "Finds, compares, and summarizes information from the web, with sources.",
      intro: "I find, compare, and summarize information from the web, with sources."),
    .init(
      id: "inbox", title: "Inbox assistant",
      description: "Sorts email, drafts replies for your review, and tracks follow-ups.",
      intro: "I sort email, draft replies for your review, and track follow-ups."),
    .init(
      id: "writer", title: "Writer",
      description: "Drafts and edits documents, posts, and messages in your voice.",
      intro: "I draft and edit documents, posts, and messages in your voice."),
    .init(
      id: "operations", title: "Operations",
      description: "Handles recurring admin work like reports, spreadsheets, and checklists.",
      intro: "I handle recurring admin work like reports, spreadsheets, and checklists."),
  ]
  /// The preview's greeting. The real one comes from the bot once it's created.
  public static func greeting(name: String, role: BotRole) -> String {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    return (trimmed.isEmpty ? "Hi!" : "Hi, I'm \(trimmed)!") + " " + role.intro
      + " What should we start with?"
  }
  public struct Avatar: Sendable, Equatable {
    /// A `RobotShape` id, sent as the bot's icon.
    public var shape: String
    /// `#rrggbb`, sent as the bot's color.
    public var color: String
    public init(shape: String, color: String) {
      self.shape = shape
      self.color = color
    }
  }
  /// The app's robot colors, without the near-black and grey ones.
  public static var colors: [String] {
    RobotArtwork.shared.colors.filter { !["#242424", "#878787"].contains($0.lowercased()) }
  }
  /// A random robot, never the same shape and color as `previous`.
  public static func randomAvatar<G: RandomNumberGenerator>(
    excluding previous: Avatar? = nil, using generator: inout G
  ) -> Avatar {
    let shapes = RobotShape.allCases.map(\.rawValue)
    let palette = colors.isEmpty ? ["#4b8efb"] : colors
    while true {
      let next = Avatar(
        shape: shapes.randomElement(using: &generator) ?? "chip",
        color: palette.randomElement(using: &generator) ?? "#4b8efb")
      if next.shape != previous?.shape && next.color != previous?.color { return next }
    }
  }
  public static func randomAvatar(excluding previous: Avatar? = nil) -> Avatar {
    var generator = SystemRandomNumberGenerator()
    return randomAvatar(excluding: previous, using: &generator)
  }
  public static func randomName(excluding taken: [String] = []) -> String {
    let lowered = Set(taken.map { $0.lowercased() })
    return names.filter { !lowered.contains($0.lowercased()) }.randomElement()
      ?? names.randomElement() ?? "Atlas"
  }
  /// `POST /api/v0/bots`.
  public static func body(requestId: String, name: String, avatar: Avatar, role: BotRole) -> JSON {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    return .object([
      "clientRequestId": .string(requestId),
      "name": .string(String((trimmed.isEmpty ? "New Bot" : trimmed).prefix(120))),
      "icon": .string(avatar.shape), "color": .string(avatar.color.lowercased()),
      "description": .string(role.description),
    ])
  }

  /// What one Create asked for, to recognize its bot when the answer never arrived.
  public struct Request: Hashable, Sendable {
    public var name: String
    public var icon: String
    public var color: String
    public init(body: JSON) {
      name = body["name"].string
      icon = body["icon"].string
      color = body["color"].string.lowercased()
    }
    public init(_ bot: Bot) {
      name = bot.name
      icon = bot.icon
      color = bot.color.lowercased()
    }
  }

  /// A bot that appeared while the first-bot screen was open.
  public enum Arrival: Equatable, Sendable {
    /// This iPhone's Create reached the server, though its answer was lost on the way.
    case ours(Bot)
    /// Someone finished setup on another device.
    case elsewhere(Bot)
    public var bot: Bot {
      switch self {
      case .ours(let bot), .elsewhere(let bot): return bot
      }
    }
  }

  /// The newest bot that wasn't on the server when setup opened (`existing`) and
  /// hasn't been set aside (`ignoring`). One matching a Create sent from here is ours.
  public static func arrival(
    bots: [Bot], existing: Set<String>, sent: Set<Request>, ignoring: Set<String> = []
  ) -> Arrival? {
    let new = bots.filter { !existing.contains($0.id) && !ignoring.contains($0.id) }
    if let mine = new.last(where: { sent.contains(Request($0)) }) { return .ours(mine) }
    return new.last.map(Arrival.elsewhere)
  }
}

/// Text the server-address and sign-in screens show about the server.
public enum ServerAddressText {
  /// `host` or `host:port` from what was typed, for "Still trying {host}…".
  public static func authority(_ server: String) -> String {
    guard let url = URL(string: API.withDefaultScheme(server)), let host = url.host,
      !host.isEmpty
    else { return server.trimmingCharacters(in: .whitespacesAndNewlines) }
    return url.port.map { host + ":" + String($0) } ?? host
  }
  /// The host alone, for "Sign in to {host}".
  public static func host(_ server: String) -> String {
    URL(string: API.withDefaultScheme(server))?.host
      ?? server.trimmingCharacters(in: .whitespacesAndNewlines)
  }
  /// `GET /api/system/version`'s release, such as "0.0.5". Nil when missing or blank.
  public static func releaseVersion(_ json: JSON) -> String? {
    let value = json["releaseVersion"].string.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
  }
  public static func found(version: String?) -> String {
    version.map { "Found OpenTeam " + $0 } ?? "Found OpenTeam"
  }
}

extension ModelTestState {
  /// W5's line under "It works!": "GPT-5.5 replied in 1.2 s."
  public func replySentence(model: String) -> String? {
    guard case .passed(let latency) = self else { return nil }
    return model + " replied in " + String(format: "%.1f", latency / 1000) + " s."
  }
}
