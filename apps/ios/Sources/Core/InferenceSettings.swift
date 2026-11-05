import Foundation

/// The server's model ("inference") settings and provider sign-ins, as in
/// packages/contracts/src/inference.ts.
public struct InferenceSelection: Codable, Sendable, Equatable {
  public var providerId: String
  /// Empty until a model is chosen from a connected provider's catalog.
  public var modelId: String
  public var reasoning: String
  public init(providerId: String, modelId: String, reasoning: String) {
    self.providerId = providerId
    self.modelId = modelId
    self.reasoning = reasoning
  }
}

public struct InferenceAuthMethod: Codable, Sendable, Hashable {
  /// "api_key" or "oauth".
  public var type: String
  public var label: String
  public var subscription: Bool
  public init(type: String, label: String = "", subscription: Bool = false) {
    self.type = type
    self.label = label
    self.subscription = subscription
  }
  /// The button that starts this method.
  public var actionTitle: String { type == "oauth" ? "Sign in" : "Add API key" }
}

public struct InferenceProvider: Codable, Sendable, Identifiable, Hashable {
  public var id: String
  public var name: String
  /// The plan people pay for ("ChatGPT", "Claude") instead of the runtime's name
  /// ("Codex", "Claude Code"), as desktop's provider-names.ts shows it.
  public var displayName: String { ModelSetupCatalog.planNames[id] ?? name }
  public var authMethods: [InferenceAuthMethod]
  public var connected: Bool
  public var authType: String?
  public var authSource: String?
  public var custom: Bool
  public var modelCount: Int
  public var modelStatus: String?
  public var modelMessage: String?
  public init(
    id: String, name: String, authMethods: [InferenceAuthMethod] = [], connected: Bool = false,
    authType: String? = nil, authSource: String? = nil, custom: Bool = false, modelCount: Int = 0,
    modelStatus: String? = nil, modelMessage: String? = nil
  ) {
    self.id = id
    self.name = name
    self.authMethods = authMethods
    self.connected = connected
    self.authType = authType
    self.authSource = authSource
    self.custom = custom
    self.modelCount = modelCount
    self.modelStatus = modelStatus
    self.modelMessage = modelMessage
  }
  /// Desktop's Connection row wording.
  public var connectionSummary: String {
    guard connected else { return "Not connected." }
    let how = authType == "oauth" ? "a sign-in" : "an API key"
    let source = authSource.map { $0.isEmpty ? "" : " from \($0)" } ?? ""
    return "Connected with \(how)\(source)."
  }
}

public struct InferenceModel: Codable, Sendable, Identifiable, Hashable {
  public var providerId: String
  public var modelId: String
  public var name: String
  public var reasoning: Bool
  public var reasoningLevels: [String]
  public var defaultReasoningLevel: String
  public var contextWindow: Int
  public var maxTokens: Int
  /// The provider's suggested model (OpenRouter's auto router), chosen by default.
  public var recommended: Bool
  public var id: String { modelId }
  public init(
    providerId: String, modelId: String, name: String? = nil, reasoning: Bool = false,
    reasoningLevels: [String] = [], defaultReasoningLevel: String = "off",
    contextWindow: Int = 0, maxTokens: Int = 0, recommended: Bool = false
  ) {
    self.providerId = providerId
    self.modelId = modelId
    self.name = name ?? modelId
    self.reasoning = reasoning
    self.reasoningLevels = reasoningLevels
    self.defaultReasoningLevel = defaultReasoningLevel
    self.contextWindow = contextWindow
    self.maxTokens = maxTokens
    self.recommended = recommended
  }
  /// `recommended` is sent only on the recommended model.
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    providerId = try c.decode(String.self, forKey: .providerId)
    modelId = try c.decode(String.self, forKey: .modelId)
    name = try c.decode(String.self, forKey: .name)
    reasoning = try c.decode(Bool.self, forKey: .reasoning)
    reasoningLevels = try c.decode([String].self, forKey: .reasoningLevels)
    defaultReasoningLevel = try c.decode(String.self, forKey: .defaultReasoningLevel)
    contextWindow = try c.decode(Int.self, forKey: .contextWindow)
    maxTokens = try c.decode(Int.self, forKey: .maxTokens)
    recommended = try c.decodeIfPresent(Bool.self, forKey: .recommended) ?? false
  }
  private enum CodingKeys: String, CodingKey {
    case providerId, modelId, name, reasoning, reasoningLevels, defaultReasoningLevel,
      contextWindow, maxTokens, recommended
  }
}

