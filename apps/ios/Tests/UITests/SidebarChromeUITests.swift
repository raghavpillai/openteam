import XCTest

/// Isolated fixture coverage for the persistent footer and the Duo's control rail.
@MainActor final class SidebarChromeUITests: XCTestCase {
  private let base = ProcessInfo.processInfo.environment["SIDEBAR_CHROME_SERVER"] ?? "http://127.0.0.1:19997"

  private func configure(_ path: String, _ body: [String: Any]) async throws {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }

  func testDuoFirstRowClearanceAndSelection() async throws {
    continueAfterFailure = false
    try await configure("/__qa/reset", [:])
    try await configure("/__qa/scene", ["scene": "duo-sidebar"])
    let plugins: [[String: Any]] = ["slack", "google-calendar", "notion"].map { key in
      ["key": key, "pluginKey": key, "name": key, "installed": true,
       "status": "installed", "connections": []]
    }
    try await configure("/__qa/control", ["pluginCatalog": plugins, "pluginInstalls": plugins])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "dark",
      "--open-channel", "duo-0", "--qa-session", UUID().uuidString]
    app.launch()
    let first = app.buttons["channel-duo-0"]
    XCTAssertTrue(first.waitForExistence(timeout: 20))
    XCTAssertTrue(app.staticTexts["sidebar-account-name"].waitForExistence(timeout: 10))
    let list = app.scrollViews.firstMatch
    XCTAssertEqual(list.frame.width, 280, accuracy: 1)
    let originalFrame = first.frame
    XCTAssertTrue(first.isSelected)
    capture("duo-first-row-clearance", app)
    for index in [2, 4, 1, 0] {
      let row = app.buttons["channel-duo-\(index)"]
      row.tap()
      let selected = expectation(for: NSPredicate(format: "selected == true"), evaluatedWith: row)
      await fulfillment(of: [selected], timeout: 5)
      XCTAssertEqual(first.frame.minY, originalFrame.minY, accuracy: 0.5,
        "Selection must not move or scroll the roster")
      XCTAssertEqual(first.frame.height, 86, accuracy: 0.5)
      capture("duo-selected-\(index)", app)
    }
    XCTAssertGreaterThanOrEqual(first.frame.minY - list.frame.minY, 16,
      "The first row must clear the inner display's rounded top corner")
    capture("duo-selection-returned-to-first", app)
    let apps = app.buttons["marketplace-button"]
    let loaded = expectation(for: NSPredicate(format: "value == %@", "3 apps installed"), evaluatedWith: apps)
    await fulfillment(of: [loaded], timeout: 10)
    XCTAssertEqual(apps.frame.width, 78, accuracy: 1)
    apps.tap()
    XCTAssertTrue(app.buttons["installed-plugins"].waitForExistence(timeout: 10))
    app.buttons["marketplace-back"].tap()
    XCTAssertTrue(first.waitForExistence(timeout: 5))
    list.swipeUp()
    XCTAssertTrue(app.buttons["settings-button"].isHittable)
    XCTAssertTrue(apps.isHittable)
    capture("duo-scrolled-footer", app)
  }

  func testFooterAndCompleteCircularControls() async throws {
    continueAfterFailure = false
    try await configure("/__qa/reset", [:])
    try await configure("/__qa/scene", ["scene": "dark-home"])
    let plugins: [[String: Any]] = ["gmail", "google-drive", "slack"].map { key in
      ["key": key, "pluginKey": key, "name": key, "installed": true,
       "status": "installed", "connections": [],
       "logoUrl": base + "/unbundled-plugin-artwork/" + key + ".png"]
    }
    try await configure("/__qa/control", ["pluginCatalog": plugins, "pluginInstalls": plugins])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base,
      "--appearance", "dark", "--open-channel", "visual-0", "--qa-session", UUID().uuidString]
    app.launch()
    let account = app.buttons["settings-button"]
    let apps = app.buttons["marketplace-button"]
    XCTAssertTrue(account.waitForExistence(timeout: 20))
    XCTAssertTrue(apps.waitForExistence(timeout: 10))
    let loaded = expectation(for: NSPredicate(format: "value == %@", "3 apps installed"), evaluatedWith: apps)
    await fulfillment(of: [loaded], timeout: 10)
    XCTAssertTrue(app.staticTexts["sidebar-account-name"].exists)
    XCTAssertEqual(account.frame.minX, 20, accuracy: 1)
    XCTAssertEqual(apps.frame.maxX, 267, accuracy: 1)
    XCTAssertEqual(apps.frame.width, 78, accuracy: 1)
    XCTAssertEqual(account.frame.midY, apps.frame.midY, accuracy: 1)
    // Duo's application accessibility root can retain its portrait size while
    // the inner display and the control coordinates have rotated to landscape.
    let rotatedRoot = app.buttons["sidebar-toggle"].frame.maxX > app.frame.maxX
    let bounds = rotatedRoot
      ? CGRect(x: 0, y: 0, width: app.frame.height, height: app.frame.width) : app.frame
    XCTAssertEqual(bounds.maxY - account.frame.midY, 40, accuracy: 1)
    XCTAssertEqual(account.frame.midY - app.buttons["inbox-unread"].frame.midY, 76, accuracy: 1)
    for identifier in ["sidebar-toggle", "new-button", "search-button", "Computer"] {
      let button = app.buttons[identifier]
      XCTAssertTrue(button.waitForExistence(timeout: 10), identifier)
      XCTAssertTrue(button.isHittable, identifier)
      XCTAssertEqual(button.frame.width, 44, accuracy: 1, identifier)
      XCTAssertEqual(button.frame.height, 44, accuracy: 1, identifier)
      XCTAssertGreaterThanOrEqual(button.frame.minX, bounds.minX, identifier)
      XCTAssertLessThanOrEqual(button.frame.maxX, bounds.maxX, identifier)
      XCTAssertGreaterThanOrEqual(button.frame.minY, bounds.minY, identifier)
      XCTAssertLessThanOrEqual(button.frame.maxY, bounds.maxY, identifier)
    }
    capture("footer-and-circular-controls", app)
    account.tap()
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "account-settings").firstMatch.waitForExistence(timeout: 5))
    app.buttons["sheet-close"].tap()
    apps.tap()
    XCTAssertTrue(app.buttons["installed-plugins"].waitForExistence(timeout: 10))
    capture("apps-open", app)
    app.buttons["marketplace-back"].tap()
    XCTAssertTrue(account.waitForExistence(timeout: 5))
    // Both the footer and marketplace must use packaged standard artwork even
    // when the server supplies an image URL that is unavailable.
    let (data, _) = try await URLSession.shared.data(from: URL(string: base + "/__qa/state")!)
    let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let requests = try XCTUnwrap(state["requests"] as? [[String: Any]])
    XCTAssertFalse(requests.contains { ($0["path"] as? String)?.hasPrefix("/unbundled-plugin-artwork/") == true })
  }

  private func capture(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
