import XCTest

@MainActor
final class AuthFlowUITests: XCTestCase {
  let base = "http://127.0.0.1:19992"
  var fixture: QAFixture { QAFixture(base: base) }
  func replace(_ element: XCUIElement, _ text: String) {
    waitForArrival(element)
    let app = XCUIApplication()
    if element.identifier == "server-field", app.buttons["clear-server"].exists {
      app.buttons["clear-server"].tap()
      element.typeText(text)
      return
    }
    element.tap()
    let value = element.value as? String ?? ""
    element.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count) + text)
  }
  func signIn(_ app: XCUIApplication, password: String = "fixture-only") {
    // Outside --ui-testing the app prefills the last username for this server.
    let username = app.textFields["username-field"]
    replace(username, "fixture")
    // Use the native Next/Go actions so the Passwords bar cannot intercept a
    // coordinate tap on an adjacent field during reauthentication.
    username.typeText("\n")
    let passwordField = app.secureTextFields["password-field"]
    let focused = XCTNSPredicateExpectation(predicate: NSPredicate { element, _ in
      (element as? XCUIElement)?.value(forKey: "hasKeyboardFocus") as? Bool == true
    }, object: passwordField)
    XCTAssertEqual(XCTWaiter.wait(for: [focused], timeout: 10), .completed)
    passwordField.typeText(password + "\n")
  }

  func testSavedSessionDoesNotReturnAfterReauthenticationAndRelaunch() async throws {
    continueAfterFailure = false
    try await fixture.post("/__qa/reset")
    try await fixture.post("/__qa/control", ["authRequired": true])
    // Exercise the real Keychain and app sandbox, rather than the --ui-testing cache.
    let app = XCUIApplication()
    app.launch()
    if app.buttons["settings-button"].waitForExistence(timeout: 20) {
      app.buttons["settings-button"].tap()
      app.buttons["account-settings"].tap()
      app.buttons["re-auth"].tap()
    } else if app.buttons["get-started"].exists {
      app.buttons["get-started"].tap()
      waitForArrival(app.textFields["server-field"])
    }
    XCTAssertTrue(app.textFields["server-field"].waitForExistence(timeout: 10))
    replace(app.textFields["server-field"], base)
    app.buttons["connect-button"].tap()
    XCTAssertTrue(app.textFields["username-field"].waitForExistence(timeout: 10))
    signIn(app)
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 15))
    dismissPasswordPrompt(app)
    app.terminate()
    app.launch()
    // Confirm that a real persisted session exists before clearing it.
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 20))
    app.buttons["settings-button"].tap()
    app.buttons["account-settings"].tap()
    app.buttons["re-auth"].tap()
    XCTAssertTrue(app.textFields["server-field"].waitForExistence(timeout: 5))
    app.terminate()
    app.launch()
    XCTAssertTrue(app.buttons["get-started"].waitForExistence(timeout: 15))
    XCTAssertFalse(app.buttons["settings-button"].exists)
    app.buttons["get-started"].tap()
    waitForArrival(app.textFields["server-field"])
    XCTAssertFalse(app.buttons["clear-server"].exists)
    // Reconnect after the real sandbox/Keychain reset, then repeat without a
    // relaunch. Neither path may silently leave Connect blocked by the marker.
    for attempt in 0..<2 {
      replace(app.textFields["server-field"], base)
      app.buttons["connect-button"].tap()
      waitForArrival(app.textFields["username-field"])
      signIn(app)
      XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 15))
      dismissPasswordPrompt(app)
      app.buttons["settings-button"].tap()
      app.buttons["account-settings"].tap()
      app.buttons["re-auth"].tap()
      waitForArrival(app.textFields["server-field"])
      XCTAssertFalse(app.buttons["clear-server"].exists)
    }
  }

  func testPrivateImageRequiresAuthenticationAndOpensNativePreview() async throws {
    continueAfterFailure = false
    addUIInterruptionMonitor(withDescription: "Password autofill") { alert in
      guard alert.buttons["Not Now"].exists else { return false }
      alert.buttons["Not Now"].tap()
      return true
    }
    try await fixture.post("/__qa/scene", ["scene": "attachment"])
    try await fixture.post("/__qa/control", ["authRequired": true])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "light", "--show-login"]
    app.launch()
    waitForArrival(app.buttons["get-started"])
    app.buttons["get-started"].tap()
    waitForArrival(app.buttons["connect-button"])
    app.buttons["connect-button"].tap()
    XCTAssertTrue(app.textFields["username-field"].waitForExistence(timeout: 12))
    waitForArrival(app.textFields["username-field"])
    app.textFields["username-field"].tap()
    app.textFields["username-field"].typeText("fixture\n")
    app.secureTextFields["password-field"].typeText("fixture-only\n")
    let row = app.buttons["channel-channel-research"]
    XCTAssertTrue(row.waitForExistence(timeout: 15))
    dismissPasswordPrompt(app)
    // The list can still be settling when its rows first exist (iPhone Duo):
    // wait until the row is tappable, then retry until the conversation opens.
    let opened = app.buttons.matching(
      NSPredicate(format: "identifier == 'conversation-details' AND label == 'Research'")).firstMatch
    waitForArrival(row)
    for _ in 0..<3 {
      if row.isHittable { row.tap() }
      if opened.waitForExistence(timeout: 5) { break }
    }
    XCTAssertTrue(opened.exists, "The Research conversation did not open")
    XCTAssertTrue(app.buttons["Open Fixture image.png"].waitForExistence(timeout: 12))
    let state = try await fixture.state()
    XCTAssertTrue(
      (state["contentReceipts"] as? [[String: Any]] ?? []).contains {
        $0["authenticated"] as? Bool == true
      })
    app.buttons["Open Fixture image.png"].tap()
    XCTAssertTrue(app.buttons["photo-close"].waitForExistence(timeout: 12))
    app.buttons["photo-close"].tap()
  }
}