/// `GET /api/v0/server-settings[?provider=]`: the saved model, every provider, and
/// the requested provider's model catalog.
public struct ServerSettings: Codable, Sendable, Equatable {
  public var inference: InferenceSelection
  public var providers: [InferenceProvider]
  public var models: [InferenceModel]
  public var modelProviderId: String
  public init(
    inference: InferenceSelection, providers: [InferenceProvider], models: [InferenceModel],
    modelProviderId: String
  ) {
    self.inference = inference
    self.providers = providers
    self.models = models
    self.modelProviderId = modelProviderId
  }
  public func provider(_ id: String) -> InferenceProvider? { providers.first { $0.id == id } }
  /// The saved model, or nil when none is chosen yet.
  public var savedModel: InferenceSelection? { inference.modelId.isEmpty ? nil : inference }
  /// The model a new choice starts on: the one the catalog recommends, else its first.
  public var recommendedModel: InferenceModel? {
    models.first(where: \.recommended) ?? models.first
  }
}

public struct InferenceAuthPrompt: Codable, Sendable, Equatable {
  public struct Option: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var label: String
    public var description: String?
    public init(id: String, label: String, description: String? = nil) {
      self.id = id
      self.label = label
      self.description = description
    }
  }
  public var id: String
  /// "text", "secret", "select" or "manual_code".
  public var type: String
  public var message: String
  public var placeholder: String?
  public var options: [Option]?
  public init(
    id: String, type: String, message: String = "", placeholder: String? = nil,
    options: [Option]? = nil
  ) {
    self.id = id
    self.type = type
    self.message = message
    self.placeholder = placeholder
    self.options = options
  }
}

public struct InferenceDeviceCode: Codable, Sendable, Equatable {
  public var userCode: String
  public var verificationUri: String
  public var expiresInSeconds: Int?
  public init(userCode: String, verificationUri: String, expiresInSeconds: Int? = nil) {
    self.userCode = userCode
    self.verificationUri = verificationUri
    self.expiresInSeconds = expiresInSeconds
  }
}

/// A provider sign-in running on the server. Poll it until it is finished.
public struct InferenceAuthSession: Codable, Sendable, Equatable {
  public var id: String
  public var providerId: String
  public var authType: String
  /// running, waiting, connected, failed or cancelled.
  public var status: String
  public var prompt: InferenceAuthPrompt?
  public var authorizationUrl: String?
  public var deviceCode: InferenceDeviceCode?
  public var messages: [String]
  public var error: String?
  public init(
    id: String, providerId: String, authType: String, status: String,
    prompt: InferenceAuthPrompt? = nil, authorizationUrl: String? = nil,
    deviceCode: InferenceDeviceCode? = nil, messages: [String] = [], error: String? = nil
  ) {
    self.id = id
    self.providerId = providerId
    self.authType = authType
    self.status = status
    self.prompt = prompt
    self.authorizationUrl = authorizationUrl
    self.deviceCode = deviceCode
    self.messages = messages
    self.error = error
  }
  public var finished: Bool { ["connected", "failed", "cancelled"].contains(status) }
  /// The answer a person would give anyway. A phone can't receive a localhost
  /// browser redirect, so a choice between "browser" and "device_code" takes the code.
  public var automaticAnswer: (promptId: String, value: String)? {
    guard !finished, let prompt, prompt.type == "select" else { return nil }
    let ids = Set((prompt.options ?? []).map(\.id))
    guard ids.contains("browser"), ids.contains("device_code") else { return nil }
    return (prompt.id, "device_code")
  }
  /// For a sign-in that ends on a localhost page: where the browser lands with the
  /// code, which the app captures and submits in place of a pasted address.
  public var capturableRedirect: URL? {
    guard !finished, prompt?.type == "manual_code", authorizationUrl != nil else { return nil }
    return ProviderRedirect.local(prompt?.placeholder)
  }
}

