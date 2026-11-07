import XCTest

/// Run on a landscape iPad/Duo against the loopback parity fixture.
@MainActor final class SidebarPersistenceUITests: XCTestCase {
  private let base = ProcessInfo.processInfo.environment["SIDEBAR_PERSISTENCE_SERVER"] ?? "http://127.0.0.1:20141"
  private let session = UUID().uuidString

  private func configure(_ path: String = "/__qa/control", _ body: [String: Any]) async throws {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }

  private func launch(server: String? = nil) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", server ?? base, "--appearance", "dark",
      "--qa-session", session]
    app.launch()
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 20))
    return app
  }

  private func waitForValue(_ value: String, in app: XCUIApplication, timeout: Double = 10) async {
    let condition = expectation(for: NSPredicate(format: "value == %@", value),
      evaluatedWith: app.buttons["marketplace-button"])
    await fulfillment(of: [condition], timeout: timeout)
  }

  private func capture(_ name: String, _ app: XCUIApplication) {
    let image = XCTAttachment(screenshot: app.screenshot())
    image.name = name
    image.lifetime = .keepAlways
    add(image)
  }

  func testCachedIconsSurviveRelaunchNavigationAndFailedRevalidation() async throws {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .landscapeLeft
    try await configure("/__qa/reset", [:])
    try await configure("/__qa/scene", ["scene": "dark-home"])
    let plugins = ["slack", "google-calendar", "notion"].map { key in
      ["key": key, "pluginKey": key, "name": key,
       "logoUrl": base + "/unbundled-plugin-artwork/" + key + ".png"]
    }
    try await configure("/__qa/control", ["pluginCatalog": plugins, "pluginInstalls": plugins])
    let app = launch()
    await waitForValue("3 apps installed", in: app)
    XCTAssertTrue(app.descendants(matching: .any)["idle-conversation"].exists)
    capture("idle-chat-and-local-icons", app)
    // Let the debounced account snapshot reach disk before abruptly terminating.
    try await Task.sleep(for: .milliseconds(400))
    app.terminate()
    try await configure("/__qa/control", ["failures": ["GET /api/v0/plugins": ["delayMs": 15000]]])
    app.launch()
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons["marketplace-button"].value as? String,
      "3 apps saved; checking for updates")
    XCTAssertEqual(app.buttons["marketplace-button"].frame.width, 78, accuracy: 1)
    capture("cold-relaunch-while-plugins-delayed", app)
    app.buttons["channel-visual-0"].tap()
    XCTAssertEqual(app.buttons["marketplace-button"].frame.width, 78, accuracy: 1)
    app.buttons["sidebar-toggle"].tap()
    app.buttons["chat-sidebar"].tap()
    XCTAssertEqual(app.buttons["marketplace-button"].frame.width, 78, accuracy: 1)
    await waitForValue("3 apps installed", in: app, timeout: 20)

    try await configure("/__qa/control", ["failures": ["GET /api/v0/plugins": ["status": 503, "count": 10]]])
    XCUIDevice.shared.press(.home)
    app.activate()
    await waitForValue("3 apps saved; checking for updates", in: app)
    XCTAssertEqual(app.buttons["marketplace-button"].frame.width, 78, accuracy: 1)
    capture("failed-refresh-keeps-icons", app)

    // A successful empty list does remove genuinely uninstalled apps.
    try await configure("/__qa/control", ["failures": [:], "pluginInstalls": []])
    app.buttons["marketplace-button"].tap()
    XCTAssertTrue(app.buttons["marketplace-back"].waitForExistence(timeout: 5))
    app.buttons["marketplace-back"].tap()
    await waitForValue("0 apps installed", in: app)

    let (data, _) = try await URLSession.shared.data(from: URL(string: base + "/__qa/state")!)
    let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let requests = try XCTUnwrap(state["requests"] as? [[String: Any]])
    XCTAssertFalse(requests.contains { ($0["path"] as? String)?.hasPrefix("/unbundled-plugin-artwork/") == true })
  }

  func testDifferentServerCannotDisplayPreviousServersCachedApps() async throws {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .landscapeLeft
    try await configure("/__qa/reset", [:])
    try await configure("/__qa/scene", ["scene": "dark-home"])
    let plugins = [["key": "slack", "name": "Slack"]]
    try await configure("/__qa/control", ["pluginCatalog": plugins, "pluginInstalls": plugins])
    let app = launch()
    await waitForValue("1 app installed", in: app)
    try await Task.sleep(for: .milliseconds(400))
    app.terminate()
    try await configure("/__qa/control", ["failures": ["GET /api/v0/plugins": ["delayMs": 15000]]])
    // The same loopback fixture, addressed as another server identity, must
    // begin with an unknown list instead of using the prior server's snapshot.
    let different = launch(server: base.replacingOccurrences(of: "127.0.0.1", with: "localhost"))
    XCTAssertEqual(different.buttons["marketplace-button"].value as? String, "Checking installed apps")
    XCTAssertEqual(different.buttons["marketplace-button"].frame.width, 44, accuracy: 1)
    capture("new-server-does-not-inherit-apps", different)
    different.terminate()
  }
}
