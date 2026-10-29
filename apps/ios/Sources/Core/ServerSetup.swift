import Foundation

/// Voice-note transcription settings (packages/contracts/src/transcription.ts).
public struct TranscriptionSettings: Codable, Sendable, Equatable {
  public enum Provider: String, Codable, Sendable, CaseIterable, Identifiable {
    case openai, deepgram
    case compatible = "openai-compatible"
    public var id: String { rawValue }
    public var title: String {
      switch self {
      case .openai: return "OpenAI"
      case .deepgram: return "Deepgram"
      case .compatible: return "Custom / OpenAI-compatible"
      }
    }
    /// Hosted services have a fixed address; only a custom service's is editable.
    public var hostedBaseURL: String? {
      switch self {
      case .openai: return "https://api.openai.com/v1"
      case .deepgram: return "https://api.deepgram.com/v1"
      case .compatible: return nil
      }
    }
    public var defaultModel: String {
      switch self {
      case .openai: return "gpt-transcribe"
      case .deepgram: return "nova-3"
      case .compatible: return ""
      }
    }
  }
  public var enabled: Bool
  public var provider: Provider
  public var baseUrl: String
  public var model: String
  public var language: String
  public init(
    enabled: Bool = false, provider: Provider = .compatible, baseUrl: String = "",
    model: String = "", language: String = ""
  ) {
    self.enabled = enabled
    self.provider = provider
    self.baseUrl = baseUrl
    self.model = model
    self.language = language
  }
  /// Switching provider resets the address and model to that provider's defaults.
  public mutating func choose(_ next: Provider) {
    provider = next
    baseUrl = next.hostedBaseURL ?? ""
    model = next.defaultModel
  }
}

/// `GET/PATCH /api/v0/server-settings/transcription`. Keys are never returned.
public struct TranscriptionSettingsView: Codable, Sendable, Equatable {
  public var settings: TranscriptionSettings
  public var hasApiKey: Bool
  public var configured: Bool
  public init(settings: TranscriptionSettings, hasApiKey: Bool = false, configured: Bool = false) {
    self.settings = settings
    self.hasApiKey = hasApiKey
    self.configured = configured
  }
  private enum CodingKeys: String, CodingKey {
    case enabled, provider, baseUrl, model, language, hasApiKey, configured
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    settings = TranscriptionSettings(
      enabled: try c.decode(Bool.self, forKey: .enabled),
      provider: try c.decode(TranscriptionSettings.Provider.self, forKey: .provider),
      baseUrl: try c.decode(String.self, forKey: .baseUrl),
      model: try c.decode(String.self, forKey: .model),
      language: try c.decode(String.self, forKey: .language))
    hasApiKey = try c.decode(Bool.self, forKey: .hasApiKey)
    configured = try c.decode(Bool.self, forKey: .configured)
  }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(settings.enabled, forKey: .enabled)
    try c.encode(settings.provider, forKey: .provider)
    try c.encode(settings.baseUrl, forKey: .baseUrl)
    try c.encode(settings.model, forKey: .model)
    try c.encode(settings.language, forKey: .language)
    try c.encode(hasApiKey, forKey: .hasApiKey)
    try c.encode(configured, forKey: .configured)
  }
  /// The Settings row summary: "Off", or the provider in use.
  /// Never configured: no saved service, address or key.
  public var untouched: Bool { !configured && !hasApiKey && settings.baseUrl.isEmpty }
  public var summary: String {
    guard settings.enabled else { return "Off" }
    return configured ? settings.provider.title : "Not set up"
  }
}

/// `POST /api/v0/server-settings/transcription/check`.
public struct TranscriptionCheck: Codable, Sendable, Equatable {
  /// pass, warn or fail.
  public var level: String
  public var status: String
  public var detail: String
  public init(level: String, status: String, detail: String) {
    self.level = level
    self.status = status
    self.detail = detail
  }
}

