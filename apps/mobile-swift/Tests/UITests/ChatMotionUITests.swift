import XCTest

/// Record this deterministic scenario with simctl recordVideo for frame inspection.
@MainActor final class ChatMotionUITests: XCTestCase {
  let base = URL(string: "http://127.0.0.1:20070")!
  var marks: [[String: Any]] = []
  func control(_ path: String, _ body: [String: Any]) async throws {
    var request = URLRequest(url: base.appendingPathComponent(path))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }
  func mark(_ name: String) {
    marks.append(["name": name, "time": Date().timeIntervalSince1970])
  }
  func capture(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
  func testKeyboardSendAndActivityTransitions() async throws {
    continueAfterFailure = false
    try await control("__qa/scene", ["scene": "dark-chat-seven"])
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--server", base.absoluteString,
      "--appearance", "dark", "--open-channel", "visual-chat",
    ]
    app.launch()
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 15))
    let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    XCTAssertTrue(input.waitForExistence(timeout: 10))
    try await Task.sleep(for: .seconds(2))
    let latestReply = app.staticTexts["Got it — here."]
    let originalBottom = latestReply.frame.maxY
    mark("keyboard-open")
    input.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    input.typeText("Motion check")
    try await Task.sleep(for: .seconds(1))
    capture("keyboard-open", app)
    mark("keyboard-tap-outside")
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
    let dismissed = app.keyboards.firstMatch.waitForNonExistence(timeout: 3)
    XCTAssertTrue(dismissed, "Tapping chat history must dismiss the keyboard")
    if !dismissed { app.scrollViews.firstMatch.swipeDown() }
    try await Task.sleep(for: .seconds(1))
    if dismissed { XCTAssertEqual(latestReply.frame.maxY, originalBottom, accuracy: 3) }
    capture("keyboard-closed", app)
    mark("keyboard-reopen")
    input.tap()
    try await control(
      "__qa/control",
      [
        "failures": [
          "POST /api/v0/conversations/conversation-visual-chat/messages": ["delayMs": 2000],
          "POST /api/v0/channels/visual-chat/messages": ["delayMs": 2000],
        ]
      ])
    mark("short-send")
    app.buttons["send-button"].tap()
    try await Task.sleep(for: .milliseconds(400))
    XCTAssertFalse(app.staticTexts["Sending…"].exists)
    let queuedFrame = app.staticTexts["Motion check"].frame
    let previousMessageY = latestReply.frame.minY
    try await Task.sleep(for: .seconds(3))
    // Confirmed message actions expand the Text's accessibility hit rectangle.
    // Its center and the existing message above it must stay in place.
    let acceptedFrame = app.staticTexts["Motion check"].frame
    XCTAssertEqual(queuedFrame.midY, acceptedFrame.midY, accuracy: 1.5)
    XCTAssertEqual(queuedFrame.midX, acceptedFrame.midX, accuracy: 1.5)
    XCTAssertEqual(previousMessageY, latestReply.frame.minY, accuracy: 1.5)
    capture("short-send-accepted", app)
    input.tap()
    input.typeText("A longer message\nSecond line\nThird line\nFourth line")
    try await Task.sleep(for: .seconds(1))
    mark("multiline-send")
    app.buttons["send-button"].tap()
    try await Task.sleep(for: .seconds(2))
    mark("activity-start")
    try await control("__qa/motion", ["active": true])
    XCTAssertTrue(app.otherElements["bot-activity"].waitForExistence(timeout: 8))
    try await Task.sleep(for: .seconds(2))
    mark("activity-complete-with-reply")
    try await control("__qa/motion", ["active": false, "content": "Motion reply complete."])
    XCTAssertTrue(app.staticTexts["Motion reply complete."].waitForExistence(timeout: 8))
    try await Task.sleep(for: .seconds(2))
    capture("reply-and-activity-complete", app)
    mark("keyboard-close-after-send")
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
    try await Task.sleep(for: .seconds(1))
    mark("scroll-away")
    app.scrollViews.firstMatch.swipeDown()
    let latest = app.buttons["Latest messages"]
    XCTAssertTrue(latest.waitForExistence(timeout: 5))
    mark("return-to-latest")
    latest.tap()
    XCTAssertTrue(latest.waitForNonExistence(timeout: 5))
    try await Task.sleep(for: .seconds(1))
    capture("returned-to-latest", app)
    let timing = XCTAttachment(
      data: try JSONSerialization.data(withJSONObject: marks, options: .prettyPrinted),
      uniformTypeIdentifier: "public.json")
    timing.name = "motion-timestamps"
    timing.lifetime = .keepAlways
    add(timing)
  }

  func testRecordingReference() async throws {
    continueAfterFailure = false
    try await control("__qa/scene", ["scene": "motion-reference"])
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--server", base.absoluteString,
      "--appearance", "dark", "--open-channel", "visual-chat",
    ]
    app.launch()
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 15))
    let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    XCTAssertTrue(input.waitForExistence(timeout: 10))
    input.tap()
    input.typeText("Okay testing")
    try await Task.sleep(for: .seconds(1))
    capture("reference-before-send", app)
    mark("reference-send")
    app.buttons["send-button"].tap()
    try await Task.sleep(for: .milliseconds(150))
    mark("reference-loader-start")
    try await control("__qa/motion", ["active": true])
    try await Task.sleep(for: .seconds(3))
    // Keep XCTest screenshot capture out of the reply animation interval.
    // Extract the loading still from simctl's recording after the run instead.
    mark("reference-reply")
    try await control("__qa/motion", ["active": true, "content": "Got it — ready when you are."])
    try await Task.sleep(for: .milliseconds(1350))
    mark("reference-loader-finish")
    try await control("__qa/motion", ["active": false])
    try await Task.sleep(for: .seconds(2))
    XCTAssertTrue(app.staticTexts["Got it — ready when you are."].exists)
    capture("reference-finished", app)
    let history = app.coordinate(withNormalizedOffset: CGVector(dx: 0.65, dy: 0.23))
    history.press(
      forDuration: 0.02, thenDragTo: history.withOffset(CGVector(dx: 0, dy: 220)),
      withVelocity: .slow, thenHoldForDuration: 0)
    try await Task.sleep(for: .seconds(1))
    capture("reference-scrolled-glass", app)
    let timing = XCTAttachment(
      data: try JSONSerialization.data(withJSONObject: marks, options: .prettyPrinted),
      uniformTypeIdentifier: "public.json")
    timing.name = "reference-timestamps"
    timing.lifetime = .keepAlways
    add(timing)
  }
}
