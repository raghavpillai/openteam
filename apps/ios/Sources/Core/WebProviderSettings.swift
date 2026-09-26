import Foundation

/// Web search and web fetch are configured separately: each tool has its own
/// provider list, API keys and connection checks, stored on the server.
public enum WebTool: String, CaseIterable, Sendable {
  case search, fetch
  public var title: String { self == .search ? "Search" : "Fetch" }
  /// The one explanatory line under a tool's provider list.
  public var footnote: String {
    self == .search
      ? "The service bots use to find information on the web."
      : "How bots read a web page without opening their browser."
  }
  /// What turning the tool off means, shown on its Off row.
  public var offConsequence: String {
    self == .search ? "Bots can't search the web." : "Bots read pages only in their browser."
  }
}

/// A provider's API key: its only field, and always a secret.
public struct WebProviderField: Identifiable, Sendable, Hashable {
  public let id: String
  public let label: String
  public let secret: Bool
  public let required: Bool
  public let placeholder: String
  static let apiKey = Self(
    id: "apiKey", label: "API key", secret: true, required: true, placeholder: "API key")
}

public struct WebProviderInfo: Identifiable, Sendable, Hashable {
  public let id: String
  public let name: String
  /// Asset catalog icon `WebProvider-<brand>`, shared with desktop's provider artwork.
  public let brand: String
  public let description: String
  public let fields: [WebProviderField]
  public let setupURL: URL?
  init(_ id: String, _ name: String, brand: String, _ description: String, keyURL: String?) {
    self.id = id
    self.name = name
    self.brand = brand
    self.description = description
    fields = keyURL == nil ? [] : [.apiKey]
    setupURL = keyURL.flatMap(URL.init(string:))
  }
  /// Only the built-in fetcher works without a key.
  public var needsKey: Bool { !fields.isEmpty }
}

/// The same providers, order and copy as packages/contracts/src/web-search.ts.
/// Tests/CoreTests/Fixtures/web-provider-catalog.json is exported from the contract to check it.
public enum WebProviderCatalog {
  public static let search: [WebProviderInfo] = [
    .init(
      "exa", "Exa", brand: "exa", "AI search with page highlights.",
      keyURL: "https://dashboard.exa.ai/api-keys"),
    .init(
      "brave", "Brave Search", brand: "brave", "Results from Brave's independent index.",
      keyURL: "https://api-dashboard.search.brave.com/app/keys"),
    .init(
      "parallel", "Parallel", brand: "parallel", "Search built for AI agents.",
      keyURL: "https://platform.parallel.ai"),
    .init(
      "firecrawl", "Firecrawl", brand: "firecrawl", "Web search with page summaries.",
      keyURL: "https://www.firecrawl.dev/app/api-keys"),
    .init(
      "bing-serpapi", "Bing", brand: "bing", "Bing results through a SerpApi key.",
      keyURL: "https://serpapi.com/manage-api-key"),
    .init(
      "perplexity", "Perplexity", brand: "perplexity", "Results from Perplexity's search index.",
      keyURL: "https://www.perplexity.ai/account/api/keys"),
  ]
  public static let fetch: [WebProviderInfo] = [
    .init(
      "builtin", "Built-in", brand: "openteam",
      "Reads public pages from your server. Can't run JavaScript.", keyURL: nil),
    .init(
      "exa", "Exa", brand: "exa", "Live-crawled page text.",
      keyURL: "https://dashboard.exa.ai/api-keys"),
    .init(
      "parallel", "Parallel", brand: "parallel", "Full page content, including PDFs.",
      keyURL: "https://platform.parallel.ai"),
    .init(
      "firecrawl", "Firecrawl", brand: "firecrawl",
      "Renders JavaScript and returns clean Markdown.",
      keyURL: "https://www.firecrawl.dev/app/api-keys"),
  ]
  public static func providers(_ tool: WebTool) -> [WebProviderInfo] {
    tool == .search ? search : fetch
  }
  public static func info(_ tool: WebTool, _ id: String?) -> WebProviderInfo? {
    providers(tool).first { $0.id == id }
  }
}

public struct WebProviderCheck: Equatable, Sendable {
  public let passed: Bool
  public let message: String
  public let checkedAt: Date?
  public init(passed: Bool, message: String, checkedAt: Date?) {
    self.passed = passed
    self.message = message
    self.checkedAt = checkedAt
  }
  /// Desktop's wording: "just now", "5 min ago", "3 h ago", then the date.
  public func ago(now: Date = Date()) -> String {
    guard let checkedAt else { return "" }
    let minutes = Int((now.timeIntervalSince(checkedAt) / 60).rounded())
    if minutes < 1 { return "just now" }
    if minutes < 60 { return "\(minutes) min ago" }
    if minutes < 1_440 { return "\(Int((Double(minutes) / 60).rounded())) h ago" }
    return checkedAt.formatted(date: .abbreviated, time: .omitted)
  }
}