/// The unsaved edits on the Voice notes screen, including a typed or removed API key.
public struct TranscriptionDraft: Equatable, Sendable {
  public var settings: TranscriptionSettings
  /// A typed replacement key. Never persisted or echoed.
  public var apiKey = ""
  public var removeKey = false
  public init(_ saved: TranscriptionSettingsView?) {
    settings = saved?.settings ?? TranscriptionSettings()
    // Nothing set up yet: start on OpenAI and its default model, as desktop does.
    if let saved, saved.untouched { settings.choose(.openai) }
  }
  public mutating func choose(_ provider: TranscriptionSettings.Provider) {
    settings.choose(provider)
    apiKey = ""
    removeKey = false
  }
  /// A saved key applies only to the same service at the same address.
  public func sameEndpoint(as saved: TranscriptionSettingsView?) -> Bool {
    saved?.settings.provider == settings.provider && saved?.settings.baseUrl == settings.baseUrl
  }
  public func hasSavedKey(_ saved: TranscriptionSettingsView?) -> Bool {
    sameEndpoint(as: saved) && saved?.hasApiKey == true && !removeKey
  }
  public func changed(from saved: TranscriptionSettingsView?) -> Bool {
    guard let saved else { return true }
    return !apiKey.isEmpty || removeKey || saved.settings != settings
  }
  /// The PUT body: omitting `apiKey` keeps the saved key; null removes it.
  public var body: JSON {
    var fields: [String: JSON] = [
      "enabled": .bool(settings.enabled), "provider": .string(settings.provider.rawValue),
      "baseUrl": .string(settings.baseUrl.trimmingCharacters(in: .whitespacesAndNewlines)),
      "model": .string(settings.model.trimmingCharacters(in: .whitespacesAndNewlines)),
      "language": .string(settings.language.trimmingCharacters(in: .whitespacesAndNewlines)),
    ]
    let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
    if !key.isEmpty {
      fields["apiKey"] = .string(key)
    } else if removeKey {
      fields["apiKey"] = .null
    }
    return .object(fields)
  }
}

public enum TranscriptionRequest {
  public static let path = "/api/v0/server-settings/transcription"
  public static let checkPath = path + "/check"
  /// Desktop's confirmation after saving.
  public static func savedMessage(_ view: TranscriptionSettingsView) -> String {
    view.configured
      ? "Saved. Voice notes are enabled on connected devices."
      : "Saved. Voice notes are disabled."
  }
}

/// `runtime` in client-bootstrap and client-runtime. Empty until the first snapshot.
public struct RuntimeStatus: Equatable, Sendable {
  public struct Check: Equatable, Sendable, Identifiable {
    public let key: String
    public let label: String
    public let ready: Bool
    public var id: String { key }
  }
  public var values: [String: String]
  public init(_ json: JSON) {
    values = json.object.compactMapValues { value in
      if case .string(let text) = value { return text }
      return nil
    }
  }
  public init(values: [String: String]) { self.values = values }
  /// ready, missing, invalid or unavailable; nil before the first snapshot.
  public var inference: String? { values["inference"] }
  /// The server checks onboarding's first step shows, in desktop's order.
  public static let serverChecks: [(key: String, label: String)] = [
    ("server", "Server"), ("database", "Database"), ("queue", "Task queue"),
    ("computer", "Bot computer"),
  ]
  /// The server's own `server` value is its overall status ("degraded" whenever any
  /// part is down), so the Server row passes whenever a snapshot arrived at all: the
  /// server answered. The other rows use their own status.
  public var serverChecks: [Check] {
    Self.serverChecks.map { check in
      Check(
        key: check.key, label: check.label,
        ready: check.key == "server" ? !values.isEmpty : values[check.key] == "ready")
    }
  }
  public var serverReady: Bool { serverChecks.allSatisfy(\.ready) }
  /// Every service for Settings → Server status, with friendly names.
  public var statusRows: [(label: String, value: String)] {
    let labels: [String: String] = [
      "server": "Server", "database": "Database", "queue": "Task queue",
      "computer": "Bot computer", "inference": "Model", "transcription": "Voice notes",
    ]
    let order = ["server", "database", "queue", "computer", "inference", "transcription"]
    let keys = order.filter { values[$0] != nil } + values.keys.filter { !order.contains($0) }.sorted()
    return keys.map { key in
      (labels[key] ?? key.capitalized, Self.describe(values[key] ?? ""))
    }
  }
  static func describe(_ value: String) -> String {
    switch value {
    case "ready": return "Ready"
    case "configured": return "Set up"
    case "missing": return "Not set up"
    case "invalid": return "Not working"
    case "unavailable": return "Unavailable"
    case "degraded": return "Degraded"
    default: return value.isEmpty ? "Unknown" : value.capitalized
    }
  }
}

/// The Home banner explaining why bots are silent without a working model.
public struct ModelStatusBanner: Equatable, Sendable {
  public let message: String
  public let action: String
  public init?(inference: String?) {
    switch inference {
    case "missing":
      message = "No model is connected, so your bots can't reply yet."
      action = "Connect a model"
    case "invalid":
      message = "Your model connection stopped working, so your bots can't reply."
      action = "Connect a model"
    case "unavailable":
      message = "Your server can't reach its model service right now."
      action = "Open settings"
    default: return nil
    }
  }
}

/// First-run setup after sign-in: shown once per server when it has no bots or no
/// model. Established servers are remembered as finished the first time they're seen.
public enum OnboardingDecision {
  public static func key(server: String) -> String { "onboarding-finished:" + server }
  public static func needed(bots: Int, runtime: RuntimeStatus) -> Bool {
    bots == 0 || runtime.inference == "missing"
  }
}
