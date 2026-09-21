import XCTest

@MainActor
final class GrokbotVisualTests: XCTestCase {
  let base = URL(string: "http://127.0.0.1:19996")!
  func launch(_ scene: String, appearance: String = "light", draft: String? = nil) async throws
    -> XCUIApplication
  {
    continueAfterFailure = false
    var request = URLRequest(url: base.appendingPathComponent("__qa/scene"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: ["scene": scene])
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--server", base.absoluteString, "--appearance", appearance,
    ]
    if scene != "home" { app.launchArguments += ["--open-channel", "visual-chat"] }
    if let draft { app.launchArguments += ["--visual-draft", draft] }
    app.launch()
    XCTAssertTrue(
      (scene == "home" ? app.buttons["settings-button"] : input(app)).waitForExistence(timeout: 15))
    return app
  }
  func input(_ app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: app.buttons["thread-back"].isHittable ? "thread-message-input" : "message-input").firstMatch
  }
  func capture(_ name: String, _ app: XCUIApplication) {
    if name.contains("keyboard") || name == "search" {
      let keyboard = app.keyboards.firstMatch
      XCTAssertGreaterThan(keyboard.frame.height, 200, "Capture the visible software keyboard")
      XCTAssertLessThanOrEqual(keyboard.frame.maxY, app.frame.maxY + 1)
      XCTAssertTrue(keyboard.keys["space"].isHittable)
    }
    let item = XCTAttachment(screenshot: app.screenshot())
    item.name = "grok-native-" + name
    item.lifetime = .keepAlways
    add(item)
  }
  func testHomeAndNativeContextMenu() async throws {
    let app = try await launch("home")
    XCTAssertTrue(app.buttons["channel-visual-0"].waitForExistence(timeout: 5))
    capture("home", app)
    app.buttons["channel-visual-5"].press(forDuration: 1)
    XCTAssertTrue(app.buttons["Mark unread"].waitForExistence(timeout: 5))
    capture("home-menu", app)
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.15)).tap()
    let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.65))
    from.press(
      forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 0, dy: -156)),
      withVelocity: .slow, thenHoldForDuration: 0.5)
    XCTAssertLessThan(
      app.buttons["channel-visual-0"].frame.minY,
      app.buttons["settings-button"].frame.maxY)
    capture("home-scrolled", app)
  }
  func testSettingsSearchAndCreateSheets() async throws {
    var app = try await launch("home")
    app.buttons["settings-button"].tap()
    XCTAssertTrue(app.buttons["appearance-picker"].waitForExistence(timeout: 5))
    capture("settings", app)
    app.buttons["appearance-picker"].tap()
    app.buttons["Dark"].tap()
    capture("settings-dark", app)
    app = try await launch("home")
    app.buttons["search-button"].tap()
    XCTAssertTrue(app.textFields["search-input"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    capture("search", app)
    app.buttons["sheet-close"].tap()
    app.buttons["new-button"].tap()
    XCTAssertTrue(app.buttons["New Bot"].waitForExistence(timeout: 5))
    capture("create-menu", app)
    app.buttons["New Bot"].tap()
    XCTAssertTrue(app.textFields["new-name"].waitForExistence(timeout: 5))
    capture("create-bot", app)
    app.textFields["new-name"].tap()
    app.textFields["new-name"].typeText("Native visual QA")
    app.buttons["create-confirm"].tap()
    XCTAssertTrue(input(app).waitForExistence(timeout: 10))
  }
  func testDarkChatAndSystemKeyboard() async throws {
    var app = try await launch("draft", appearance: "dark", draft: "Testttt")
    capture("short-draft", app)
    XCTAssertFalse(app.buttons["Latest messages"].exists)
    XCTAssertTrue(app.buttons["chat-back"].isHittable)
    XCTAssertTrue(app.buttons["conversation-details"].isHittable)
    XCTAssertTrue(app.buttons["attach-button"].isHittable)
    app = try await launch("thinking", appearance: "dark")
    capture("thinking", app)
    app = try await launch("keyboard", appearance: "dark")
    input(app).tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    XCTAssertLessThanOrEqual(input(app).frame.maxY, app.keyboards.firstMatch.frame.minY)
    capture("thinking-keyboard", app)
    app = try await launch("long", appearance: "dark")
    app.tables["chat-history"].swipeDown()
    let scrollFrom = app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.6))
    scrollFrom.press(
      forDuration: 0.05, thenDragTo: scrollFrom.withOffset(CGVector(dx: 0, dy: -131)),
      withVelocity: .slow, thenHoldForDuration: 0.3)
    capture("long-chat", app)
    input(app).tap()
    input(app).typeText("Hdhdhdhd\n\nDhdhhd")
    let keyboardScrollFrom = app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.49))
    keyboardScrollFrom.press(
      forDuration: 0.05, thenDragTo: keyboardScrollFrom.withOffset(CGVector(dx: 0, dy: -345)),
      withVelocity: .slow, thenHoldForDuration: 0.3)
    XCTAssertLessThanOrEqual(
      app.buttons["send-button"].frame.maxY, app.keyboards.firstMatch.frame.minY)
    capture("long-keyboard", app)
  }
  func testMessageActionsAndNativeReplyGesture() async throws {
    let app = try await launch("actions")
    let last = app.staticTexts.matching(identifier: "CERULEAN781").allElementsBoundByIndex.last!
    last.press(forDuration: 1)
    XCTAssertTrue(app.buttons["Start a thread"].waitForExistence(timeout: 5))
    capture("message-actions", app)
    app.buttons["Reply"].tap()
    XCTAssertTrue(app.buttons["thread-back"].waitForExistence(timeout: 5))
    capture("reply-composer", app)
    app.buttons["thread-back"].tap()
    // The keyboard changes which history rows are visible; target a visible bubble.
    let target = app.staticTexts.matching(identifier: "CERULEAN781").allElementsBoundByIndex.first(
      where: { $0.isHittable })!
    let from = target.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
    let to = from.withOffset(CGVector(dx: 125, dy: 0))
    from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.6)
    XCTAssertTrue(app.buttons["thread-back"].waitForExistence(timeout: 5))
    capture("reply-after-swipe", app)
  }
  func testReplyDragReferenceState() async throws {
    let app = try await launch("actions")
    let target = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "8 plus 6"))
      .firstMatch
    XCTAssertTrue(target.isHittable)
    capture("reply-resting", app)
    let from = target.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.5))
    from.press(
      forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 125, dy: 0)), withVelocity: .slow,
      thenHoldForDuration: 2)
    XCTAssertTrue(app.buttons["thread-back"].waitForExistence(timeout: 5))
    capture("reply-user-completed", app)
  }
  func testFocusedReplyRetriesAndKeepsThreadContext() async throws {
    continueAfterFailure = false
    func control(_ value: [String: Bool]) async throws {
      var request = URLRequest(url: base.appendingPathComponent("__qa/control"))
      request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: value)
      let (_, response) = try await URLSession.shared.data(for: request)
      XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }
    let app = try await launch("actions")
    let original = app.staticTexts.matching(identifier: "CERULEAN781").allElementsBoundByIndex.first!
    original.press(forDuration: 0.7); app.buttons["Reply"].tap()
    XCTAssertTrue(app.buttons["thread-back"].waitForExistence(timeout: 8))
    input(app).tap(); input(app).typeText("Focused reply survives retry")
    try await control(["offline": true]); app.buttons["thread-send-button"].tap()
    XCTAssertTrue(app.staticTexts["Waiting for connection"].waitForExistence(timeout: 10))
    app.buttons["thread-back"].tap()
    XCTAssertFalse(app.staticTexts["Focused reply survives retry"].isHittable)
    original.press(forDuration: 0.7); app.buttons["Reply"].tap()
    XCTAssertTrue(app.staticTexts["Focused reply survives retry"].waitForExistence(timeout: 8))
    try await control(["offline": false, "dropNextSend": true])
    var replies: [[String: Any]] = []
    for _ in 0..<40 {
      let (data, _) = try await URLSession.shared.data(from: base.appendingPathComponent("__qa/state"))
      let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
      replies = (state["messages"] as? [[String: Any]] ?? []).filter { $0["content"] as? String == "Focused reply survives retry" }
      if !replies.isEmpty { break }
      try await Task.sleep(for: .milliseconds(300))
    }
    XCTAssertEqual(replies.count, 1)
    let metadata = try XCTUnwrap(replies.first?["metadata"] as? [String: Any])
    XCTAssertEqual(metadata["replyTo"] as? String, "visual-message-visual-chat-3")
    XCTAssertEqual(metadata["branched"] as? Bool, true)
    XCTAssertTrue(app.staticTexts["Waiting for connection"].waitForNonExistence(timeout: 15))
    XCTAssertFalse(app.alerts.firstMatch.exists)
    capture("focused-reply-recovered", app)
    app.buttons["thread-back"].tap()
    XCTAssertTrue(app.buttons["thread-visual-message-visual-chat-3"].waitForExistence(timeout: 8))
  }
  func testScrolledChatKeepsFloatingControlsInBothAppearances() async throws {
    for appearance in ["light", "dark"] {
      let app = try await launch("actions", appearance: appearance)
      app.tables["chat-history"].swipeDown(velocity: .slow)
      XCTAssertTrue(app.buttons["chat-back"].isHittable)
      XCTAssertTrue(app.buttons["attach-button"].isHittable)
      capture("chat-scrolled-" + appearance, app)
      input(app).tap()
      input(app).typeText("Reply with the native keyboard")
      XCTAssertLessThanOrEqual(input(app).frame.maxY, app.keyboards.firstMatch.frame.minY)
      capture("chat-scrolled-keyboard-" + appearance, app)
    }
  }
  func testLongHistoryRemainsInteractive() async throws {
    let app = try await launch("history")
    let history = app.tables["chat-history"]
    history.swipeDown()
    history.swipeDown()
    history.swipeUp()
    input(app).tap()
    input(app).typeText("History remains responsive")
    XCTAssertTrue(app.buttons["send-button"].isHittable)
    capture("history-stress", app)
    app.buttons["chat-back"].tap()
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 5))
  }
}