/// Recognizes the localhost redirect that ends a provider's browser sign-in.
public enum ProviderRedirect {
  /// A plain-HTTP loopback address such as `http://localhost:53692/callback`.
  public static func local(_ value: String?) -> URL? {
    guard let value, let url = URL(string: value.trimmingCharacters(in: .whitespaces)),
      url.scheme?.lowercased() == "http",
      ["localhost", "127.0.0.1"].contains(url.host?.lowercased() ?? ""),
      url.user == nil, url.password == nil
    else { return nil }
    return url
  }
  /// Whether a navigation is the browser arriving at the redirect: same loopback
  /// host family, port and path, carrying a code or an error.
  public static func matches(_ url: URL, redirect: URL) -> Bool {
    guard url.scheme?.lowercased() == "http",
      ["localhost", "127.0.0.1"].contains(url.host?.lowercased() ?? ""),
      url.port == redirect.port,
      normalizedPath(url) == normalizedPath(redirect),
      let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
      items.contains(where: { ["code", "error"].contains($0.name) })
    else { return false }
    return true
  }
  private static func normalizedPath(_ url: URL) -> String {
    let path = url.path
    return path.isEmpty ? "/" : path
  }
}

/// `POST /api/v0/server-settings/inference/test`: one real, minimal request to the model.
public enum InferenceTestResult: Decodable, Sendable, Equatable {
  case passed(latencyMs: Double)
  case failed(error: String)
  private enum CodingKeys: String, CodingKey { case ok, latencyMs, error }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self =
      try c.decode(Bool.self, forKey: .ok)
      ? .passed(latencyMs: try c.decode(Double.self, forKey: .latencyMs))
      : .failed(error: try c.decode(String.self, forKey: .error))
  }
}

/// What a model test shows next to the Test button.
public enum ModelTestState: Equatable, Sendable {
  case idle, running
  case passed(latencyMs: Double)
  case failed(String)
  public init(_ result: InferenceTestResult) {
    switch result {
    case .passed(let latency): self = .passed(latencyMs: latency)
    case .failed(let error): self = .failed(ProviderErrorText.sentence(error))
    }
  }
  /// Desktop's wording: "Working · replied in 1.2 s".
  public var text: String? {
    switch self {
    case .idle: return nil
    case .running: return "Testing the model…"
    case .passed(let latency):
      return "Working · replied in " + String(format: "%.1f", latency / 1000) + " s"
    case .failed(let error): return error
    }
  }
}

/// Why a model test failed, as one plain sentence, and whether it's a blip worth
/// trying again (the network, a busy or restarting server or provider, a timeout)
/// rather than something to fix (a rejected key, an empty account, a missing model).
public struct ModelTestFailure: Equatable, Sendable {
  public var message: String
  public var transient: Bool
  /// The provider turned down the key or sign-in itself.
  public var rejected: Bool
  public init(message: String, transient: Bool, rejected: Bool = false) {
    self.message = message
    self.transient = transient
    self.rejected = rejected
  }

  /// The API-key step's wording: a rejected key names the provider, plainly; any
  /// other problem (a busy provider, a timeout) keeps its own sentence.
  public func keyMessage(provider name: String) -> String {
    rejected ? "\(name) didn't accept that key. Check it and try again." : message
  }

  /// The server ran the test and the provider failed (`ok: false` with its raw text).
  public init(provider raw: String) { self = ProviderErrorText.failure(raw) }

  /// The test request itself failed: no answer from the server, an error status, or
  /// an answer cut off on the way.
  public init(request error: Error) {
    if let network = error as? URLError {
      switch network.code {
      case .timedOut:
        self.init(message: "Your server didn't answer in time. Try again.", transient: true)
      case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
        .serverCertificateHasUnknownRoot:
        self.init(message: UserFacingError.message(error), transient: false)
      default:
        self.init(
          message: "Couldn't reach your server. Check your connection and try again.",
          transient: true)
      }
      return
    }
    if let api = error as? APIError {
      switch api.status {
      case 408, 504:
        self.init(message: "Your server didn't answer in time. Try again.", transient: true)
      case 429:
        self.init(
          message: "Your server is busy right now. Wait a moment and try again.", transient: true)
      case 500...599:
        self.init(
          message: "Your server had a problem (error \(api.status)). Try again in a moment.",
          transient: true)
      case 0 where api.message == "The server returned an invalid response.":
        self.init(message: "Your server's answer didn't come through. Try again.", transient: true)
      default:
        self.init(message: ProviderErrorText.plain(api.message), transient: false)
      }
      return
    }
    self.init(message: ProviderErrorText.plain(error.localizedDescription), transient: false)
  }
}

