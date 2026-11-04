import XCTest

/// A delayed acknowledgement must not move or replay the outgoing bubble.
@MainActor
final class SendMotionUITests: XCTestCase {
  private let base = URL(
    string: ProcessInfo.processInfo.environment["SEND_MOTION_SERVER"]
      ?? "http://127.0.0.1:20171")!
  private func control(_ body: [String: Any], path: String = "/__qa/control") async throws {
    var request = URLRequest(url: base.appendingPathComponent(path))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }
  private func capture(_ name: String, app: XCUIApplication) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
    if ProcessInfo.processInfo.environment["SEND_MOTION_RECORDING"] == "1" {
      Thread.sleep(forTimeInterval: 1)
    }
  }
  func testProcessingStaysUnconfirmedAndRetryChecksBeforeSending() async throws {
    continueAfterFailure = false
    try await control([:], path: "/__qa/reset")
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--server", base.absoluteString, "--appearance", "dark",
      "--open-channel", "channel-research", "--visual-draft", "Check before resending",
    ]
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 15))
    XCTAssertTrue(
      app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch
        .waitForNonExistence(timeout: 15))
    try await control(["deliveryStatuses": ["pending"]])
    app.buttons["send-button"].tap()
    let bubble = app.staticTexts["Check before resending"]
    XCTAssertTrue(bubble.waitForExistence(timeout: 5))
    try await Task.sleep(for: .milliseconds(500))
    let optimistic = bubble.frame
    XCTAssertFalse(app.staticTexts["Checking delivery…"].exists)
    XCTAssertFalse(app.staticTexts["Sending…"].exists)
    XCTAssertFalse(app.staticTexts["Not delivered"].exists)
    capture("server-processing", app: app)
    XCTAssertTrue(app.staticTexts["Delivery unconfirmed"].waitForExistence(timeout: 15))
    XCTAssertFalse(app.staticTexts["Not delivered"].exists)
    XCTAssertFalse(app.staticTexts["Couldn't send message"].exists)
    let retry = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'retry-send-'"))
      .firstMatch
    XCTAssertTrue(retry.waitForExistence(timeout: 3))
    XCTAssertEqual(bubble.frame.midX, optimistic.midX, accuracy: 2)
    XCTAssertEqual(bubble.frame.midY, optimistic.midY, accuracy: 2)
    capture("delivery-unconfirmed", app: app)
    try await control(["deliveryStatuses": []])
    retry.tap()
    XCTAssertTrue(app.staticTexts["Delivery unconfirmed"].waitForNonExistence(timeout: 10))
    let (data, _) = try await URLSession.shared.data(
      from: base.appendingPathComponent("__qa/state"))
    let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let messages = state["messages"] as? [[String: Any]] ?? []
    XCTAssertEqual(
      messages.filter { $0["content"] as? String == "Check before resending" }.count, 1)
    XCTAssertEqual(bubble.frame.midX, optimistic.midX, accuracy: 2)
    XCTAssertEqual(bubble.frame.midY, optimistic.midY, accuracy: 2)
    capture("delivery-confirmed-after-retry", app: app)
  }

  func testFailureCaptionAndRetryNeverMoveTheBubble() async throws {
    continueAfterFailure = false
    try await control([:], path: "/__qa/reset")
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--server", base.absoluteString, "--appearance", "dark",
      "--open-channel", "channel-research", "--visual-draft", "Keep this bubble still",
    ]
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 15))
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch
      .waitForNonExistence(timeout: 15))
    try await control(["offline": true])
    app.buttons["send-button"].tap()
    let bubble = app.staticTexts["Keep this bubble still"]
    XCTAssertTrue(bubble.waitForExistence(timeout: 5))
    try await Task.sleep(for: .milliseconds(500))
    let optimistic = bubble.frame
    capture("before-failure-caption", app: app)
    XCTAssertTrue(app.staticTexts["Not delivered"].waitForExistence(timeout: 15))
    XCTAssertFalse(app.staticTexts["Checking delivery…"].exists)
    XCTAssertEqual(bubble.frame.midX, optimistic.midX, accuracy: 2)
    XCTAssertEqual(bubble.frame.midY, optimistic.midY, accuracy: 2)
    capture("failure-caption-without-movement", app: app)
    try await control(["offline": false])
    let retry = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'retry-send-'"))
      .firstMatch
    XCTAssertTrue(retry.exists)
    retry.tap()
    XCTAssertTrue(app.staticTexts["Not delivered"].waitForNonExistence(timeout: 10))
    try await Task.sleep(for: .milliseconds(700))
    XCTAssertEqual(bubble.frame.midX, optimistic.midX, accuracy: 2)
    XCTAssertEqual(bubble.frame.midY, optimistic.midY, accuracy: 2)
    let (data, _) = try await URLSession.shared.data(from: base.appendingPathComponent("__qa/state"))
    let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual((state["messages"] as? [[String: Any]])?.filter {
      $0["content"] as? String == "Keep this bubble still"
    }.count, 1)
    capture("failure-retry-success", app: app)
  }

  func testSendingMatchesReferenceAndAcknowledgementDoesNotReplayIt() async throws {
    continueAfterFailure = false
    try await control([:], path: "/__qa/reset")
    try await control([
      "failures": [
        "POST /api/v0/conversations/conversation-research/messages": ["delayMs": 4000, "count": 1]
      ]
    ])
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--server", base.absoluteString, "--appearance", "dark",
      "--open-channel", "channel-research", "--visual-draft", "Testing native sending",
    ]
    app.launch()
    defer { app.terminate() }
    let field = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 15))
    XCTAssertTrue(
      app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch
        .waitForNonExistence(timeout: 15))
    field.tap()
    let keyboardWasVisible = app.keyboards.firstMatch.waitForExistence(timeout: 3)
    capture("before-send", app: app)
    app.buttons["send-button"].tap()
    let bubble = app.staticTexts["Testing native sending"]
    XCTAssertTrue(bubble.waitForExistence(timeout: 5))
    try await Task.sleep(for: .milliseconds(500))
    let queued = bubble.frame
    XCTAssertFalse(app.staticTexts["Not delivered"].exists)
    XCTAssertFalse(app.staticTexts["Couldn't send message"].exists)
    if keyboardWasVisible { XCTAssertTrue(app.keyboards.firstMatch.exists) }
    capture("pending-send", app: app)
    var accepted = false
    for _ in 0..<50 {
      let (data, _) = try await URLSession.shared.data(
        from: base.appendingPathComponent("__qa/state"))
      let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
      let messages = state["messages"] as? [[String: Any]] ?? []
      let matches = messages.filter { $0["content"] as? String == "Testing native sending" }
      XCTAssertLessThanOrEqual(matches.count, 1)
      if matches.count == 1 {
        accepted = true
        break
      }
      try await Task.sleep(for: .milliseconds(200))
    }
    XCTAssertTrue(accepted)
    try await Task.sleep(for: .milliseconds(700))
    XCTAssertEqual(bubble.frame.midX, queued.midX, accuracy: 2)
    XCTAssertEqual(bubble.frame.midY, queued.midY, accuracy: 2)
    XCTAssertEqual(app.staticTexts.matching(identifier: "Testing native sending").count, 1)
    if keyboardWasVisible { XCTAssertTrue(app.keyboards.firstMatch.exists) }
    XCTAssertFalse(app.staticTexts["Not delivered"].exists)
    capture("accepted-without-bot-reply", app: app)
  }
}
