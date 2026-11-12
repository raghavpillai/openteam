import XCTest

@MainActor final class AttachmentUITests: XCTestCase {
  let base = "http://127.0.0.1:19992"
  func control(_ path: String, _ body: [String: Any] = [:]) async throws {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }
  private func waitForArrival(_ element: XCUIElement) {
    let ready = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "hittable == true"), object: element)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed)
    // Navigation reports destination frames before the push finishes.
    Thread.sleep(forTimeInterval: 0.5)
  }
  func testPrivateImageRequiresAuthenticationAndOpensNativePreview() async throws {
    continueAfterFailure = false
    addUIInterruptionMonitor(withDescription: "Password autofill") { alert in
      guard alert.buttons["Not Now"].exists else { return false }
      alert.buttons["Not Now"].tap()
      return true
    }
    try await control("/__qa/reset")
    try await control("/__qa/content", ["scene": "attachment"])
    try await control("/__qa/control", ["authRequired": true])
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
    let prompt = app.buttons["Not Now"]
    for _ in 0..<3 {
      guard prompt.waitForExistence(timeout: 2) else { break }
      prompt.tap()
      if prompt.waitForNonExistence(timeout: 3) { break }
    }
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
    let (data, _) = try await URLSession.shared.data(from: URL(string: base + "/__qa/state")!)
    let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertTrue(
      (state["contentReceipts"] as? [[String: Any]] ?? []).contains {
        $0["authenticated"] as? Bool == true
      })
    app.buttons["Open Fixture image.png"].tap()
    XCTAssertTrue(app.buttons["photo-close"].waitForExistence(timeout: 12))
    app.buttons["photo-close"].tap()
  }
}
