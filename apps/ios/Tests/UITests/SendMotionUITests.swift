import XCTest

/// Delivery controls resize smoothly without replaying the outgoing bubble.
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
  func testDeliveredMessagesHaveNoReservedStatusSpace() async throws {
    continueAfterFailure = false
    try await control(["scene": "delivery-spacing"], path: "/__qa/scene")
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base.absoluteString,
      "--appearance", "dark", "--open-channel", "visual-chat"]
    app.launch()
    defer { app.terminate() }
    let first = app.staticTexts["Why is the return address Irving, Texas? That doesn't make sense."]
    let second = app.staticTexts["Shouldn't it be going back to T-Mobile?"]
    XCTAssertTrue(second.waitForExistence(timeout: 15))
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch
      .waitForNonExistence(timeout: 15))
    XCTAssertEqual(second.frame.minY - first.frame.maxY, 8, accuracy: 1)
    XCTAssertFalse(app.staticTexts["Not delivered"].exists)
    capture("compact-delivered-history", app: app)
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
    XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "send-progress").firstMatch.exists)
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
    XCTAssertLessThan(bubble.frame.midY, optimistic.midY - 30,
      "The visible retry control should expand its row and move the bottom-following transcript")
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

  func testFailureCaptionExpandsAndRetryCollapsesTheRow() async throws {
    continueAfterFailure = false
    try await control([:], path: "/__qa/reset")
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--trace-scroll-frames", "--server", base.absoluteString, "--appearance", "dark",
      "--open-channel", "channel-research", "--visual-draft", "Retry without leaving empty space",
    ]
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 15))
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch
      .waitForNonExistence(timeout: 15))
    try await control(["offline": true])
    app.buttons["send-button"].tap()
    let bubble = app.staticTexts["Retry without leaving empty space"]
    XCTAssertTrue(bubble.waitForExistence(timeout: 5))
    try await Task.sleep(for: .milliseconds(500))
    let optimistic = bubble.frame
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "send-progress").firstMatch.exists)
    capture("before-failure-caption", app: app)
    XCTAssertTrue(app.staticTexts["Not delivered"].waitForExistence(timeout: 15))
    try await Task.sleep(for: .milliseconds(700))
    XCTAssertFalse(app.staticTexts["Checking delivery…"].exists)
    XCTAssertEqual(bubble.frame.midX, optimistic.midX, accuracy: 2)
    XCTAssertLessThan(bubble.frame.midY, optimistic.midY - 30)
    XCTAssertEqual(bubble.frame.width, optimistic.width, accuracy: 2)
    XCTAssertEqual(bubble.frame.height, optimistic.height, accuracy: 2)
    XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "send-progress").firstMatch.exists)
    capture("failure-caption-expanded", app: app)
    try await control(["offline": false])
    let retry = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'retry-send-'"))
      .firstMatch
    XCTAssertTrue(retry.exists)
    retry.tap()
    XCTAssertTrue(app.staticTexts["Not delivered"].waitForNonExistence(timeout: 10))
    try await Task.sleep(for: .milliseconds(700))
    XCTAssertEqual(bubble.frame.midX, optimistic.midX, accuracy: 2)
    XCTAssertEqual(bubble.frame.midY, optimistic.midY + 4, accuracy: 2)
    let (data, _) = try await URLSession.shared.data(from: base.appendingPathComponent("__qa/state"))
    let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual((state["messages"] as? [[String: Any]])?.filter {
      $0["content"] as? String == "Retry without leaving empty space"
    }.count, 1)
    capture("failure-retry-success", app: app)
  }

  func testRetryBarWaitsForTwoFailuresAndStopsAfterRecovery() async throws {
    continueAfterFailure = false
    try await control([:], path: "/__qa/reset")
    try await control(["failures": [
      "POST /api/v0/conversations/conversation-research/messages": [
        "status": 503, "delayMs": 1200, "count": 3,
      ]
    ]])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base.absoluteString,
      "--appearance", "dark", "--open-channel", "channel-research",
      "--visual-draft", "Keep showing progress while retrying"]
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 15))
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch
      .waitForNonExistence(timeout: 15))
    app.buttons["send-button"].tap()
    let progress = app.descendants(matching: .any).matching(identifier: "send-progress").firstMatch
    XCTAssertFalse(progress.exists, "A normal send must not show retry progress")
    try await Task.sleep(for: .milliseconds(1000))
    XCTAssertFalse(progress.exists, "One failed attempt must not reveal the bar")
    XCTAssertTrue(progress.waitForExistence(timeout: 5))
    XCTAssertTrue(progress.exists, "The bar must persist through further retries")
    XCTAssertFalse(app.staticTexts["Not delivered"].exists)
    capture("automatic-retry-sending", app: app)
    XCTAssertTrue(progress.waitForNonExistence(timeout: 10))
    let (data, _) = try await URLSession.shared.data(from: base.appendingPathComponent("__qa/state"))
    let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let messages = state["messages"] as? [[String: Any]] ?? []
    let accepted = messages.filter { $0["content"] as? String == "Keep showing progress while retrying" }
    XCTAssertEqual(accepted.count, 1)
    let nonce = try XCTUnwrap(accepted.first?["clientId"] as? String)
    let requests = state["requests"] as? [[String: Any]] ?? []
    // The fixture logs accepted requests after its injected 503 responses.
    XCTAssertEqual(requests.filter {
      $0["clientId"] as? String == nonce && $0["method"] as? String == "POST"
    }.count, 1)
    XCTAssertFalse(app.staticTexts["Not delivered"].exists)
  }

  func testRetryBarRecording() async throws {
    continueAfterFailure = false
    try await control(["scene": "delivery-spacing"], path: "/__qa/scene")
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base.absoluteString,
      "--appearance", "dark", "--open-channel", "visual-chat",
      "--visual-draft", "Can you check this for me?"]
    app.launch()
    defer { app.terminate() }
    let field = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 15))
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch
      .waitForNonExistence(timeout: 15))
    field.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
    try await control(["failures": [
      "GET /api/v0/channels/visual-chat/message-deliveries/*": [
        "status": 503, "delayMs": 1200, "count": 2,
      ],
      "POST /api/v0/conversations/conversation-visual-chat/messages": [
        "status": 422, "delayMs": 2500, "count": 1,
      ],
    ]])
    print("RETRY_BAR_RECORDING_READY")
    try await Task.sleep(for: .seconds(3))
    app.buttons["send-button"].tap()
    let bubble = app.staticTexts["Can you check this for me?"]
    XCTAssertTrue(bubble.waitForExistence(timeout: 3))
    let original = bubble.frame
    let progress = app.descendants(matching: .any).matching(identifier: "send-progress").firstMatch
    XCTAssertFalse(progress.exists)
    capture("retry-bar-initially-hidden", app: app)
    XCTAssertTrue(progress.waitForExistence(timeout: 6))
    capture("retry-bar-after-two-failures", app: app)
    XCTAssertTrue(app.staticTexts["Not delivered"].waitForExistence(timeout: 7))
    XCTAssertFalse(progress.exists)
    let failureText = app.staticTexts["Not delivered"]
    XCTAssertLessThanOrEqual(failureText.frame.minY - bubble.frame.maxY, 14,
      "The failure text must sit directly under the bubble, not centered in Retry's touch target")
    capture("retry-bar-terminal-failure", app: app)
    try await Task.sleep(for: .seconds(2))
    try await control(["failures": [
      "POST /api/v0/conversations/conversation-visual-chat/messages": [
        "status": 503, "delayMs": 1200, "count": 3,
      ],
    ]])
    app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'retry-send-'"))
      .firstMatch.tap()
    XCTAssertTrue(app.keyboards.firstMatch.exists, "Retry must preserve composer focus")
    XCTAssertFalse(progress.exists, "Manual Retry must start with a fresh failure count")
    XCTAssertTrue(progress.waitForExistence(timeout: 6))
    capture("retry-bar-automatic-recovery", app: app)
    XCTAssertTrue(progress.waitForNonExistence(timeout: 10))
    try await Task.sleep(for: .milliseconds(700))
    XCTAssertEqual(app.staticTexts.matching(identifier: "Can you check this for me?").count, 1)
    XCTAssertEqual(bubble.frame.width, original.width, accuracy: 2)
    XCTAssertEqual(bubble.frame.height, original.height, accuracy: 2)
    XCTAssertEqual(bubble.frame.midY, original.midY, accuracy: 2)
    XCTAssertTrue(app.keyboards.firstMatch.exists)
    XCTAssertFalse(app.staticTexts["Not delivered"].exists)
    capture("retry-bar-delivered", app: app)
    // Exercise an immediate server echo as well as the delayed/failing path.
    field.tap()
    field.typeText("Test")
    app.buttons["send-button"].tap()
    let immediate = app.staticTexts["Test"]
    XCTAssertTrue(immediate.waitForExistence(timeout: 3))
    try await Task.sleep(for: .milliseconds(500))
    let settled = immediate.frame
    XCTAssertFalse(progress.exists)
    XCTAssertTrue(app.keyboards.firstMatch.exists)
    XCTAssertEqual(app.staticTexts.matching(identifier: "Test").count, 1)
    try await Task.sleep(for: .milliseconds(500))
    XCTAssertEqual(immediate.frame.midY, settled.midY, accuracy: 2,
      "The immediate acknowledgement must not replay the entrance")
    capture("immediate-acknowledgement", app: app)
    print("RETRY_BAR_RECORDING_COMPLETE")
    try await Task.sleep(for: .seconds(2))
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
    XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "send-progress").firstMatch.exists)
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
    XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "send-progress").firstMatch.exists)
    capture("accepted-without-bot-reply", app: app)
  }
}
