import XCTest

/// Uses the real signed-in app flow, not --ui-testing, so the system integration
/// reads the same Keychain session and per-account settings as a user install.
@MainActor
final class SystemIntegrationUITests: XCTestCase {
  private let base = "http://127.0.0.1:20085"

  private func launch() async throws -> XCUIApplication {
    continueAfterFailure = false
    var request = URLRequest(url: URL(string: base + "/__qa/reset")!)
    request.httpMethod = "POST"
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    addUIInterruptionMonitor(withDescription: "System permission") { alert in
      for title in ["Allow", "Not Now", "Continue"] where alert.buttons[title].exists {
        alert.buttons[title].tap()
        return true
      }
      return false
    }
    let app = XCUIApplication()
    app.launchArguments = ["--server", base]
    app.launch()
    if app.buttons["get-started"].waitForExistence(timeout: 5) {
      app.buttons["get-started"].tap()
      let field = app.textFields["server-field"]
      XCTAssertTrue(field.waitForExistence(timeout: 10))
      if app.buttons["clear-server"].exists { app.buttons["clear-server"].tap() }
      field.tap()
      let existing = field.value as? String ?? ""
      if existing.hasPrefix("http") { field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count)) }
      field.typeText(base)
      app.buttons["connect-button"].tap()
    }
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 25))
    return app
  }

  private func discoveryToggle(_ app: XCUIApplication) -> XCUIElement {
    app.buttons["settings-button"].tap()
    let toggle = app.switches["system-discovery-toggle"]
    XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
    // SwiftUI's List creates offscreen rows lazily; scroll before expecting the
    // switch to exist in the accessibility tree.
    for _ in 0..<6 where !toggle.exists || !toggle.isHittable { app.swipeUp() }
    XCTAssertTrue(toggle.exists)
    XCTAssertTrue(toggle.isHittable)
    return toggle
  }

  private func setDiscovery(_ toggle: XCUIElement, enabled: Bool) {
    let value = enabled ? "1" : "0"
    if toggle.value as? String != value {
      // Tap the actual trailing switch, rather than the row's text label.
      toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
    }
    let updated = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: toggle)
    XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 5), .completed)
  }

  func testDiscoverySettingPersistsAcrossColdLaunchAndChatStillWorks() async throws {
    let app = try await launch()
    var toggle = discoveryToggle(app)
    setDiscovery(toggle, enabled: true)
    capture("discovery-enabled", app)
    app.terminate()
    app.launch()
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 20))
    toggle = discoveryToggle(app)
    XCTAssertEqual(toggle.value as? String, "1")
    app.buttons["sheet-close"].tap()
    app.buttons["channel-channel-research"].tap()
    let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    XCTAssertTrue(input.waitForExistence(timeout: 15))
    input.tap()
    input.typeText("UI test with Siri context enabled")
    app.buttons["send-button"].tap()
    XCTAssertTrue(app.staticTexts["UI test with Siri context enabled"].waitForExistence(timeout: 15))
    capture("chat-with-siri-context", app)
  }

  func testDisabledDiscoveryPersistsAcrossColdLaunch() async throws {
    let app = try await launch()
    let toggle = discoveryToggle(app)
    setDiscovery(toggle, enabled: true)
    setDiscovery(toggle, enabled: false)
    capture("discovery-disabled", app)
    app.buttons["sheet-close"].tap()
    app.terminate()
    app.launch()
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 20))
    XCTAssertEqual(discoveryToggle(app).value as? String, "0")
  }

  private func capture(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
