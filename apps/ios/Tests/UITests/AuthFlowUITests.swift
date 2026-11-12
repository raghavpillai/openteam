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
    // Capture settled cards rather than a frame inside the original AuthGate slide.
    Thread.sleep(forTimeInterval: 0.5)
    let a = XCTAttachment(screenshot: app.screenshot())
    a.name = "parity-" + name
    a.lifetime = .keepAlways
    add(a)
  }
  func waitForArrival(_ element: XCUIElement) {
    let ready = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "hittable == true"), object: element)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed)
    // SwiftUI reports destination frames before its slide finishes. Do not tap coordinates
    // from the end of the transition while the control is still moving toward them.
    Thread.sleep(forTimeInterval: 0.5)
  }
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
  func credentials(_ app: XCUIApplication) {
    app.buttons["get-started"].tap()
    waitForArrival(app.textFields["server-field"])
    app.buttons["connect-button"].tap()
    XCTAssertTrue(app.textFields["username-field"].waitForExistence(timeout: 20))
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
  func dismissPasswordPrompt(_ app: XCUIApplication) {
    let prompt = app.buttons["Not Now"]
    for _ in 0..<3 {
      guard prompt.waitForExistence(timeout: 2) else { return }
      prompt.tap()
      if prompt.waitForNonExistence(timeout: 3) { return }
    }
    XCTFail("iOS password prompt did not dismiss")
  }
  func assertError(_ text: String, _ app: XCUIApplication) {
    XCTAssertTrue(
      app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", text)).firstMatch
        .waitForExistence(timeout: 20))
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

  func testSavedSessionDoesNotReturnAfterReauthenticationAndRelaunch() async throws {
    continueAfterFailure = false
    try await control("/__qa/reset")
    try await control("/__qa/control", ["authRequired": true])
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
    capture("re-auth-cold-launch-cleared", app)
    // Reconnect after the real sandbox/Keychain reset, then repeat without a
    // relaunch. Neither path may silently leave Connect blocked by the marker.
    for attempt in 0..<2 {
      replace(app.textFields["server-field"], base)
      app.buttons["connect-button"].tap()
      waitForArrival(app.textFields["username-field"])
      signIn(app)
      XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 15))
      dismissPasswordPrompt(app)
      capture("re-auth-reconnected-\(attempt)", app)
      app.buttons["settings-button"].tap()
      app.buttons["account-settings"].tap()
      app.buttons["re-auth"].tap()
      waitForArrival(app.textFields["server-field"])
      XCTAssertFalse(app.buttons["clear-server"].exists)
    }
  }
}
