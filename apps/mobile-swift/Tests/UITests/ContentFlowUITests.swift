import XCTest

@MainActor final class ContentFlowUITests: XCTestCase {
  let base = "http://127.0.0.1:19992"
  func control(_ path: String = "/__qa/control", _ body: [String: Any] = [:]) async throws {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }
  func state() async throws -> [String: Any] {
    let (data, _) = try await URLSession.shared.data(from: URL(string: base + "/__qa/state")!)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
  func launch(_ scene: String, required: Bool = false, dark: Bool = false) async throws
    -> XCUIApplication
  {
    continueAfterFailure = false
    addUIInterruptionMonitor(withDescription: "Password autofill") { alert in
      guard alert.buttons["Not Now"].exists else { return false }
      alert.buttons["Not Now"].tap()
      return true
    }
    try await control("/__qa/reset")
    try await control("/__qa/content", ["scene": scene])
    try await control("/__qa/control", ["authRequired": required])
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--server", base, "--appearance", dark ? "dark" : "light",
    ]
    if required { app.launchArguments.append("--show-login") }
    app.launch()
    if required {
      app.buttons["get-started"].tap()
      app.buttons["connect-button"].tap()
      XCTAssertTrue(app.textFields["username-field"].waitForExistence(timeout: 12))
      app.textFields["username-field"].tap()
      app.textFields["username-field"].typeText("fixture")
      app.secureTextFields["password-field"].tap()
      app.secureTextFields["password-field"].typeText("fixture-only")
      app.buttons["sign-in-button"].tap()
    }
    XCTAssertTrue(app.buttons["channel-channel-research"].waitForExistence(timeout: 15))
    if required {
      let prompt = app.buttons["Not Now"]
      for _ in 0..<3 {
        guard prompt.waitForExistence(timeout: 2) else { break }
        prompt.tap()
        if prompt.waitForNonExistence(timeout: 3) { break }
      }
      XCTAssertFalse(prompt.exists, "iOS password prompt did not dismiss")
    }
    app.buttons["channel-channel-research"].tap()
    return app
  }
  func capture(_ name: String, _ app: XCUIApplication) {
    let a = XCTAttachment(screenshot: app.screenshot())
    a.name = "parity-" + name
    a.lifetime = .keepAlways
    add(a)
  }
  func testOfflineRichMarkdownTablesMathAndDiagram() async throws {
    let app = try await launch("markdown")
    XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 12))
    XCTAssertTrue(app.webViews.staticTexts["Tables"].waitForExistence(timeout: 12))
    XCTAssertTrue(app.webViews.staticTexts["Draft"].waitForExistence(timeout: 12))
    XCTAssertFalse(app.staticTexts["Unsafe script executed"].exists)
    capture("rich-markdown-light", app)
  }
  func testCompletedWidgetKeepsLabeledCheckedRowsInBothThemes() async throws {
    for dark in [true, false] {
      let app = try await launch("widget-completed", dark: dark)
      defer { app.terminate() }
      XCTAssertTrue(app.staticTexts["Choose a route"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-loading")
        .firstMatch.waitForNonExistence(timeout: 15))
      var previous: CGRect?
      for (index, label) in ["Alpha", "Beta", "Gamma"].enumerated() {
        let row = app.descendants(matching: .any)
          .matching(identifier: "widget-answer-content-fixture-\(index)").firstMatch
        XCTAssertTrue(row.exists)
        XCTAssertEqual(row.label, label)
        XCTAssertEqual(row.value as? String, "Selected")
        // AX may expose the text bounds rather than the padded row. Measure
        // the distance between rows, which also catches a collapsed option list.
        if let previous { XCTAssertGreaterThanOrEqual(row.frame.midY - previous.midY, 40) }
        previous = row.frame
      }
      XCTAssertFalse(app.buttons["Submit"].exists)
      XCTAssertFalse(app.buttons["Dismiss"].exists)
      capture("widget-completed-" + (dark ? "dark" : "light"), app)
    }
  }
  func testPlainMessageLineBoxTracksAccessibilityTextSize() async throws {
    var heights: [CGFloat] = []
    for category in ["UICTContentSizeCategoryL", "UICTContentSizeCategoryAccessibilityXXXL"] {
      try await control("/__qa/reset")
      try await control("/__qa/content", ["scene": "type-size"])
      let app = XCUIApplication()
      app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "dark",
        "--open-channel", "channel-research", "-UIPreferredContentSizeCategoryName", category]
      app.launch()
      defer { app.terminate() }
      let text = app.staticTexts["Hello"]
      XCTAssertTrue(text.waitForExistence(timeout: 15))
      XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-loading")
        .firstMatch.waitForNonExistence(timeout: 15))
      let row = app.otherElements["message-content-fixture"]
      XCTAssertTrue(row.exists)
      XCTAssertTrue(text.isHittable)
      XCTAssertGreaterThanOrEqual(row.frame.height, text.frame.height)
      heights.append(row.frame.height)
      capture("message-type-size-" + category, app)
    }
    XCTAssertEqual(heights[0], 40, accuracy: 0.5)
    XCTAssertGreaterThan(heights[1], heights[0] * 1.8)
    XCTAssertLessThan(heights[1], heights[0] * 3, "A single line must not gain a second empty line box")
  }
  func testUserFormPrefillValidationFailureAndAcceptedReceipt() async throws {
    let app = try await launch("form", dark: true)
    let name = app.descendants(matching: .any).matching(identifier: "form-field-name").firstMatch
    let email = app.descendants(matching: .any).matching(identifier: "form-field-email").firstMatch
    XCTAssertTrue(name.waitForExistence(timeout: 12))
    XCTAssertFalse(app.buttons["Submit"].isEnabled)
    XCTAssertEqual(email.value as? String, "fixture@example.invalid")
    name.tap()
    name.typeText("Ada Native")
    // SwiftUI exposes a labeled accessibility row around the native switch.
    // Tap the switch itself; the text label is not an interactive toggle.
    let confirmation = app.switches["Confirm these details"]
    (confirmation.switches.firstMatch.exists ? confirmation.switches.firstMatch : confirmation).tap()
    XCTAssertEqual(app.switches["Confirm these details"].value as? String, "1")
    let saveInfo = app.switches["Save nonsecret info for future forms"]
    (saveInfo.switches.firstMatch.exists ? saveInfo.switches.firstMatch : saveInfo).tap()
    XCTAssertEqual(app.switches["Save nonsecret info for future forms"].value as? String, "1")
    try await control(
      "/__qa/control",
      ["failures": ["POST /api/v0/channel-messages/content-fixture/user-form": ["status": 503]]])
    app.buttons["Submit"].tap()
    XCTAssertTrue(
      app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "try again shortly"))
        .firstMatch.waitForExistence(timeout: 12))
    XCTAssertEqual(name.value as? String, "Ada Native")
    capture("user-form-error-dark", app)
    app.buttons["Submit"].tap()
    XCTAssertTrue(app.staticTexts["Filled into the page. Secret values were never shown to your Bot."].waitForExistence(timeout: 12))
    capture("user-form-completed-dark", app)
    let data = try await state()
    let receipt = try XCTUnwrap((data["contentReceipts"] as? [[String: Any]])?.first)
    XCTAssertEqual((receipt["values"] as? [String: Any])?["name"] as? String, "Ada Native")
    XCTAssertEqual(receipt["saveToVault"] as? Bool, true)
    app.staticTexts["Filled into the page. Secret values were never shown to your Bot."].press(forDuration: 0.8)
    XCTAssertTrue(app.buttons["Reply"].waitForExistence(timeout: 5))
    capture("form-native-message-menu", app)
  }
  func testPrivateImageRequiresAuthenticationAndOpensNativePreview() async throws {
    let app = try await launch("attachment", required: true)
    XCTAssertTrue(app.buttons["Open Fixture image.png"].waitForExistence(timeout: 12))
    capture("private-attachment", app)
    let data = try await state()
    XCTAssertTrue(
      (data["contentReceipts"] as? [[String: Any]] ?? []).contains {
        $0["authenticated"] as? Bool == true
      })
    app.buttons["Open Fixture image.png"].tap()
    XCTAssertTrue(app.buttons["photo-close"].waitForExistence(timeout: 12))
    capture("native-file-preview", app)
    app.buttons["photo-close"].tap()
  }
  func testComputerHandoffDragTypeFailureAndReturnControl() async throws {
    let app = try await launch("handoff")
    XCTAssertTrue(app.buttons["Take over"].waitForExistence(timeout: 12))
    app.buttons["Take over"].tap()
    XCTAssertTrue(app.buttons["Computer options"].waitForExistence(timeout: 12))
    app.buttons["Computer options"].tap()
    XCTAssertTrue(app.buttons["Give back control"].waitForExistence(timeout: 5))
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.45)).tap()
    let screen = app.images["computer-screen"]
    XCTAssertTrue(screen.waitForExistence(timeout: 12))
    capture("computer-takeover", app)
    screen.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.4)).press(
      forDuration: 0.1,
      thenDragTo: screen.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.55)))
    app.buttons["Clipboard"].tap()
    let field = app.descendants(matching: .any).matching(identifier: "computer-text").firstMatch
    field.tap()
    field.typeText("Native computer input")
    try await control(
      "/__qa/control",
      ["failures": ["POST /api/v0/bots/bot-research/screen/actions": ["status": 503]]])
    app.buttons["Type"].tap()
    XCTAssertTrue(
      app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "try again shortly"))
        .firstMatch.waitForExistence(timeout: 12))
    XCTAssertEqual(field.value as? String, "Native computer input")
    app.buttons["Type"].tap()
    XCTAssertTrue(app.buttons["Computer options"].waitForExistence(timeout: 10))
    app.buttons["Done"].tap()
    let closed = expectation(
      for: NSPredicate(format: "isHittable == true"),
      evaluatedWith: app.buttons["conversation-details"])
    await fulfillment(of: [closed], timeout: 12)
    let data = try await state()
    let receipts = data["contentReceipts"] as? [[String: Any]] ?? []
    XCTAssertTrue(receipts.contains { $0["action"] as? String == "drag" })
    XCTAssertTrue(receipts.contains { $0["action"] as? String == "type" })
    XCTAssertTrue(receipts.contains { $0["action"] as? String == "complete" })
    XCTAssertEqual((data["screen"] as? [String: Any])?["humanTakeover"] as? Bool, false)
  }
}
