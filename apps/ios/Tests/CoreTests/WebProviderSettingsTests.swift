import Foundation
import XCTest

@testable import OpenTeamCore

final class WebProviderSettingsTests: XCTestCase {
  func json(_ value: String) throws -> JSON {
    try JSONDecoder().decode(JSON.self, from: Data(value.utf8))
  }
  let exa = WebProviderCatalog.info(.search, "exa")!
  let builtin = WebProviderCatalog.info(.fetch, "builtin")!
  func testCatalogOrderKeysAndLinks() {
    XCTAssertEqual(
      WebProviderCatalog.search.map(\.id),
      ["exa", "brave", "parallel", "firecrawl", "bing-serpapi", "perplexity"])
    XCTAssertEqual(WebProviderCatalog.fetch.map(\.id), ["builtin", "exa", "parallel", "firecrawl"])
    XCTAssertEqual(WebProviderCatalog.info(.search, "bing-serpapi")?.brand, "bing")
    // Exa is listed for both tools with different copy; each is configured independently.
    XCTAssertNotEqual(WebProviderCatalog.info(.fetch, "exa")?.description, exa.description)
    // Every third-party provider has exactly one required API key; built-in fetch has none.
    for info in WebProviderCatalog.search + WebProviderCatalog.fetch where info.id != "builtin" {
      XCTAssertEqual(info.fields, [.apiKey], info.id)
      XCTAssertNotNil(info.setupURL, info.id)
    }
    XCTAssertFalse(builtin.needsKey)
    XCTAssertNil(builtin.setupURL)
  }
  func testParsesPerToolProvidersAndChecks() throws {
    let view = WebProvidersView(
      try json(
        #"{"search":{"selected":null,"providers":{"exa":{"secretSaved":true,"ready":true,"check":{"status":"failed","message":"Unauthorized","checkedAt":"2026-09-25T21:40:00Z"}}}},"fetch":{"selected":"builtin","providers":{"builtin":{"secretSaved":false,"ready":true,"check":{"status":"passed","message":"Fetch works: read example.com (1,234 characters).","checkedAt":"2026-09-25T21:40:00.000Z"}}}}}"#
      ))
    XCTAssertNil(view.search.selected)
    XCTAssertEqual(view.fetch.selected, "builtin")
    XCTAssertEqual(view.search["exa"].check?.passed, false)
    XCTAssertTrue(view.search["exa"].secretSaved)
    // The same provider id under another tool has its own state.
    XCTAssertFalse(view.fetch["exa"].secretSaved)
    let check = try XCTUnwrap(view.fetch["builtin"].check)
    XCTAssertTrue(check.passed)
    XCTAssertEqual(check.checkedAt, ISO8601DateFormatter().date(from: "2026-09-25T21:40:00Z"))
    XCTAssertEqual(check.ago(now: check.checkedAt!.addingTimeInterval(20)), "just now")
    XCTAssertEqual(check.ago(now: check.checkedAt!.addingTimeInterval(5 * 60)), "5 min ago")
    XCTAssertEqual(check.ago(now: check.checkedAt!.addingTimeInterval(3 * 3600)), "3 h ago")
  }
  func testOverviewNamesAndWarnings() {
    func tool(_ selected: String?, passed: Bool? = nil) -> WebToolView {
      let check = passed.map { WebProviderCheck(passed: $0, message: "", checkedAt: nil) }
      return WebToolView(
        selected: selected,
        providers: selected.map { [$0: WebProviderState(ready: true, check: check)] } ?? [:])
    }
    XCTAssertEqual(tool(nil).activeName(.search), "Off")
    XCTAssertEqual(tool(nil).warning(.search), "Search is off. Bots can't search the web.")
    XCTAssertEqual(tool(nil).warning(.fetch), "Fetch is off. Bots read pages only in their browser.")
    XCTAssertEqual(tool("builtin").activeName(.fetch), "Built-in")
    XCTAssertEqual(tool("builtin").warning(.fetch), "Built-in fetch reads basic pages only.")
    XCTAssertEqual(tool("builtin", passed: false).warning(.fetch), "Built-in failed its fetch check.")
    XCTAssertNil(tool("exa", passed: true).warning(.search))
    XCTAssertNil(tool("exa").warning(.search), "An unchecked provider is not a warning")
    XCTAssertEqual(tool("bing-serpapi", passed: false).warning(.search), "Bing failed its search check.")
    XCTAssertEqual(tool("exa").activeName(.fetch), "Exa")
  }
  func testRowStatusFollowsKeyAndCheck() {
    let brave = WebProviderCatalog.info(.search, "brave")!
    XCTAssertEqual(WebProviderStatus(brave, .init()), .init(tone: .neutral, text: "Add API key"))
    XCTAssertEqual(
      WebProviderStatus(brave, .init(secretSaved: true, ready: true)),
      .init(tone: .neutral, text: "Not checked"))
    let passed = WebProviderCheck(passed: true, message: "", checkedAt: nil)
    let failed = WebProviderCheck(passed: false, message: "", checkedAt: nil)
    XCTAssertEqual(
      WebProviderStatus(brave, .init(secretSaved: true, ready: true, check: passed)),
      .init(tone: .ok, text: "Checked"))
    XCTAssertEqual(
      WebProviderStatus(brave, .init(secretSaved: true, ready: true, check: failed)),
      .init(tone: .error, text: "Check failed"))
    XCTAssertEqual(
      WebProviderStatus(builtin, .init(ready: true)), .init(tone: .neutral, text: "Not checked"))
  }
  func testDraftSendsOnlyATypedKeyAndSelection() throws {
    var draft = WebProviderDraft()
    XCTAssertNil(draft.patch(.search, exa))
    draft.key = "   "
    XCTAssertNil(draft.patch(.search, exa), "Blank keys are ignored")
    draft.key = "  good-key\n"
    XCTAssertEqual(
      draft.patch(.search, exa), try json(#"{"search":{"providers":{"exa":{"apiKey":"good-key"}}}}"#))
    XCTAssertEqual(
      draft.patch(.search, exa, select: true),
      try json(#"{"search":{"selected":"exa","providers":{"exa":{"apiKey":"good-key"}}}}"#))
    XCTAssertEqual(
      WebProviderDraft().patch(.fetch, builtin, select: true),
      try json(#"{"fetch":{"selected":"builtin"}}"#))
    XCTAssertEqual(
      WebProvidersRequest.select(.fetch, nil), try json(#"{"fetch":{"selected":null}}"#))
    XCTAssertEqual(
      WebProvidersRequest.removeKey(.search, "exa"),
      try json(#"{"search":{"providers":{"exa":{"apiKey":null}}}}"#))
    XCTAssertEqual(
      WebProvidersRequest.check(.search, "exa"), try json(#"{"tool":"search","provider":"exa"}"#))
  }
  func testMissingKeyFollowsSavedAndTypedKeys() {
    var draft = WebProviderDraft()
    XCTAssertTrue(draft.missingKey(exa, saved: .init()))
    XCTAssertEqual(
      WebProvidersRequest.missingKeyMessage(exa, tool: .search),
      "Add the Exa API key to use it for search.")
    draft.key = "typed"
    XCTAssertFalse(draft.missingKey(exa, saved: .init()))
    XCTAssertFalse(WebProviderDraft().missingKey(exa, saved: .init(secretSaved: true, ready: true)))
    XCTAssertFalse(WebProviderDraft().missingKey(builtin, saved: .init()))
  }

  /// Fixture written from packages/contracts by scripts/export-web-providers.ts.
  func testCatalogMatchesTheServerContract() throws {
    let url = try XCTUnwrap(
      Bundle.module.url(forResource: "web-provider-catalog", withExtension: "json", subdirectory: "Fixtures"))
    let contract = try JSONDecoder().decode(JSON.self, from: Data(contentsOf: url))
    for tool in WebTool.allCases {
      let expected = contract[tool.rawValue].array
      let actual = WebProviderCatalog.providers(tool)
      XCTAssertEqual(actual.map(\.id), expected.map { $0["id"].string }, "\(tool) providers and order")
      for (info, entry) in zip(actual, expected) {
        XCTAssertEqual(info.name, entry["name"].string, info.id)
        XCTAssertEqual(info.brand, entry["brand"].string, info.id)
        XCTAssertEqual(info.description, entry["description"].string, info.id)
        XCTAssertEqual(info.setupURL?.absoluteString ?? "", entry["setupUrl"].string, info.id)
        XCTAssertEqual(info.fields.map(\.id), entry["fields"].array.map { $0["id"].string }, info.id)
        for (field, spec) in zip(info.fields, entry["fields"].array) {
          XCTAssertEqual(field.label, spec["label"].string, "\(info.id).\(field.id)")
          XCTAssertEqual(field.secret, spec["secret"].bool, "\(info.id).\(field.id)")
          XCTAssertEqual(field.required, spec["required"].bool, "\(info.id).\(field.id)")
          XCTAssertEqual(field.placeholder, spec["placeholder"].string, "\(info.id).\(field.id)")
        }
      }
    }
  }
}