/// One provider's saved state. Keys are never returned, only whether one is saved.
public struct WebProviderState: Equatable, Sendable {
  public var secretSaved: Bool
  /// Everything the provider needs is saved, so it can be selected.
  public var ready: Bool
  public var check: WebProviderCheck?
  public init(secretSaved: Bool = false, ready: Bool = false, check: WebProviderCheck? = nil) {
    self.secretSaved = secretSaved
    self.ready = ready
    self.check = check
  }
  init(_ json: JSON) {
    secretSaved = json["secretSaved"].bool
    ready = json["ready"].bool
    let status = json["check"]["status"].string
    check =
      ["passed", "failed"].contains(status)
      ? WebProviderCheck(
        passed: status == "passed", message: json["check"]["message"].string,
        checkedAt: Self.date(json["check"]["checkedAt"].string))
      : nil
  }
  private static func date(_ text: String) -> Date? {
    let format = ISO8601DateFormatter()
    format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = format.date(from: text) { return date }
    format.formatOptions = [.withInternetDateTime]
    return format.date(from: text)
  }
}

public struct WebToolView: Equatable, Sendable {
  /// nil: the tool is off.
  public var selected: String?
  public var providers: [String: WebProviderState]
  public init(selected: String?, providers: [String: WebProviderState] = [:]) {
    self.selected = selected
    self.providers = providers
  }
  public subscript(_ id: String) -> WebProviderState { providers[id] ?? WebProviderState() }
  /// The active provider's name for the overview, or "Off".
  public func activeName(_ tool: WebTool) -> String {
    guard let selected else { return "Off" }
    return WebProviderCatalog.info(tool, selected)?.name ?? selected
  }
  /// One short line when the tool is off, limited, or its provider failed its check.
  public func warning(_ tool: WebTool) -> String? {
    guard let selected else {
      return tool == .search
        ? "Search is off. Bots can't search the web."
        : "Fetch is off. Bots read pages only in their browser."
    }
    if self[selected].check?.passed == false {
      return "\(activeName(tool)) failed its \(tool.rawValue) check."
    }
    return tool == .fetch && selected == "builtin" ? "Built-in fetch reads basic pages only." : nil
  }
}

public struct WebProvidersView: Equatable, Sendable {
  public var search: WebToolView
  public var fetch: WebToolView
  public init(search: WebToolView, fetch: WebToolView) {
    self.search = search
    self.fetch = fetch
  }
  public init(_ json: JSON) {
    func tool(_ value: JSON) -> WebToolView {
      let selected: String?
      if case .string(let id) = value["selected"], !id.isEmpty { selected = id } else { selected = nil }
      return WebToolView(
        selected: selected, providers: value["providers"].object.mapValues { WebProviderState($0) })
    }
    search = tool(json["search"])
    fetch = tool(json["fetch"])
  }
  public subscript(_ tool: WebTool) -> WebToolView {
    get { tool == .search ? search : fetch }
    set { if tool == .search { search = newValue } else { fetch = newValue } }
  }
}

/// A provider row's one-word state on its tool's list.
public struct WebProviderStatus: Equatable, Sendable {
  public enum Tone: Sendable { case ok, error, neutral }
  public let tone: Tone
  public let text: String
  public init(tone: Tone, text: String) {
    self.tone = tone
    self.text = text
  }
  public init(_ info: WebProviderInfo, _ state: WebProviderState) {
    switch (state.check?.passed, info.needsKey && !state.ready) {
    case (true?, _): self.init(tone: .ok, text: "Checked")
    case (false?, _): self.init(tone: .error, text: "Check failed")
    case (nil, true): self.init(tone: .neutral, text: "Add API key")
    case (nil, false): self.init(tone: .neutral, text: "Not checked")
    }
  }
}

public enum WebProvidersRequest {
  public static let path = "/api/v0/server-settings/web-providers"
  public static let checkPath = path + "/check"
  public static func select(_ tool: WebTool, _ id: String?) -> JSON {
    .object([tool.rawValue: .object(["selected": id.map(JSON.string) ?? .null])])
  }
  public static func removeKey(_ tool: WebTool, _ id: String) -> JSON {
    .object([tool.rawValue: .object(["providers": .object([id: .object(["apiKey": .null])])])])
  }
  public static func check(_ tool: WebTool, _ id: String) -> JSON {
    .object(["tool": .string(tool.rawValue), "provider": .string(id)])
  }
  /// The server's own wording for a provider that can't be used yet.
  public static func missingKeyMessage(_ info: WebProviderInfo, tool: WebTool) -> String {
    "Add the \(info.name) API key to use it for \(tool.rawValue)."
  }
}

/// A typed but unsaved API key. Never persisted or echoed.
public struct WebProviderDraft: Equatable, Sendable {
  public var key = ""
  public init() {}
  private var typed: String { key.trimmingCharacters(in: .whitespacesAndNewlines) }
  /// The PATCH body saving the typed key and optionally selecting the provider; nil when nothing changes.
  public func patch(_ tool: WebTool, _ info: WebProviderInfo, select: Bool = false) -> JSON? {
    var change: [String: JSON] = [:]
    if info.needsKey, !typed.isEmpty {
      change["providers"] = .object([info.id: .object(["apiKey": .string(typed)])])
    }
    if select { change["selected"] = .string(info.id) }
    return change.isEmpty ? nil : .object([tool.rawValue: .object(change)])
  }
  /// Whether the provider still lacks a key once this draft is saved.
  public func missingKey(_ info: WebProviderInfo, saved state: WebProviderState) -> Bool {
    info.needsKey && typed.isEmpty && !state.secretSaved
  }
}
