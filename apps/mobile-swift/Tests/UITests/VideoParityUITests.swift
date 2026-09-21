import XCTest
import UIKit

/// Requires video-reference-server.ts :20121 and parity-server.ts :20122.
@MainActor final class VideoParityUITests: XCTestCase {
  private let base = "http://127.0.0.1:20121"
  private func api(_ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
    var r = URLRequest(url: URL(string: base + path)!)
    if let body { r.httpMethod = "POST"; r.httpBody = try JSONSerialization.data(withJSONObject: body); r.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    let (data, response) = try await URLSession.shared.data(for: r)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
  private func launch(_ scene: String, home: Bool = false, appearance: String = "dark") async throws -> XCUIApplication {
    continueAfterFailure = false
    _ = try await api("/__audit/scene", ["scene": scene])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", appearance, "--qa-session", UUID().uuidString, "--trace-chat-layout"]
    if scene == "voice" { app.launchArguments += ["--qa-synthetic-voice"] }
    if !home { app.launchArguments += ["--open-channel", "channel-research"] }
    app.launch()
    XCTAssertTrue(app.buttons[home ? "channel-channel-research" : "chat-back"].waitForExistence(timeout: 20))
    if !home { XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch.waitForNonExistence(timeout: 20)) }
    XCTAssertFalse(app.alerts.firstMatch.exists, "Unexpected alert must not count as a successful destination")
    return app
  }
  private func capture(_ name: String, _ app: XCUIApplication) async throws {
    try await Task.sleep(for: .milliseconds(400))
    let a = XCTAttachment(screenshot: app.screenshot()); a.name = "fixed0921-" + name; a.lifetime = .keepAlways; add(a)
    let t = XCTAttachment(string: app.debugDescription); t.name = "fixed0921-" + name + "-accessibility"; t.lifetime = .keepAlways; add(t)
  }
  /// Record actual scroll motion over the same transcript as the reference.
  /// Resting screenshots alone cannot establish the glass's backdrop response.
  func testMovingGlassOverMatchedTranscript() async throws {
    for appearance in ["dark", "light"] {
      let app = try await launch("glass", appearance: appearance)
      let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
      XCTAssertTrue(input.isHittable)
      let header = app.buttons["conversation-details"]
      let initialHeader = header.frame
      let initialInput = input.frame
      let anchor = app.staticTexts["Hello"]
      let initialAnchorY = anchor.frame.minY
      var travel: CGFloat = 0
      try await capture("glass-rest-" + appearance, app)
      // Smoothly bring the newest light bubble beneath the composer, then
      // bring the preceding light bubble beneath the title capsule.
      for (index, distance) in [CGFloat(190), CGFloat(170), CGFloat(-240)].enumerated() {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.70, dy: 0.40))
        start.press(forDuration: 0.03, thenDragTo: start.withOffset(CGVector(dx: 0, dy: distance)),
          withVelocity: XCUIGestureVelocity(rawValue: 100), thenHoldForDuration: 0.1)
        try await capture("glass-scroll-\(index)-" + appearance, app)
        XCTAssertEqual(header.frame.minY, initialHeader.minY, accuracy: 1)
        XCTAssertEqual(input.frame.minY, initialInput.minY, accuracy: 1)
        XCTAssertTrue(input.isHittable)
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        travel = max(travel, abs(anchor.frame.minY - initialAnchorY))
        if appearance == "dark" {
          // The transcript must not reappear below the fade's opaque endpoint.
          let image = try XCTUnwrap(app.screenshot().image.cgImage)
          let patch = try XCTUnwrap(image.cropping(to: CGRect(
            x: CGFloat(image.width) * 0.90, y: CGFloat(image.height) - 18, width: 6, height: 6)))
          var pixels = [UInt8](repeating: 0, count: 6 * 6 * 4)
          let context = try XCTUnwrap(CGContext(data: &pixels, width: 6, height: 6,
            bitsPerComponent: 8, bytesPerRow: 24, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
          context.draw(patch, in: CGRect(x: 0, y: 0, width: 6, height: 6))
          for index in stride(from: 0, to: pixels.count, by: 4) {
            XCTAssertLessThanOrEqual(pixels[index], 24, "Content leaked below the composer fade")
          }
        }
      }
      XCTAssertGreaterThan(travel, 60, "The capture must actually scroll content beneath the glass")
      if app.buttons["Latest messages"].exists {
        app.buttons["Latest messages"].tap()
        XCTAssertTrue(app.buttons["Latest messages"].waitForNonExistence(timeout: 8))
      }
      input.tap()
      XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
      input.typeText("Glass validation")
      try await capture("glass-keyboard-rest-" + appearance, app)
      let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.65, dy: 0.28))
      start.press(forDuration: 0.03, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 170)),
        withVelocity: XCUIGestureVelocity(rawValue: 100), thenHoldForDuration: 0.1)
      XCTAssertTrue(app.keyboards.firstMatch.exists)
      XCTAssertTrue(input.isHittable)
      try await capture("glass-keyboard-scroll-" + appearance, app)
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      XCTAssertEqual(input.value as? String, "Glass validation")
      input.tap()
      XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
      input.typeText("\nSecond line\nThird line\nFourth line\nFifth line\nSixth line")
      let expanded = input.frame.height
      XCTAssertGreaterThan(expanded, initialInput.height + 60)
      try await capture("glass-multiline-" + appearance, app)
      XCTAssertTrue(app.buttons["send-button"].isHittable)
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      XCTAssertTrue((input.value as? String)?.contains("Sixth line") == true)
      app.terminate()
    }
  }
  func testWidgetChoicesAndDismissedReceipt() async throws {
    for appearance in ["dark", "light"] {
      let app = try await launch("multi", appearance: appearance)
      XCTAssertTrue(app.staticTexts["Default style option"].waitForExistence(timeout: 8))
      XCTAssertTrue(app.staticTexts["Danger style option"].exists)
      XCTAssertFalse(app.textFields["Your answer"].exists)
      XCTAssertFalse(app.buttons["widget-submit-card"].isEnabled)
      try await capture("multi-" + appearance, app)
      app.buttons["Primary"].tap()
      XCTAssertTrue(app.buttons["widget-submit-card"].isEnabled)
      XCTAssertEqual(app.buttons["Primary"].value as? String, "Selected")
      app.buttons["widget-dismiss-card"].tap()
      XCTAssertTrue(app.staticTexts["widget-dismissed-card"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.staticTexts["Default style option"].exists)
      XCTAssertFalse(app.buttons["Primary"].isEnabled)
      XCTAssertFalse(app.buttons["widget-submit-card"].exists)
      try await capture("dismissed-" + appearance, app)
      app.terminate()
    }
  }
  func testSingleChoiceCanChangeAfterFailure() async throws {
    let app = try await launch("single")
    _ = try await api("/__audit/fail-once", [:])
    app.buttons["Ship it"].tap()
    XCTAssertTrue(app.staticTexts["Synthetic retry failure"].waitForExistence(timeout: 8))
    app.buttons["Hold"].tap()
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "widget-answer-card-0").firstMatch.waitForExistence(timeout: 8))
    let state = try await api("/__audit/state")
    let bodies = try XCTUnwrap(state["receipts"] as? [[String: Any]]).compactMap { $0["body"] as? [String: Any] }
    XCTAssertEqual(bodies.count, 2)
    XCTAssertEqual(bodies.last?["value"] as? String, "hold")
    XCTAssertNotEqual(bodies.first?["clientId"] as? String, bodies.last?["clientId"] as? String)
    app.terminate()
  }
  func testSingleChoiceResizesToReceipt() async throws {
    let app = try await launch("single")
    XCTAssertTrue(app.buttons["Ship it"].waitForExistence(timeout: 8))
    try await capture("single", app)
    app.buttons["Ship it"].tap()
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "widget-answer-card-0").firstMatch.waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["Hold"].exists)
    try await capture("completed", app)
    let state = try await api("/__audit/state")
    let receipts = try XCTUnwrap(state["receipts"] as? [[String: Any]])
    XCTAssertEqual((receipts.last?["body"] as? [String: Any])?["value"] as? String, "ship")
    app.terminate()
  }
  func testWidgetCompletionMakesRoomForWorking() async throws {
    let app = try await launch("single")
    _ = try await api("/__audit/activity-on-answer", [:])
    app.buttons["Ship it"].tap()
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "widget-answer-card-0").firstMatch.waitForExistence(timeout: 8))
    let activity = app.descendants(matching: .any).matching(identifier: "bot-activity").firstMatch
    XCTAssertTrue(activity.waitForExistence(timeout: 8))
    XCTAssertTrue(activity.isHittable)
    try await capture("completed-working", app)
    _ = try await api("/__audit/activity", ["active": false])
    // The zero-height hosting container may remain in the raw hierarchy while
    // the activity content is hidden and excluded from accessibility.
    let hidden = expectation(for: NSPredicate(format: "exists == false OR hittable == false"), evaluatedWith: activity)
    await fulfillment(of: [hidden], timeout: 8)
    try await capture("completed-idle", app)
    app.terminate()
  }
  func testWidgetResizeWithKeyboardAndReadingAnchor() async throws {
    let keyboard = try await launch("single")
    let input = keyboard.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    input.tap()
    XCTAssertTrue(keyboard.keyboards.firstMatch.waitForExistence(timeout: 8))
    try await capture("single-keyboard", keyboard)
    keyboard.buttons["Ship it"].tap()
    XCTAssertTrue(keyboard.descendants(matching: .any).matching(identifier: "widget-answer-card-0").firstMatch.waitForExistence(timeout: 8))
    try await capture("completed-keyboard", keyboard)
    keyboard.terminate()
    let reading = try await launch("reading")
    let choice = reading.buttons["Ship it"]
    let anchor = reading.staticTexts["Before card 5"]
    for _ in 0..<8 {
      if choice.isHittable && anchor.isHittable { break }
      reading.swipeDown(velocity: .slow)
    }
    XCTAssertTrue(choice.isHittable)
    XCTAssertTrue(anchor.isHittable)
    let y = anchor.frame.minY
    try await capture("reading-before", reading)
    choice.tap()
    XCTAssertTrue(reading.descendants(matching: .any).matching(identifier: "widget-answer-card-0").firstMatch.waitForExistence(timeout: 8))
    XCTAssertLessThan(abs(anchor.frame.minY - y), 2, "Answering a card must preserve the reader's position")
    try await capture("reading-after", reading)
    reading.terminate()
  }
  func testCustomAnswerUsesComposerAndRetainsRetryIdentity() async throws {
    let app = try await launch("multi")
    XCTAssertTrue(app.buttons["Primary"].waitForExistence(timeout: 8)); app.buttons["Primary"].tap()
    let field = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap(); field.typeText("Gamma")
    _ = try await api("/__audit/fail-once", [:])
    app.buttons["send-button"].tap()
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 10))
    app.alerts.buttons.firstMatch.tap()
    XCTAssertEqual(field.value as? String, "Gamma")
    app.buttons["send-button"].tap()
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "widget-answer-card-0").firstMatch.waitForExistence(timeout: 10))
    let state = try await api("/__audit/state")
    let receipts = try XCTUnwrap(state["receipts"] as? [[String: Any]])
    let bodies = receipts.compactMap { $0["body"] as? [String: Any] }
    XCTAssertEqual(bodies.count, 2)
    XCTAssertEqual(bodies.first?["value"] as? String, "primary\nGamma")
    XCTAssertEqual(bodies.first?["clientId"] as? String, bodies.last?["clientId"] as? String)
    XCTAssertFalse(receipts.contains { ($0["path"] as? String)?.hasSuffix("/messages") == true })
    try await capture("custom-answer", app)
    app.terminate()
  }
  func testCustomAnswerRecoversFromLostAcknowledgement() async throws {
    let app = try await launch("multi")
    let field = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    field.tap(); field.typeText("Gamma")
    _ = try await api("/__audit/lose-next-response", [:])
    app.buttons["send-button"].tap()
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 10))
    app.alerts.buttons.firstMatch.tap()
    XCTAssertEqual(field.value as? String, "Gamma")
    app.buttons["send-button"].tap()
    XCTAssertTrue(app.buttons["send-button"].waitForNonExistence(timeout: 10))
    XCTAssertFalse(app.alerts.firstMatch.exists)
    let state = try await api("/__audit/state")
    let receipts = try XCTUnwrap(state["receipts"] as? [[String: Any]])
    XCTAssertEqual(receipts.count, 2)
    XCTAssertEqual((receipts.first?["body"] as? [String: Any])?["clientId"] as? String,
      (receipts.last?["body"] as? [String: Any])?["clientId"] as? String)
    try await capture("lost-widget-ack-recovered", app)
    app.terminate()
  }
  func testSwipeReplyPageKeepsThreadContextAndDraft() async throws {
    let app = try await launch("reply")
    let rootText = "No facts in your memory match \"LANTERN914\" (0 searched). Try different words, or a shorter literal fragment."
    let root = app.staticTexts[rootText]
    XCTAssertTrue(root.waitForExistence(timeout: 8))
    let start = root.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.5))
    start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 120, dy: 0)))
    XCTAssertTrue(app.buttons["thread-back"].waitForExistence(timeout: 8))
    let field = app.descendants(matching: .any).matching(identifier: "thread-message-input").firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 8))
    XCTAssertFalse(app.buttons["conversation-details"].isHittable)
    XCTAssertFalse(app.buttons["Cancel reply"].exists)
    field.tap(); field.typeText("Unsent reply")
    app.buttons["thread-back"].tap()
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 8))
    root.press(forDuration: 0.6); app.buttons["Reply"].tap()
    XCTAssertTrue(app.buttons["thread-back"].waitForExistence(timeout: 8))
    XCTAssertEqual(field.value as? String, "Unsent reply")
    app.buttons["thread-send-button"].tap()
    XCTAssertTrue(app.staticTexts["Unsent reply"].waitForExistence(timeout: 8))
    _ = try await api("/__audit/bot-reply", ["replyTo": "root", "content": "Reply stayed in this thread."])
    XCTAssertTrue(app.staticTexts["Reply stayed in this thread."].waitForExistence(timeout: 8))
    try await capture("reply-page", app)
    let state = try await api("/__audit/state")
    let receipts = try XCTUnwrap(state["receipts"] as? [[String: Any]])
    let body = try XCTUnwrap(receipts.last?["body"] as? [String: Any])
    XCTAssertEqual(body["replyToMessageId"] as? String, "root")
    XCTAssertEqual(body["isFork"] as? Bool, true)
    app.buttons["thread-back"].tap()
    XCTAssertTrue(app.buttons["thread-root"].waitForExistence(timeout: 8))
    XCTAssertFalse(app.staticTexts["Unsent reply"].isHittable)
    XCTAssertFalse(app.staticTexts["Reply stayed in this thread."].isHittable)
    app.buttons["thread-root"].tap()
    XCTAssertTrue(app.staticTexts["Unsent reply"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.staticTexts["Reply stayed in this thread."].waitForExistence(timeout: 8))
    app.terminate()
  }
  func testThreadPushHasWorkingFeedbackAndNoSheetChrome() async throws {
    let app = try await launch("thread")
    XCTAssertTrue(app.buttons["thread-root"].waitForExistence(timeout: 8)); app.buttons["thread-root"].tap()
    XCTAssertTrue(app.buttons["thread-back"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "thread-loading").firstMatch.waitForNonExistence(timeout: 8))
    XCTAssertFalse(app.navigationBars["Thread"].exists)
    XCTAssertFalse(app.buttons["Done"].isHittable)
    XCTAssertTrue(app.staticTexts["DM here reply"].isHittable)
    _ = try await api("/__audit/activity", ["active": true])
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "bot-activity").firstMatch.waitForExistence(timeout: 10))
    try await capture("thread-working", app)
    let child = app.staticTexts["DM here reply"]
    child.press(forDuration: 0.6); app.buttons["Start a thread"].tap()
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "reply-page-reply").firstMatch.waitForExistence(timeout: 8))
    let field = app.descendants(matching: .any).matching(identifier: "thread-message-input").firstMatch
    field.tap(); field.typeText("Nested reply")
    app.buttons["thread-send-button"].tap()
    XCTAssertTrue(app.staticTexts["Nested reply"].waitForExistence(timeout: 10))
    let state = try await api("/__audit/state")
    let receipts = try XCTUnwrap(state["receipts"] as? [[String: Any]])
    let body = try XCTUnwrap(receipts.last?["body"] as? [String: Any])
    XCTAssertEqual(body["replyToMessageId"] as? String, "reply")
    XCTAssertEqual(body["isFork"] as? Bool, true)
    XCTAssertFalse(app.alerts.firstMatch.exists)
    app.buttons["thread-back"].tap()
    XCTAssertTrue(app.staticTexts["DM here reply"].waitForExistence(timeout: 8))
    try await capture("thread-return", app)
    app.terminate()
  }
  func testGroupAndReadOnlyExchange() async throws {
    for scene in ["group", "exchange", "markdown"] {
      let app = try await launch(scene)
      if scene == "exchange" {
        XCTAssertTrue(app.buttons["exchange-exchange-in"].waitForExistence(timeout: 8))
        app.buttons["exchange-exchange-in"].tap()
        XCTAssertTrue(app.buttons["exchange-back"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "exchange-read-only").firstMatch.waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["Close Chat"].exists)
        XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "message-input").firstMatch.isHittable)
      }
      try await capture(scene, app)
      XCTAssertFalse(app.alerts.firstMatch.exists)
      app.terminate()
    }
  }
  func testWaveformOpensExistingRecorder() async throws {
    let app = try await launch("voice")
    XCTAssertTrue(app.buttons["voice-input-button"].isHittable)
    app.buttons["voice-input-button"].tap()
    XCTAssertTrue(app.buttons["Stop recording"].waitForExistence(timeout: 8))
    app.buttons["Stop recording"].tap()
    XCTAssertTrue(app.buttons["Discard recording"].waitForExistence(timeout: 8))
    app.buttons["Discard recording"].tap()
    XCTAssertTrue(app.buttons["voice-input-button"].waitForExistence(timeout: 8))
    XCTAssertFalse(app.alerts.firstMatch.exists)
    app.terminate()
  }
  func testBotTapShowsCenteredNativeLoader() async throws {
    let app = try await launch("opening", home: true)
    app.buttons["channel-channel-research"].tap()
    let spinner = app.activityIndicators["chat-loading"]
    XCTAssertTrue(spinner.waitForExistence(timeout: 5))
    try await capture("loading", app)
    XCTAssertTrue(app.staticTexts["Hello"].waitForExistence(timeout: 15))
    XCTAssertTrue(spinner.waitForNonExistence(timeout: 15))
    try await capture("loaded", app)
    app.terminate()
  }
}
