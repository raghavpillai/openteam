import XCTest

/// Optional live, authenticated API + actual X11 desktop. Only network faults are injected.
@MainActor final class VNCValidationUITests: XCTestCase {
  private let base = "http://127.0.0.1:20024"
  override func tearDown() async throws {
    if let value = try? await request("/__qa/state"),
      let data = try? JSONSerialization.data(
        withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
    {
      let item = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
      item.name = "vnc-final-remote-state"
      item.lifetime = .keepAlways
      add(item)
    }
  }
  private func request(_ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
    var r = URLRequest(url: URL(string: base + path)!)
    r.timeoutInterval = 45
    if let body {
      r.httpMethod = "POST"
      r.httpBody = try JSONSerialization.data(withJSONObject: body)
      r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try await URLSession.shared.data(for: r)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
  private func remote() async throws -> [String: Any] {
    let state = try await request("/__qa/state")
    return try XCTUnwrap(state["desktop"] as? [String: Any])
  }
  private func eventually(_ predicate: ([String: Any]) -> Bool) async throws -> [String: Any] {
    for _ in 0..<40 {
      let value = try await remote()
      if predicate(value) { return value }
      try await Task.sleep(for: .milliseconds(250))
    }
    let state = try await request("/__qa/state")
    let item = XCTAttachment(string: String(describing: state))
    item.name = "vnc-failed-remote-receipts"
    item.lifetime = .keepAlways
    add(item)
    XCTFail("Expected input did not reach the actual remote desktop")
    return try await remote()
  }
  private func capture(_ name: String, _ app: XCUIApplication) {
    let a = XCTAttachment(screenshot: app.screenshot())
    a.name = "vnc-" + name
    a.lifetime = .keepAlways
    add(a)
    let tree = XCTAttachment(string: app.debugDescription)
    tree.name = "vnc-" + name + "-accessibility"
    tree.lifetime = .keepAlways
    add(tree)
  }
  private func launch(starting: Bool = false) async throws -> XCUIApplication {
    continueAfterFailure = false
    executionTimeAllowance = 240
    _ = try await request("/__qa/reset", [:])
    let config = try await request("/__qa/config")
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "dark"]
    app.launch()
    XCTAssertTrue(app.textFields["username-field"].waitForExistence(timeout: 20))
    app.textFields["username-field"].tap()
    app.textFields["username-field"].typeText(try XCTUnwrap(config["username"] as? String))
    app.secureTextFields["password-field"].tap()
    app.secureTextFields["password-field"].typeText(try XCTUnwrap(config["password"] as? String))
    app.buttons["sign-in-button"].tap()
    let chat = app.buttons["channel-" + (try XCTUnwrap(config["channel"] as? String))]
    XCTAssertTrue(chat.waitForExistence(timeout: 20))
    chat.tap()
    if starting {
      _ = try await request("/__qa/control", ["statusDelay": 4500])
      _ = try await request("/__qa/desktop", [:])
    }
    app.buttons["Computer"].tap()
    if starting {
      XCTAssertTrue(app.staticTexts["Starting desktop…"].waitForExistence(timeout: 3))
      capture("starting", app)
      _ = try await request("/__qa/control", ["statusDelay": 0])
    }
    XCTAssertTrue(app.images["computer-screen"].waitForExistence(timeout: 30))
    return app
  }
  private func takeControl(_ app: XCUIApplication) {
    app.buttons["Computer options"].tap()
    app.buttons["Take control"].tap()
  }
  func testStartupKeyboardClipboardAndInputRetry() async throws {
    let app = try await launch(starting: true)
    let screen = app.images["computer-screen"]
    XCTAssertEqual(screen.frame.width / screen.frame.height, 1.6, accuracy: 0.03)
    capture("keyboard-closed", app)
    _ = try await request("/__qa/reset", [:])
    app.buttons["Show computer keyboard"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 8))
    XCTAssertLessThan(screen.frame.maxY, app.keyboards.firstMatch.frame.minY)
    XCTAssertEqual(screen.frame.width / screen.frame.height, 1.6, accuracy: 0.03)
    app.typeText("Native VNC input")
    _ = try await eventually { $0["text"] as? String == "Native VNC input" }
    app.typeText("\n" + XCUIKeyboardKey.delete.rawValue + "!")
    _ = try await eventually { $0["text"] as? String == "Native VNC input!" }
    try await Task.sleep(for: .seconds(2))
    capture("keyboard-open", app)
    app.buttons["Hide computer keyboard"].tap()
    app.buttons["Clipboard"].tap()
    let text = app.descendants(matching: .any).matching(identifier: "computer-text").firstMatch
    text.tap()
    text.typeText(" clipboard")
    _ = try await request("/__qa/control", ["actionFailures": 1])
    app.buttons["Type"].tap()
    XCTAssertTrue(
      app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "QA input failed"))
        .firstMatch.waitForExistence(timeout: 10))
    XCTAssertEqual(text.value as? String, " clipboard")
    capture("clipboard-retry", app)
    app.buttons["Type"].tap()
    _ = try await eventually { $0["text"] as? String == "Native VNC input! clipboard" }
    XCTAssertTrue(app.buttons["Clipboard"].waitForExistence(timeout: 8))
    app.buttons["Done"].tap()
    XCTAssertTrue(app.buttons["Computer"].waitForExistence(timeout: 10))
    let status = try await request("/__qa/state")
    XCTAssertEqual((status["status"] as? [String: Any])?["humanTakeover"] as? Bool, false)
  }
  func testTouchClickDoubleClickRepeatedHoldAndDrag() async throws {
    let app = try await launch()
    takeControl(app)
    let screen = app.images["computer-screen"]
    let target = screen.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
    target.tap()
    target.doubleTap()
    target.press(forDuration: 0.8)
    _ = try await eventually {
      ($0["clicks"] as? Int ?? 0) >= 3 && ($0["rightClicks"] as? Int ?? 0) == 1
    }
    for count in 2...5 {
      target.press(forDuration: 0.8)
      _ = try await eventually { $0["rightClicks"] as? Int == count }
    }
    let before = try await remote()
    let start = screen.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.7))
    start.press(
      forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 85, dy: -20)),
      withVelocity: .slow, thenHoldForDuration: 0.1)
    let result = try await eventually {
      ($0["moves"] as? Int ?? 0) > (before["moves"] as? Int ?? 0)
    }
    let events = result["events"] as? [[String: Any]] ?? []
    XCTAssertTrue(
      events.contains { $0["type"] as? String == "pointermove" && $0["buttons"] as? Int == 1 })
    XCTAssertEqual(
      events.last(where: { $0["type"] as? String == "pointerup" })?["buttons"] as? Int, 0)
    capture("touch-input", app)
    app.buttons["Done"].tap()
  }
  func testDirectTouchDragZoomAndIdleHold() async throws {
    let app = try await launch()
    takeControl(app)
    let screen = app.images["computer-screen"]
    let target = screen.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
    target.tap()
    let tapped = try await eventually { $0["clicks"] as? Int == 1 }
    let click = (tapped["events"] as? [[String: Any]])?.last(where: {
      $0["type"] as? String == "click"
    })
    XCTAssertEqual(click?["screenX"] as? Int, 640)
    XCTAssertEqual(click?["screenY"] as? Int, 560)
    for count in 1...5 {
      target.press(forDuration: 0.8)
      _ = try await eventually { $0["rightClicks"] as? Int == count }
    }
    let start = screen.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.7))
    start.press(
      forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 85, dy: -20)),
      withVelocity: .slow, thenHoldForDuration: 0.1)
    let dragged = try await eventually { value in
      (value["events"] as? [[String: Any]] ?? []).contains {
        $0["type"] as? String == "pointermove" && $0["buttons"] as? Int == 1
      }
    }
    XCTAssertEqual(
      (dragged["events"] as? [[String: Any]])?.last(where: { $0["type"] as? String == "pointerup" }
      )?["buttons"] as? Int, 0)
    let before = screen.frame.width
    screen.pinch(withScale: 1.6, velocity: 1)
    XCTAssertGreaterThan(screen.frame.width, before * 1.3)
    capture("touch-drag-and-zoom", app)
    app.buttons["Done"].tap()
  }
  func testTwoFingerTapRightClick() async throws {
    let app = try await launch()
    takeControl(app)
    app.images["computer-screen"].twoFingerTap()
    capture("two-finger-right-click", app)
    _ = try await eventually { $0["rightClicks"] as? Int == 1 }
  }
  func testTrackpadMovesTheRemotePointer() async throws {
    let app = try await launch()
    takeControl(app)
    app.buttons["Computer options"].tap()
    app.buttons["Input controls"].tap()
    XCTAssertTrue(app.buttons["Trackpad"].waitForExistence(timeout: 8))
    app.buttons["Trackpad"].tap()
    app.buttons["Close input controls"].tap()
    let before = try await remote()
    let target = app.images["computer-screen"].coordinate(
      withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
    target.press(
      forDuration: 0.05, thenDragTo: target.withOffset(CGVector(dx: 65, dy: 12)),
      withVelocity: .slow, thenHoldForDuration: 0)
    capture("trackpad-movement", app)
    _ = try await eventually { ($0["moves"] as? Int ?? 0) > (before["moves"] as? Int ?? 0) }
  }
  func testTrackpadTapThenDragReachesDesktop() async throws {
    let app = try await launch()
    takeControl(app)
    app.buttons["Computer options"].tap()
    app.buttons["Input controls"].tap()
    XCTAssertTrue(app.buttons["Trackpad"].waitForExistence(timeout: 8))
    app.buttons["Trackpad"].tap()
    app.buttons["Close input controls"].tap()
    let target = app.images["computer-screen"].coordinate(
      withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
    target.tap()
    target.press(
      forDuration: 0.05, thenDragTo: target.withOffset(CGVector(dx: 65, dy: 12)),
      withVelocity: .slow, thenHoldForDuration: 0)
    _ = try await eventually { value in
      (value["events"] as? [[String: Any]] ?? []).contains {
        $0["type"] as? String == "pointermove" && $0["buttons"] as? Int == 1
      }
    }
    capture("trackpad-remote-drag", app)
  }
  func testForegroundRecoveryPauseAndLeaseReturn() async throws {
    let app = try await launch()
    takeControl(app)
    _ = try await request("/__qa/control", ["offline": true])
    XCTAssertTrue(app.staticTexts["Showing the last received screen"].waitForExistence(timeout: 12))
    let before = try await remote()
    app.images["computer-screen"].tap()
    let after = try await remote()
    XCTAssertEqual(after["clicks"] as? Int, before["clicks"] as? Int)
    XCTAssertFalse(app.buttons["Show computer keyboard"].isEnabled)
    capture("disconnected", app)
    _ = try await request("/__qa/control", ["offline": false])
    let restored = expectation(
      for: NSPredicate(format: "exists == false"),
      evaluatedWith: app.staticTexts["Showing the last received screen"])
    await fulfillment(of: [restored], timeout: 15)
    app.buttons["Computer options"].tap()
    app.buttons["Pause view"].tap()
    XCTAssertTrue(app.staticTexts["View paused"].exists)
    let paused = try await remote()
    app.images["computer-screen"].tap()
    let stillPaused = try await remote()
    XCTAssertEqual(stillPaused["clicks"] as? Int, paused["clicks"] as? Int)
    app.buttons["Computer options"].tap()
    app.buttons["Resume view"].tap()
    app.buttons["Show computer keyboard"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 6))
    XCUIDevice.shared.press(.home)
    try await Task.sleep(for: .seconds(2))
    let status = try await request("/__qa/state")
    XCTAssertEqual((status["status"] as? [String: Any])?["humanTakeover"] as? Bool, false)
    app.activate()
    let foreground = expectation(
      for: NSPredicate(format: "isHittable == true"),
      evaluatedWith: app.buttons["Show computer keyboard"])
    await fulfillment(of: [foreground], timeout: 12)
    capture("foreground-keyboard-control", app)
    XCTAssertFalse(app.keyboards.firstMatch.exists)
    app.buttons["Show computer keyboard"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 6))
    _ = try await request("/__qa/release", [:])
    let hidden = expectation(
      for: NSPredicate(format: "exists == false"), evaluatedWith: app.keyboards.firstMatch)
    await fulfillment(of: [hidden], timeout: 12)
    capture("lease-returned", app)
    app.buttons["Done"].tap()
    XCTAssertTrue(app.buttons["Computer"].waitForExistence(timeout: 10))
  }
}
