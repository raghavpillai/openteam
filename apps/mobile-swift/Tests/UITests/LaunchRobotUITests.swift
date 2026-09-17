import XCTest

@MainActor final class LaunchRobotUITests: XCTestCase {
  private let base = "http://127.0.0.1:20028"

  private func prepare(delay: Int, fail: Bool = false) async throws {
    let requests: [(String, [String: Any])] = [
      ("/__qa/scene", ["scene": "dark-chat-seven"]),
      ("/__qa/control", ["failures": ["GET /api/v0/client-bootstrap": ["delayMs": delay, "status": fail ? 503 : 0]]]),
    ]
    for (path, body) in requests {
      var request = URLRequest(url: URL(string: base + path)!)
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
      let (_, response) = try await URLSession.shared.data(for: request)
      XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }
  }

  private func launch(_ appearance: String) -> XCUIApplication {
    continueAfterFailure = false
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", appearance, "--open-channel", "visual-chat"]
    app.launch()
    return app
  }

  private func loader(_ app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: "launch-robot").firstMatch
  }

  private func capture(_ name: String, _ app: XCUIApplication) {
    let image = XCTAttachment(screenshot: app.screenshot())
    image.name = "launch-" + name
    image.lifetime = .keepAlways
    add(image)
    let tree = XCTAttachment(string: app.debugDescription)
    tree.name = "launch-tree-" + name
    tree.lifetime = .keepAlways
    add(tree)
  }

  private func verifyLaunch(_ appearance: String) async throws {
    try await prepare(delay: 10000)
    let app = launch(appearance)
    XCTAssertTrue(loader(app).waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["chat-back"].exists)
    XCTAssertFalse(app.staticTexts["Opening OpenTeam…"].exists)
    XCTAssertFalse(app.progressIndicators.firstMatch.exists)
    capture(appearance + "-thinking-a", app)
    try await Task.sleep(for: .milliseconds(1100))
    capture(appearance + "-thinking-b", app)
    XCTAssertTrue(loader(app).waitForNonExistence(timeout: 15))
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Got it — here."].exists)
    capture(appearance + "-messages", app)
    let field = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    field.tap()
    field.typeText("Draft after launch")
    XCTAssertTrue(app.buttons["send-button"].isEnabled)
    XCUIDevice.shared.press(.home)
    app.activate()
    XCTAssertFalse(loader(app).exists)
    XCTAssertEqual(field.value as? String, "Draft after launch")
  }

  func testDarkRobotFadesToMessagesAndDoesNotReplayOnForeground() async throws {
    try await verifyLaunch("dark")
  }

  func testLightRobotFadesToMessagesAndKeepsDraftUsable() async throws {
    try await verifyLaunch("light")
  }

  func testStartupFailureRevealsConnectionScreen() async throws {
    try await prepare(delay: 5000, fail: true)
    let app = launch("dark")
    XCTAssertTrue(loader(app).waitForExistence(timeout: 5))
    capture("connection-recovery-loading", app)
    XCTAssertTrue(loader(app).waitForNonExistence(timeout: 12))
    XCTAssertTrue(app.buttons["get-started"].waitForExistence(timeout: 5))
    app.buttons["get-started"].tap()
    XCTAssertTrue(app.textFields["server-field"].waitForExistence(timeout: 5))
    capture("connection-recovery", app)
  }
}
