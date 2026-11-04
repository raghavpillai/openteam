import XCTest

@MainActor
final class ActionFailureUITests: XCTestCase {
  private let base = URL(
    string: ProcessInfo.processInfo.environment["ACTION_FAILURE_SERVER"] ?? "http://127.0.0.1:20137"
  )!
  private func control(_ body: [String: Any], path: String = "/__qa/control") async throws {
    var request = URLRequest(url: base.appendingPathComponent(path))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }
  private func launch(chat: Bool = false, draft: String? = nil, failures: [String: Any] = [:])
    async throws -> XCUIApplication
  {
    continueAfterFailure = false
    try await control([:], path: "/__qa/reset")
    if !failures.isEmpty { try await control(["failures": failures]) }
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base.absoluteString, "--appearance", ProcessInfo.processInfo.environment["ACTION_FAILURE_APPEARANCE"] ?? "dark"]
    if chat { app.launchArguments += ["--open-channel", "channel-research"] }
    if let draft { app.launchArguments += ["--visual-draft", draft] }
    app.launch()
    XCTAssertTrue(
      app.buttons[chat ? "conversation-details" : "search-button"].waitForExistence(timeout: 20))
    return app
  }
  private func capture(_ name: String, _ app: XCUIApplication) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
    if ProcessInfo.processInfo.environment["ACTION_FAILURE_RECORDING"] == "1" {
      // Hold the app's real UI on each checkpoint for readable screen recordings.
      Thread.sleep(forTimeInterval: 2)
    }
  }
  private func assertNoGlobalOfflineStatus(_ app: XCUIApplication) {
    XCTAssertFalse(app.staticTexts["Offline · messages will send when you reconnect"].exists)
    XCTAssertFalse(app.alerts.firstMatch.exists)
  }

  func testFailedSendAndRefreshUseLocalErrorsWithWorkingRetries() async throws {
    let app = try await launch(chat: true, draft: "Saved failed message")
    defer { app.terminate() }
    let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    XCTAssertTrue(input.waitForExistence(timeout: 10))
    let cached = app.staticTexts[
      "On it. I’m separating verified behavior from assumptions before writing the mobile shell."]
    XCTAssertTrue(cached.waitForExistence(timeout: 10))
    try await control(["offline": true])
    app.buttons["send-button"].tap()
    XCTAssertTrue(app.staticTexts["Saved failed message"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["Not delivered"].exists)
    XCTAssertFalse(app.staticTexts["Couldn't send message"].exists)
    XCTAssertTrue(app.staticTexts["Not delivered"].waitForExistence(timeout: 15))
    XCTAssertFalse(app.staticTexts["Couldn't send message"].exists)
    let retry = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'retry-send-'"))
      .firstMatch
    XCTAssertTrue(retry.exists)
    // Reopen the cached conversation to explicitly attempt a history refresh;
    // this does not depend on the simulator's background poll scheduling.
    if app.buttons["chat-back"].exists {
      app.buttons["chat-back"].tap()
    } else {
      app.buttons["channel-channel-ops"].tap()
      XCTAssertTrue(app.buttons["chat-load-error"].waitForExistence(timeout: 10))
    }
    app.buttons["channel-channel-research"].tap()
    XCTAssertTrue(app.staticTexts["message-refresh-error"].waitForExistence(timeout: 12))
    XCTAssertTrue(cached.exists)
    assertNoGlobalOfflineStatus(app)
    capture("message-failure-and-cached-refresh", app)
    try await control(["offline": false])
    app.buttons["retry-message-refresh"].tap()
    XCTAssertTrue(app.staticTexts["message-refresh-error"].waitForNonExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Not delivered"].exists)
    retry.tap()
    XCTAssertTrue(app.staticTexts["Not delivered"].waitForNonExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Saved failed message"].exists)
    let (data, _) = try await URLSession.shared.data(
      from: base.appendingPathComponent("__qa/state"))
    let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(
      (state["messages"] as? [[String: Any]])?.filter {
        $0["content"] as? String == "Saved failed message"
      }.count, 1)
    capture("message-retry-delivered", app)
  }

  func testSearchUnavailablePreservesQueryAndRetries() async throws {
    let app = try await launch()
    defer { app.terminate() }
    app.buttons["search-button"].tap()
    let field = app.textFields["search-input"]
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    try await control(["failures": ["GET /api/v0/search": ["status": 503, "count": 100]]])
    field.tap()
    field.typeText("Research")
    XCTAssertTrue(app.staticTexts["Search unavailable"].waitForExistence(timeout: 10))
    XCTAssertEqual(field.value as? String, "Research")
    assertNoGlobalOfflineStatus(app)
    capture("search-unavailable", app)
    try await control(["failures": [:]])
    app.buttons["search-retry"].tap()
    XCTAssertTrue(app.staticTexts["Search unavailable"].waitForNonExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Research"].waitForExistence(timeout: 10))
  }

  func testBotCreationFailureKeepsFormAndRetries() async throws {
    let app = try await launch()
    defer { app.terminate() }
    app.buttons["new-button"].tap()
    app.buttons["New Bot"].tap()
    let field = app.textFields["new-name"]
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.tap()
    field.typeText("Keep this Bot")
    try await control(["failures": ["POST /api/v0/bots": ["status": 503, "count": 1]]])
    app.buttons["create-confirm"].tap()
    XCTAssertTrue(
      app.staticTexts["Could not create the Bot. Please try again."].waitForExistence(timeout: 10))
    XCTAssertEqual(field.value as? String, "Keep this Bot")
    assertNoGlobalOfflineStatus(app)
    capture("bot-creation-failure", app)
    app.buttons["create-confirm"].tap()
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 15))
  }

  func testFirstLoadWithoutCacheHasTryAgain() async throws {
    let app = try await launch(failures: [
      "GET /api/v0/channels/channel-research/history": ["status": 503, "count": 100],
      "GET /api/v0/events/poll": ["status": 503, "count": 100],
    ])
    defer { app.terminate() }
    app.buttons["channel-channel-research"].tap()
    XCTAssertTrue(app.buttons["chat-load-error"].waitForExistence(timeout: 12))
    XCTAssertTrue(app.staticTexts["Something went wrong"].exists)
    assertNoGlobalOfflineStatus(app)
    capture("first-message-load-failure", app)
    // Keep automatic reconciliation from winning the race with the Retry tap.
    try await control(["failures": ["GET /api/v0/events/poll": ["status": 503, "count": 100]]])
    app.buttons["chat-load-error"].tap()
    XCTAssertTrue(app.buttons["chat-load-error"].waitForNonExistence(timeout: 12))
    try await control(["failures": [:]])
    XCTAssertTrue(
      app.descendants(matching: .any).matching(identifier: "message-input").firstMatch.exists)
  }
}