/// Turns a provider's raw failure (an HTTP status with a JSON body, a timeout, a
/// network error, an exception's class name) into one plain sentence.
public enum ProviderErrorText {
  public static func sentence(_ raw: String) -> String { failure(raw).message }

  public static func failure(_ raw: String) -> ModelTestFailure {
    let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let lower = text.lowercased()
    func has(_ words: String...) -> Bool { words.contains { lower.contains($0) } }
    let limited = ModelTestFailure(
      message: "The AI provider is limiting requests right now. Wait a moment and try again.",
      transient: true)
    let rejected = ModelTestFailure(
      message: "The AI provider didn't accept the sign-in or key. Sign in again, or choose a different AI.",
      transient: false, rejected: true)
    let slow = ModelTestFailure(message: "The AI took too long to answer. Try again.", transient: true)
    // A rate limit passes by waiting; an empty account doesn't, though both can be a 429.
    if has("rate limit", "rate_limit", "too many requests") { return limited }
    if has("quota", "billing", "credit") || status(in: text) == 402 {
      return ModelTestFailure(
        message:
          "Your AI provider account is out of credit or over its limit. Check its plan and billing, or choose a different AI.",
        transient: false)
    }
    if let status = status(in: text) {
      switch status {
      case 401, 403: return rejected
      case 404:
        return ModelTestFailure(
          message: "The AI provider couldn't find this model. Choose a different model.",
          transient: false)
      case 408, 504: return slow
      case 429: return limited
      case 500...599:
        return ModelTestFailure(
          message: "The AI provider had a problem (error \(status)). Try again in a moment.",
          transient: true)
      default: break
      }
    }
    if has("invalid api key", "incorrect api key", "invalid x-api-key", "invalid_api_key",
      "authentication_error", "unauthorized")
    {
      return rejected
    }
    if has("overloaded") {
      return ModelTestFailure(
        message: "The AI provider is overloaded right now. Try again in a moment.", transient: true)
    }
    if has("timed out", "timeout") { return slow }
    // The server's word for a request the provider refused as configured, e.g. reasoning off.
    if has("rejected the configuration or request") {
      return ModelTestFailure(
        message:
          "The AI provider didn't accept a request to this model. Choose a different model or reasoning effort.",
        transient: false)
    }
    if has("fetch failed", "econnrefused", "enotfound", "econnreset", "socket hang up") {
      return ModelTestFailure(
        message:
          "Your server couldn't reach the AI right now. Check its internet connection and try again.",
        transient: true)
    }
    return ModelTestFailure(message: plain(text), transient: false)
  }

