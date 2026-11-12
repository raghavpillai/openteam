import XCTest

/// Uses a dedicated parity fixture; never connects to a user's server.
@MainActor final class SearchNavigationUITests: XCTestCase {
  let base = URL(string: "http://127.0.0.1:20124")!

  @discardableResult
  func control(_ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
    var request = URLRequest(url: base.appendingPathComponent(path))
    if let body {
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  func launch(appearance: String = "light") async throws -> XCUIApplication {
    continueAfterFailure = false
    try await control("__qa/scene", ["scene": "history-pages"])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base.absoluteString, "--appearance", appearance,
      "--ui-testing-scroll-geometry"]
    app.launch()
    XCTAssertTrue(app.buttons["search-button"].waitForExistence(timeout: 20))
    app.buttons["search-button"].tap()
    XCTAssertTrue(app.textFields["search-input"].waitForExistence(timeout: 5))
    return app
  }

  func openResult(_ app: XCUIApplication, number: Int = 90) {
    let text = "Page message \(number)"
    app.textFields["search-input"].typeText(text)
    let result = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    XCTAssertTrue(result.waitForExistence(timeout: 8))
    print("FLASH_JUMP \(number) \(Date().timeIntervalSince1970)")
    result.tap()
    XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 8))
  }

  func drag(_ app: XCUIApplication, older: Bool) {
    let list = app.tables["chat-history"]
    let start = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: older ? 0.3 : 0.8))
    let end = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: older ? 0.8 : 0.3))
    start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0)
  }

  func capture(_ name: String, _ app: XCUIApplication) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }

  // The same interaction on the base commit and the fix for before/after MP4s.
  func testRecordSearchNavigation() async throws {
    let app = try await launch()
    defer { app.terminate() }
    openResult(app)
    capture("search-destination", app)
    try await Task.sleep(for: .seconds(1))
    for _ in 0..<4 { drag(app, older: true) }
    capture("older-history", app)
    for _ in 0..<8 { drag(app, older: false) }
    capture("newer-history", app)
  }
  func requests() async throws -> [[String: Any]] {
    try await control("__qa/state")["requests"] as? [[String: Any]] ?? []
  }

  func testResultHighlightsWithoutFetchingDisconnectedLatestPage() async throws {
    let app = try await launch()
    defer { app.terminate() }
    // A slow latest-page endpoint must not hold up an already loaded context.
    try await control("__qa/control", ["failures": [
      "GET /api/v0/channels/visual-chat/history": ["delayMs": 5000, "count": 20]
    ]])
    openResult(app)
    let frame = try historyFrame(app)
    XCTAssertEqual(frame["lastHighlightedMessage"] as? String, "visual-message-visual-chat-90")
    // Also cover the event poll's reconciliation after the result has opened.
    try await Task.sleep(for: .seconds(3))
    let history = try await requests().filter { ($0["path"] as? String)?.hasSuffix("/history") == true }
    XCTAssertTrue(history.isEmpty, "A search context must open without requesting the latest page")
    XCTAssertTrue(app.buttons["Latest messages"].exists)
  }

  func testScrollingLoadsOlderAndNewerPagesAutomatically() async throws {
    let app = try await launch()
    defer { app.terminate() }
    openResult(app)
    for _ in 0..<4 { drag(app, older: true) }
    let older = try await requests().filter { ($0["path"] as? String)?.hasSuffix("/history") == true }
    XCTAssertFalse(older.isEmpty, "Scrolling toward the first loaded row fetches the previous page")
    // Go back through the original context and past its newest edge.
    for _ in 0..<10 { drag(app, older: false) }
    let later = try await requests().filter {
      let path = $0["path"] as? String ?? ""
      return path.hasSuffix("/context") && !path.contains("visual-chat-90/")
    }
    XCTAssertFalse(later.isEmpty, "Scrolling down fetches newer context without a button tap")
    XCTAssertEqual(app.buttons["Latest messages"].value as? String ?? "", "",
      "Loading historical pages must not label them as new arrivals")
    capture("automatic-pagination", app)
  }

  func testFailedAutomaticPageDoesNotLoopAndCanBeRetried() async throws {
    let app = try await launch()
    defer { app.terminate() }
    openResult(app)
    try await control("__qa/control", ["failures": [
      "GET /api/v0/channels/visual-chat/history": ["status": 503, "count": 20]
    ]])
    for _ in 0..<4 {
      if app.alerts.firstMatch.exists { break }
      drag(app, older: true)
    }
    let count = try await requests().filter { ($0["path"] as? String)?.hasSuffix("/history") == true }.count
    XCTAssertEqual(count, 1, "A failing edge is requested once per visit")
    // Dismiss the ordinary request error, then retry the retained control.
    if app.alerts.firstMatch.exists { app.alerts.firstMatch.buttons.firstMatch.tap() }
    try await control("__qa/control", ["failures": [:]])
    let retry = app.buttons["Load earlier messages"]
    XCTAssertTrue(retry.waitForExistence(timeout: 3))
    retry.tap()
    for _ in 0..<2 { drag(app, older: true) }
    let attempts = try await requests().filter { ($0["path"] as? String)?.hasSuffix("/history") == true }
    XCTAssertEqual(attempts.count, count + 1)
    XCTAssertFalse(app.alerts.firstMatch.exists)
  }

  func testChangingQueryRejectsDelayedResultsAndClearResetsSearch() async throws {
    let app = try await launch()
    defer { app.terminate() }
    try await control("__qa/control", ["failures": [
      "GET /api/v0/search": ["delayMs": 1500, "count": 1]
    ]])
    let input = app.textFields["search-input"]
    input.typeText("Page message 90")
    try await Task.sleep(for: .milliseconds(300))
    app.buttons["Clear"].tap()
    input.typeText("Page message 80\n")
    let current = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Page message 80")).firstMatch
    XCTAssertTrue(current.waitForExistence(timeout: 8))
    try await Task.sleep(for: .seconds(2))
    XCTAssertTrue(current.exists)
    XCTAssertFalse(app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Page message 90")).firstMatch.exists)
    app.buttons["Clear"].tap()
    XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "New Bot")).firstMatch.exists)
  }

  func testRevisitingQueryShowsCachedResultsDuringSlowRefresh() async throws {
    let app = try await launch()
    defer { app.terminate() }
    let input = app.textFields["search-input"]
    input.typeText("Page message 90")
    let result = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Page message 90")).firstMatch
    XCTAssertTrue(result.waitForExistence(timeout: 8))
    app.buttons["Clear"].tap()
    try await control("__qa/control", ["failures": [
      "GET /api/v0/search": ["delayMs": 5000, "count": 20]
    ]])
    input.typeText("Page message 90")
    XCTAssertTrue(result.waitForExistence(timeout: 1), "A repeated query should use the sheet's cache immediately")
  }

  func historyFrame(_ app: XCUIApplication) throws -> [String: Any] {
    let value = try XCTUnwrap(app.tables["chat-history"].value as? String)
    let data = try XCTUnwrap(value.data(using: .utf8))
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
  func geometry(_ app: XCUIApplication) throws -> [[String: Any]] {
    try XCTUnwrap(historyFrame(app)["rows"] as? [[String: Any]])
  }

  func testPrependingPagePreservesReadingPosition() async throws {
    let app = try await launch()
    defer { app.terminate() }
    openResult(app)
    try await control("__qa/control", ["failures": [
      "GET /api/v0/channels/visual-chat/history": ["delayMs": 5000, "count": 1]
    ]])
    var requested = false
    for _ in 0..<5 {
      drag(app, older: true)
      requested = try await requests().contains { ($0["path"] as? String)?.hasSuffix("/history") == true }
      if requested { break }
    }
    XCTAssertTrue(requested)
    let before = try geometry(app)
    let anchor = try XCTUnwrap(before.min {
      abs(($0["y"] as? Double ?? 0) - 400) < abs(($1["y"] as? Double ?? 0) - 400)
    })
    let id = try XCTUnwrap(anchor["id"] as? String)
    let y = try XCTUnwrap(anchor["y"] as? Double)
    try await Task.sleep(for: .seconds(6))
    let after = try XCTUnwrap(try geometry(app).first { $0["id"] as? String == id })
    XCTAssertEqual(try XCTUnwrap(after["y"] as? Double), y, accuracy: 2,
      "Loading older messages must preserve the visible message's pixel position")
  }

  func testRecordMessageFlashesOnBothSides() async throws {
    // The fixture alternates received (even) and sent (odd) messages.
    for appearance in ["light", "dark"] {
      for number in [90, 91] {
        let app = try await launch(appearance: appearance)
        print("FLASH_APPEARANCE \(appearance)")
        openResult(app, number: number)
        let frame = try historyFrame(app)
        XCTAssertEqual(frame["lastHighlightedMessage"] as? String,
          "visual-message-visual-chat-\(number)")
        XCTAssertTrue(app.staticTexts["Page message \(number)"].isHittable)
        try await Task.sleep(for: .seconds(1))
        capture("\(appearance)-\(number == 91 ? "sent" : "received")-settled", app)
        app.terminate()
      }
    }
  }

}
