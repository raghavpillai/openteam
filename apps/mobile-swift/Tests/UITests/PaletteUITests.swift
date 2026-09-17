import XCTest

/// Real native screens, including a theme change without restarting the app.
@MainActor final class PaletteUITests: XCTestCase {
  let base = "http://127.0.0.1:20029"

  func configure(_ path: String, _ body: [String: Any]) async throws {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }

  func launch(_ appearance: String, channel: String? = nil) -> XCUIApplication {
    continueAfterFailure = false
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", appearance]
    if let channel { app.launchArguments += ["--open-channel", channel] }
    app.launch()
    XCTAssertTrue(
      app.buttons[channel == nil ? "settings-button" : "chat-back"].waitForExistence(timeout: 15))
    return app
  }

  func capture(_ name: String, _ app: XCUIApplication) {
    Thread.sleep(forTimeInterval: 0.7)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "palette-" + name
    screenshot.lifetime = .keepAlways
    add(screenshot)
    let tree = XCTAttachment(string: app.debugDescription)
    tree.name = "palette-tree-" + name
    tree.lifetime = .keepAlways
    add(tree)
  }

  func testHomeSettingsAndNativeFormsSwitchAppearanceInPlace() async throws {
    try await configure("/__qa/scene", ["scene": "home"])
    let app = launch("light")
    for appearance in ["light", "dark", "light"] {
      app.buttons["settings-button"].tap()
      XCTAssertTrue(app.buttons["appearance-picker"].waitForExistence(timeout: 5))
      app.buttons["appearance-picker"].tap()
      app.buttons[appearance.capitalized].tap()
      capture("settings-" + appearance, app)
      app.buttons["account-settings"].tap()
      XCTAssertTrue(app.textFields["account-server"].waitForExistence(timeout: 5))
      XCTAssertEqual(app.textFields["account-server"].value as? String, base)
      capture("account-" + appearance, app)
      app.navigationBars.buttons.firstMatch.tap()
      app.buttons["sheet-close"].tap()
      capture("home-" + appearance, app)
      app.buttons["new-button"].tap()
      app.buttons["New Bot"].tap()
      XCTAssertTrue(app.textFields["new-name"].waitForExistence(timeout: 5))
      capture("create-" + appearance, app)
      app.buttons["sheet-close"].tap()
    }
    app.buttons["new-button"].tap()
    XCTAssertTrue(app.buttons["New Bot"].waitForExistence(timeout: 5))
    capture("new-menu-light", app)
  }

  func testChatActionsAndComposerInBothThemes() async throws {
    for appearance in ["light", "dark"] {
      try await configure("/__qa/scene", ["scene": "dark-chat-seven"])
      let app = launch(appearance, channel: "visual-chat")
      XCTAssertTrue(app.staticTexts["Got it — here."].waitForExistence(timeout: 10))
      capture("chat-" + appearance, app)
      app.staticTexts["Got it — here."].press(forDuration: 0.8)
      XCTAssertTrue(app.buttons["Start a thread"].waitForExistence(timeout: 5))
      capture("message-actions-" + appearance, app)
      app.buttons["Reply"].tap()
      XCTAssertTrue(app.buttons["Cancel reply"].waitForExistence(timeout: 5))
      let field = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
      field.typeText("Theme check")
      XCTAssertTrue(app.buttons["send-button"].isEnabled)
      capture("reply-" + appearance, app)
      XCTAssertEqual(field.value as? String, "Theme check")
      app.terminate()
    }
  }

  func testOfflineDocumentColorsInBothThemes() async throws {
    for appearance in ["light", "dark"] {
      try await configure("/__qa/reset", [:])
      try await configure("/__qa/content", ["scene": "markdown"])
      let app = launch(appearance, channel: "channel-research")
      XCTAssertTrue(app.webViews.staticTexts["Tables"].waitForExistence(timeout: 12))
      XCTAssertTrue(app.webViews.staticTexts["Draft"].waitForExistence(timeout: 12))
      XCTAssertFalse(app.staticTexts["Unsafe script executed"].exists)
      capture("document-" + appearance, app)
      app.terminate()
    }
  }
}