  /// A readable message without an exception's class name ("OpenTeamClientError: …");
  /// raw JSON or nothing at all becomes a generic sentence.
  static func plain(_ raw: String) -> String {
    let stripped = raw.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(
      of: #"^(?:[A-Za-z]*Error:\s*)+"#, with: "", options: .regularExpression)
    guard !stripped.isEmpty, !stripped.hasPrefix("{"), !stripped.hasPrefix("[") else {
      return "The AI didn't reply. Try again."
    }
    return stripped
  }

  /// A leading HTTP status ("500 {…}", "Error 429: …", "status 503").
  private static func status(in text: String) -> Int? {
    let patterns = [#"^(\d{3})\b"#, #"(?i)\b(?:status|error|http)[\s:]+(\d{3})\b"#]
    for pattern in patterns {
      guard let regex = try? NSRegularExpression(pattern: pattern),
        let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
        let range = Range(match.range(at: 1), in: text),
        let value = Int(text[range]), (400...599).contains(value)
      else { continue }
      return value
    }
    return nil
  }
}

/// A model provider people usually mean, in the order onboarding offers them.
public struct FeaturedProvider: Sendable, Hashable, Identifiable {
  public let id: String
  public let title: String
  public let detail: String
}

public enum ModelSetupCatalog {
  /// Subscription sign-ins, named for the plan rather than the tool that uses it.
  public static let planNames = ["openai-codex": "ChatGPT", "claude-code": "Claude"]
  /// Same providers, order and copy as desktop's FEATURED_PROVIDERS.
  public static let featured: [FeaturedProvider] = [
    .init(id: "openai-codex", title: "ChatGPT", detail: "Sign in with your ChatGPT plan"),
    .init(id: "claude-code", title: "Claude", detail: "Sign in with your Claude plan"),
    .init(id: "openai", title: "OpenAI API key", detail: "Pay as you go with an OpenAI key"),
    .init(
      id: "anthropic", title: "Anthropic API key", detail: "Pay as you go with an Anthropic key"),
    .init(
      id: "openrouter", title: "OpenRouter", detail: "Many models with one OpenRouter account"),
  ]
  /// Featured providers by their friendly title, others by the server's name.
  public static func name(_ id: String, in settings: ServerSettings?) -> String {
    featured.first { $0.id == id }?.title ?? settings?.provider(id)?.name ?? id
  }
  /// Providers that aren't featured, for "More providers".
  public static func others(_ providers: [InferenceProvider]) -> [InferenceProvider] {
    providers.filter { provider in !featured.contains { $0.id == provider.id } }
  }
  public static func reasoningLabel(_ value: String) -> String {
    switch value {
    case "off": return "Off"
    case "xhigh": return "Extra high"
    default: return value.prefix(1).uppercased() + value.dropFirst()
    }
  }
}

/// The provider/model/reasoning being edited, compared with what the server saved.
public struct ModelChoice: Equatable, Sendable {
  public var providerId: String
  public var modelId: String
  public var reasoning: String
  public init(providerId: String, modelId: String, reasoning: String) {
    self.providerId = providerId
    self.modelId = modelId
    self.reasoning = reasoning
  }
  /// What to show after loading `settings` for `provider`: the saved model when it
  /// belongs to that provider, otherwise the catalog's recommended model (or its first)
  /// with its default reasoning.
  public init(loading settings: ServerSettings, provider: String? = nil) {
    let selected = provider ?? settings.inference.providerId
    let savedHere = settings.inference.providerId == selected
    let model =
      (savedHere && !settings.inference.modelId.isEmpty ? settings.inference.modelId : nil)
      ?? settings.recommendedModel?.modelId ?? ""
    let details = settings.models.first { $0.modelId == model }
    let reasoning =
      savedHere && settings.inference.modelId == model
      ? settings.inference.reasoning
      : details?.defaultReasoningLevel ?? settings.inference.reasoning
    self.init(providerId: selected, modelId: model, reasoning: reasoning)
  }
  /// Chooses a model, keeping the reasoning level when the model supports it.
  public mutating func select(model: InferenceModel) {
    modelId = model.modelId
    if !model.reasoningLevels.contains(reasoning) { reasoning = model.defaultReasoningLevel }
  }
  /// The level actually sent: the chosen one when the model offers it.
  public func effectiveReasoning(_ model: InferenceModel?) -> String {
    guard let model else { return "off" }
    return model.reasoningLevels.contains(reasoning) ? reasoning : model.defaultReasoningLevel
  }
  public func changed(from saved: InferenceSelection, model: InferenceModel?) -> Bool {
    saved.providerId != providerId || saved.modelId != modelId
      || saved.reasoning != effectiveReasoning(model)
  }
  /// The PATCH /server-settings/inference body (and a test body for an unsaved choice).
  public func body(model: InferenceModel?) -> InferenceSelection {
    InferenceSelection(
      providerId: providerId, modelId: modelId, reasoning: effectiveReasoning(model))
  }
}

public enum InferenceRequest {
  public static let settingsPath = "/api/v0/server-settings"
  public static let inferencePath = "/api/v0/server-settings/inference"
  public static let testPath = "/api/v0/server-settings/inference/test"
  public static func startPath(_ providerId: String) -> String {
    "/api/v0/inference-providers/\(API.segment(providerId))/auth-sessions"
  }
  public static func providerPath(_ providerId: String) -> String {
    "/api/v0/inference-providers/\(API.segment(providerId))"
  }
  public static func sessionPath(_ sessionId: String) -> String {
    "/api/v0/inference-provider-auth-sessions/\(API.segment(sessionId))"
  }
  public static func respondPath(_ sessionId: String) -> String { sessionPath(sessionId) + "/respond" }
  public static func start(authType: String) -> JSON { .object(["authType": .string(authType)]) }
  public static func respond(promptId: String, value: String) -> JSON {
    .object(["promptId": .string(promptId), "value": .string(value)])
  }
}
