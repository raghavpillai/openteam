import XCTest

@MainActor
final class AuthFlowUITests: XCTestCase {
  let base = "http://127.0.0.1:19992"
  func control(_ path: String = "/__qa/control", _ body: [String: Any] = [:]) async throws {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }
  func launch(required: Bool = false) async throws -> XCUIApplication {
    continueAfterFailure = false
    addUIInterruptionMonitor(withDescription: "Password autofill") { alert in
      if alert.buttons["Not Now"].exists {
        alert.buttons["Not Now"].tap()
        return true
      }
      return false
    }
    try await control("/__qa/reset")
    try await control("/__qa/control", ["authRequired": required])
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--show-login", "--server", base, "--appearance", "light",
    ]
    app.launch()
    XCTAssertTrue(app.buttons["get-started"].waitForExistence(timeout: 8))
    return app
  }
  func capture(_ name: String, _ app: XCUIApplication) {
    let a = XCTAttachment(screenshot: app.screenshot())
    a.name = "parity-" + name
    a.lifetime = .keepAlways
    add(a)
  }
  func replace(_ element: XCUIElement, _ text: String) {
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
  func credentials(_ app: XCUIApplication) {
    app.buttons["get-started"].tap()
    app.buttons["connect-button"].tap()
    XCTAssertTrue(app.textFields["username-field"].waitForExistence(timeout: 20))
  }
  func signIn(_ app: XCUIApplication, password: String = "fixture-only") {
    app.textFields["username-field"].tap()
    app.textFields["username-field"].typeText("fixture")
    app.secureTextFields["password-field"].tap()
    app.secureTextFields["password-field"].typeText(password)
    app.buttons["sign-in-button"].tap()
  }
  func dismissPasswordPrompt(_ app: XCUIApplication) {
    let prompt = app.buttons["Not Now"]
    for _ in 0..<3 {
      guard prompt.waitForExistence(timeout: 2) else { return }
      prompt.tap()
      if prompt.waitForNonExistence(timeout: 3) { return }
    }
    XCTFail("iOS password prompt did not dismiss")
  }
  func assertAccountValue(_ identifier: String, _ expected: String, _ app: XCUIApplication) {
    let row = app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 5))
    XCTAssertTrue(
      [row.label, row.value as? String ?? ""].joined(separator: " ").contains(expected),
      "Expected \(expected) in account row: \(row.debugDescription)")
  }
  func assertError(_ text: String, _ app: XCUIApplication) {
    XCTAssertTrue(
      app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", text)).firstMatch
        .waitForExistence(timeout: 20))
  }
  func testWelcomeValidationAndNoAuthenticationServer() async throws {
    let app = try await launch()
    capture("welcome", app)
    app.buttons["get-started"].tap()
    capture("server", app)
    replace(app.textFields["server-field"], "not a URL")
    app.buttons["connect-button"].tap()
    assertError("starting with", app)
    capture("server-invalid", app)
    replace(app.textFields["server-field"], "http://user:password@localhost")
    app.buttons["connect-button"].tap()
    assertError("Remove the username", app)
    replace(app.textFields["server-field"], base + "?token=no")
    app.buttons["connect-button"].tap()
    assertError("without anything after", app)
    replace(app.textFields["server-field"], base)
    app.buttons["connect-button"].tap()
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 15))
    XCTAssertFalse(app.textFields["username-field"].exists)
    capture("connected-no-auth", app)
  }
  func testCredentialsRejectedThenRetrySucceeds() async throws {
    let app = try await launch(required: true)
    credentials(app)
    XCTAssertFalse(app.buttons["sign-in-button"].isEnabled)
    capture("sign-in", app)
    signIn(app, password: "incorrect")
    assertError("Incorrect username or password", app)
    capture("sign-in-error", app)
    XCTAssertEqual(app.textFields["username-field"].value as? String, "fixture")
    replace(app.secureTextFields["password-field"], "fixture-only")
    app.buttons["sign-in-button"].tap()
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 15))
  }
  func testRateLimitServerFailureAndIncompleteSessionCanRetry() async throws {
    let app = try await launch(required: true)
    credentials(app)
    try await control("/__qa/control", ["failures": ["POST /api/auth/login": ["status": 429]]])
    signIn(app)
    assertError("Too many sign-in attempts", app)
    capture("sign-in-rate-limit", app)
    try await control("/__qa/control", ["failures": ["POST /api/auth/login": ["status": 403]]])
    app.buttons["sign-in-button"].tap()
    assertError("cannot sign in", app)
    try await control("/__qa/control", ["failures": ["POST /api/auth/login": ["status": 503]]])
    app.buttons["sign-in-button"].tap()
    assertError("try again shortly", app)
    capture("sign-in-server-error", app)
    try await control("/__qa/control", ["missingToken": true])
    app.buttons["sign-in-button"].tap()
    assertError("did not complete sign-in", app)
    try await control("/__qa/control", ["missingToken": false])
    app.buttons["sign-in-button"].tap()
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 15))
  }
  func testUnreachableIncompatibleAndCancelledServerCheck() async throws {
    let app = try await launch(required: true)
    app.buttons["get-started"].tap()
    replace(app.textFields["server-field"], "http://127.0.0.1:1")
    app.buttons["connect-button"].tap()
    assertError("Could not reach", app)
    capture("server-unreachable", app)
    replace(app.textFields["server-field"], base)
    try await control("/__qa/control", ["invalidServer": true])
    app.buttons["connect-button"].tap()
    assertError("not a compatible", app)
    capture("server-incompatible", app)
    try await control(
      "/__qa/control",
      ["invalidServer": false, "failures": ["GET /api/auth/config": ["delayMs": 3500]]])
    app.buttons["connect-button"].tap()
    XCTAssertTrue(app.buttons["Cancel connection"].waitForExistence(timeout: 3))
    app.buttons["Cancel connection"].tap()
    XCTAssertTrue(app.buttons["connect-button"].isEnabled)
    XCTAssertFalse(app.textFields["username-field"].waitForExistence(timeout: 4))
    app.buttons["connect-button"].tap()
    XCTAssertTrue(app.textFields["username-field"].waitForExistence(timeout: 10))
  }
  func testSessionExpiryPreservesDraftAndSignOutFailureRetainsAccount() async throws {
    let app = try await launch(required: true)
    credentials(app)
    signIn(app)
    XCTAssertTrue(app.buttons["channel-channel-research"].waitForExistence(timeout: 15))
    dismissPasswordPrompt(app)
    app.buttons["channel-channel-research"].tap()
    let composer = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    XCTAssertTrue(composer.waitForExistence(timeout: 8))
    composer.tap()
    composer.typeText("A draft survives reauthentication")
    try await control("/__qa/control", ["authExpired": true])
    XCTAssertTrue(app.textFields["username-field"].waitForExistence(timeout: 12))
    assertError("session expired", app)
    capture("session-expired", app)
    signIn(app)
    XCTAssertTrue(app.buttons["channel-channel-research"].waitForExistence(timeout: 15))
    dismissPasswordPrompt(app)
    app.buttons["channel-channel-research"].tap()
    XCTAssertTrue(composer.waitForExistence(timeout: 8))
    XCTAssertEqual(composer.value as? String, "A draft survives reauthentication")
    app.buttons["chat-back"].tap()
    app.buttons["settings-button"].tap()
    app.swipeUp()
    try await control("/__qa/control", ["failures": ["POST /api/auth/sign-out": ["status": 503]]])
    app.buttons["sign-out"].tap()
    try XCTUnwrap(
      app.buttons.matching(identifier: "Sign out").allElementsBoundByIndex.first(where: {
        $0.isHittable
      })
    ).tap()
    assertError("try again shortly", app)
    if app.alerts.buttons["OK"].exists { app.alerts.buttons["OK"].tap() }
    XCTAssertTrue(app.buttons["sign-out"].exists)
    app.buttons["sign-out"].tap()
    try XCTUnwrap(
      app.buttons.matching(identifier: "Sign out").allElementsBoundByIndex.first(where: {
        $0.isHittable
      })
    ).tap()
    XCTAssertTrue(app.buttons["get-started"].waitForExistence(timeout: 12))
  }
  func testAccountReauthenticationOfflineCancelRetryAndServerIsolation() async throws {
    let app = try await launch(required: true)
    credentials(app)
    signIn(app)
    XCTAssertTrue(app.buttons["channel-channel-research"].waitForExistence(timeout: 15))
    dismissPasswordPrompt(app)
    app.buttons["channel-channel-research"].tap()
    let composer = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    XCTAssertTrue(composer.waitForExistence(timeout: 8))
    composer.tap()
    composer.typeText("Keep my account draft")
    app.buttons["chat-back"].tap()
    app.buttons["settings-button"].tap()
    app.buttons["account-settings"].tap()
    assertAccountValue("account-name", "Fixture owner", app)
    XCTAssertFalse(app.staticTexts["Sign-in"].exists)
    XCTAssertFalse(app.buttons["change-server"].exists)
    XCTAssertFalse(app.textFields["account-server"].exists)
    capture("account-light", app)
    try await control("/__qa/control", ["offline": true])
    let status = app.descendants(matching: .any)
      .matching(identifier: "account-connection-status").firstMatch
    let offline = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "value == %@", "Offline"), object: status)
    XCTAssertEqual(XCTWaiter.wait(for: [offline], timeout: 15), .completed)
    assertAccountValue("account-name", "Fixture owner", app)
    capture("account-offline", app)
    app.buttons["re-auth"].tap()
    XCTAssertTrue(app.textFields["server-field"].waitForExistence(timeout: 5))
    app.buttons["connect-button"].tap()
    assertError("try again shortly", app)
    app.buttons["cancel-re-auth"].tap()
    XCTAssertTrue(app.buttons["re-auth"].waitForExistence(timeout: 5))
    assertAccountValue("account-name", "Fixture owner", app)
    try await control("/__qa/control", ["offline": false])
    app.buttons["re-auth"].tap()
    app.buttons["connect-button"].tap()
    XCTAssertTrue(app.textFields["username-field"].waitForExistence(timeout: 10))
    signIn(app, password: "incorrect")
    assertError("Incorrect username or password", app)
    replace(app.secureTextFields["password-field"], "fixture-only")
    app.buttons["sign-in-button"].tap()
    dismissPasswordPrompt(app)
    XCTAssertTrue(app.buttons["re-auth"].waitForExistence(timeout: 12))
    app.navigationBars.buttons.firstMatch.tap()
    app.buttons["Close"].firstMatch.tap()
    app.buttons["channel-channel-research"].tap()
    XCTAssertEqual(composer.value as? String, "Keep my account draft")
    app.buttons["chat-back"].tap()
    app.buttons["settings-button"].tap()
    app.buttons["account-settings"].tap()
    app.buttons["re-auth"].tap()
    replace(app.textFields["server-field"], "http://localhost:19992")
    app.buttons["connect-button"].tap()
    XCTAssertTrue(app.textFields["username-field"].waitForExistence(timeout: 10))
    signIn(app)
    dismissPasswordPrompt(app)
    XCTAssertTrue(app.buttons["re-auth"].waitForExistence(timeout: 12))
    assertAccountValue("account-server", "http://localhost:19992", app)
    capture("account-changed-server", app)
    app.navigationBars.buttons.firstMatch.tap()
    app.buttons["Close"].firstMatch.tap()
    app.buttons["channel-channel-research"].tap()
    XCTAssertNotEqual(composer.value as? String, "Keep my account draft")
  }
  func testDarkAccountReauthenticationWithoutCredentials() async throws {
    try await control("/__qa/reset")
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "dark"]
    app.launch()
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 15))
    app.buttons["settings-button"].tap()
    app.buttons["account-settings"].tap()
    assertAccountValue("account-name", "Local owner", app)
    capture("account-dark", app)
    app.buttons["re-auth"].tap()
    XCTAssertTrue(app.textFields["server-field"].waitForExistence(timeout: 5))
    capture("re-auth-dark", app)
    app.buttons["connect-button"].tap()
    XCTAssertTrue(app.buttons["re-auth"].waitForExistence(timeout: 12))
    assertAccountValue("account-name", "Local owner", app)
    XCTAssertFalse(app.textFields["username-field"].exists)
  }
  func testDarkLargeTextWelcomeAndSignInRemainReachable() async throws {
    try await control("/__qa/reset")
    try await control("/__qa/control", ["authRequired": true])
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--show-login", "--server", base, "--appearance", "dark",
      "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
    ]
    app.launch()
    for _ in 0..<6 {
      if app.buttons["get-started"].isHittable { break }
      app.swipeUp()
    }
    XCTAssertTrue(app.buttons["get-started"].isHittable)
    capture("welcome-dark-large-text", app)
    app.buttons["get-started"].tap()
    for _ in 0..<6 {
      if app.buttons["connect-button"].isHittable { break }
      app.swipeUp()
    }
    app.buttons["connect-button"].tap()
    XCTAssertTrue(app.textFields["username-field"].waitForExistence(timeout: 15))
    capture("signin-dark-large-text", app)
  }

}
