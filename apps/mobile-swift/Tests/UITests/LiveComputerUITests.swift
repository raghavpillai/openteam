import XCTest

/// Optional: requires the disposable Linux desktop bridge and port 20004 proxy fixture.
@MainActor final class LiveComputerUITests: XCTestCase {
  let base = "http://127.0.0.1:20004"
  let computer = "http://127.0.0.1:20003"
  func post(_ url: String, _ body: [String: Any] = [:]) async throws {
    var request = URLRequest(url: URL(string: url)!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }
  func state() async throws -> [String: Any] {
    let (data, _) = try await URLSession.shared.data(from: URL(string: computer + "/__qa/state")!)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
  func capture(_ name: String, _ app: XCUIApplication) {
    let item = XCTAttachment(screenshot: app.screenshot())
    item.name = "live-computer-" + name
    item.lifetime = .keepAlways
    add(item)
  }
  func testRealDesktopTypingPointerAndConnectionRecovery() async throws {
    continueAfterFailure = false
    try await post(base + "/__qa/reset")
    try await post(computer + "/__qa/reset")
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "light"]
    app.launch()
    XCTAssertTrue(app.buttons["channel-channel-research"].waitForExistence(timeout: 15))
    app.buttons["channel-channel-research"].tap()
    app.buttons["Computer"].tap()
    XCTAssertTrue(app.images["computer-screen"].waitForExistence(timeout: 20))
    app.buttons["Computer options"].tap()
    app.buttons["Take control"].tap()
    app.buttons["Clipboard"].tap()
    let field = app.descendants(matching: .any).matching(identifier: "computer-text").firstMatch
    field.tap()
    field.typeText("Swift native desktop input")
    app.buttons["Type"].tap()
    for _ in 0..<30 {
      if try await state()["text"] as? String == "Swift native desktop input" { break }
      try await Task.sleep(for: .milliseconds(200))
    }
    let typed = try await state()
    XCTAssertEqual(typed["text"] as? String, "Swift native desktop input")
    app.buttons["Show computer keyboard"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    app.typeText(" plus keyboard")
    app.typeText(XCUIKeyboardKey.delete.rawValue + "d")
    for _ in 0..<40 {
      if try await state()["text"] as? String == "Swift native desktop input plus keyboard" {
        break
      }
      try await Task.sleep(for: .milliseconds(200))
    }
    let direct = try await state()
    XCTAssertEqual(direct["text"] as? String, "Swift native desktop input plus keyboard")
    capture("real-typing", app)
    app.buttons["Hide computer keyboard"].tap()
    app.buttons["Done"].tap()
    XCTAssertTrue(app.buttons["Computer"].waitForExistence(timeout: 10))
    app.buttons["Computer"].tap()
    XCTAssertTrue(app.buttons["Computer options"].waitForExistence(timeout: 10))
    app.buttons["Computer options"].tap()
    app.buttons["Take control"].tap()
    let screen = app.images["computer-screen"]
    XCTAssertTrue(screen.waitForExistence(timeout: 10))
    let target = screen.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
    target.tap()
    target.doubleTap()
    target.press(forDuration: 0.8)
    for _ in 0..<40 {
      let receipt = try await state()
      if (receipt["clicks"] as? Int ?? 0) >= 3 && receipt["rightClicks"] as? Int == 1 { break }
      try await Task.sleep(for: .milliseconds(200))
    }
    let pointer = try await state()
    XCTAssertGreaterThanOrEqual(pointer["clicks"] as? Int ?? 0, 3)
    XCTAssertEqual(pointer["rightClicks"] as? Int, 1)
    let dragStart = screen.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.7))
    dragStart.press(
      forDuration: 0.05, thenDragTo: dragStart.withOffset(CGVector(dx: 80, dy: -20)),
      withVelocity: .slow, thenHoldForDuration: 0.2)
    for _ in 0..<30 {
      if (try await state()["moves"] as? Int ?? 0) > 0 { break }
      try await Task.sleep(for: .milliseconds(200))
    }
    let dragged = try await state()
    XCTAssertGreaterThan(dragged["moves"] as? Int ?? 0, 0)
    app.buttons["Show computer keyboard"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    app.typeText("\n")
    for _ in 0..<30 {
      if (try await state()["keys"] as? [String] ?? []).contains("Enter") { break }
      try await Task.sleep(for: .milliseconds(200))
    }
    let keyed = try await state()
    XCTAssertTrue((keyed["keys"] as? [String] ?? []).contains("Enter"))
    app.buttons["Hide computer keyboard"].tap()
    app.buttons["Computer options"].tap()
    app.buttons["Input controls"].tap()
    app.buttons["Trackpad"].tap()
    app.buttons["Close input controls"].tap()
    let beforeTrackpad = try await state()
    target.tap()
    for _ in 0..<30 {
      if (try await state()["clicks"] as? Int ?? 0) > (beforeTrackpad["clicks"] as? Int ?? 0) {
        break
      }
      try await Task.sleep(for: .milliseconds(200))
    }
    let trackpadClick = try await state()
    XCTAssertGreaterThan(
      trackpadClick["clicks"] as? Int ?? 0, beforeTrackpad["clicks"] as? Int ?? 0)
    capture("real-pointer", app)
    try await post(base + "/__qa/control", ["offline": true])
    XCTAssertTrue(app.staticTexts["Showing the last received screen"].waitForExistence(timeout: 10))
    capture("offline-cached-screen", app)
    let before = try await state()
    target.tap()
    let after = try await state()
    XCTAssertEqual(after["clicks"] as? Int, before["clicks"] as? Int)
    try await post(base + "/__qa/control", ["offline": false])
    let restored = expectation(
      for: NSPredicate(format: "exists == false"),
      evaluatedWith: app.staticTexts["Showing the last received screen"])
    await fulfillment(of: [restored], timeout: 15)
    try await post(computer + "/api/v0/bots/bot-research/screen/takeover", ["active": false])
    try await Task.sleep(for: .seconds(2))
    app.buttons["Computer options"].tap()
    XCTAssertTrue(app.buttons["Take control"].waitForExistence(timeout: 10))
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.45)).tap()
    XCTAssertFalse(
      app.descendants(matching: .any).matching(identifier: "computer-text").firstMatch.exists)
    capture("lease-returned", app)
    app.buttons["Done"].tap()
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 10))
  }
}
