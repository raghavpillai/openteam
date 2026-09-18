import XCTest

/// Run separately, on the same idle simulator/device and configuration before and
/// after a change. Simulator results are comparative, not an iPhone FPS guarantee.
@MainActor
final class MessagePerformanceUITests: XCTestCase {
  func history(_ scene: String) async throws -> XCUIApplication {
    continueAfterFailure = false
    let base = "http://127.0.0.1:19996"
    var request = URLRequest(url: URL(string: base + "/__qa/scene")!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: ["scene": scene])
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--server", base, "--appearance", "dark",
      "--open-channel", "visual-chat",
    ]
    let start = Date()
    app.launch()
    XCTAssertTrue(
      app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
        .waitForExistence(timeout: 90))
    let ready = Date().timeIntervalSince(start)
    let attachment = XCTAttachment(
      string: "{\"scene\":\"\(scene)\",\"launchToComposerSeconds\":\(ready)}")
    attachment.name = scene + "-readiness.json"
    attachment.lifetime = .keepAlways
    add(attachment)
    if scene == "performance-rich" {
      // The bundled document renderers publish their heights asynchronously.
      // Settle before the measured interval so an initial transient Latest
      // button cannot disappear between XCTest's existence check and tap.
      try await Task.sleep(for: .seconds(3))
      XCTAssertFalse(app.buttons["Latest messages"].exists)
    }
    return app
  }

  func scroll(_ app: XCUIApplication) {
    let options = XCTMeasureOptions()
    options.iterationCount = 3
    options.invocationOptions = [.manuallyStart, .manuallyStop]
    measure(
      metrics: [
        XCTClockMetric(), XCTCPUMetric(application: app),
        XCTMemoryMetric(application: app),
        XCTOSSignpostMetric.scrollingAndDecelerationMetric,
      ], options: options
    ) {
      // Restore the same starting point outside the measured interval.
      let latest = app.buttons["Latest messages"]
      if latest.exists { latest.tap() }
      let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.35))
      let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.78))
      startMeasuring()
      for _ in 0..<6 {
        from.press(
          forDuration: 0.02, thenDragTo: to, withVelocity: .fast,
          thenHoldForDuration: 0)
      }
      stopMeasuring()
    }
    XCTAssertTrue(app.buttons["Latest messages"].exists)
    app.buttons["Latest messages"].tap()
    let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    input.tap()
    input.typeText("Still responsive after scrolling")
    XCTAssertEqual(input.value as? String, "Still responsive after scrolling")
    XCTAssertTrue(app.buttons["chat-back"].isHittable)
    let capture = XCTAttachment(screenshot: app.screenshot())
    capture.name = "history-after-scroll-and-typing"
    capture.lifetime = .keepAlways
    add(capture)
  }

  func testThousandMessageScrolling() async throws {
    scroll(try await history("performance-text"))
  }

  func testTallMessageKeyboardScrollingRemainsResponsive() async throws {
    executionTimeAllowance = 90
    let app = try await history("long")
    app.scrollViews.firstMatch.swipeDown()
    let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.6))
    from.press(
      forDuration: 0.05,
      thenDragTo: from.withOffset(CGVector(dx: 0, dy: -131)),
      withVelocity: .slow, thenHoldForDuration: 0.3)
    let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    input.tap()
    input.typeText("Responsive tall messages")
    XCTAssertEqual(input.value as? String, "Responsive tall messages")
    XCTAssertLessThanOrEqual(input.frame.maxY, app.keyboards.firstMatch.frame.minY)
  }

  func testMixedDocumentScrolling() async throws {
    scroll(try await history("performance-rich"))
  }

  func testReplyQuoteNavigatesToDistantHistory() async throws {
    let app = try await history("performance-text")
    let targetID = "visual-message-visual-chat-11"
    var request = URLRequest(
      url: URL(string: "http://127.0.0.1:19996/api/v0/channels/visual-chat/messages")!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: [
      "content": "A quote to distant history", "clientId": UUID().uuidString,
      "replyToMessageId": targetID,
    ])
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    let quote = app.buttons.matching(
      NSPredicate(format: "identifier BEGINSWITH %@", "reply-quote-")
    ).firstMatch
    XCTAssertTrue(quote.waitForExistence(timeout: 10))
    quote.tap()
    let target = app.otherElements["message-" + targetID].firstMatch
    XCTAssertTrue(target.waitForExistence(timeout: 8))
    XCTAssertTrue(target.isHittable)
    XCTAssertTrue(app.buttons["Latest messages"].exists)
  }

  func testRichHistoryAnchorsAndIncomingMessagesWhileReading() async throws {
    let app = try await history("performance-rich")
    let latest = app.buttons["Latest messages"]
    // WebKit reports its real document height asynchronously. Opening a chat
    // must stay at the latest message through those updates.
    try await Task.sleep(for: .seconds(3))
    XCTAssertFalse(latest.exists, "Document layout displaced the latest message")
    let origin = app.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.35))
    origin.press(
      forDuration: 0.02, thenDragTo: origin.withOffset(CGVector(dx: 0, dy: 420)),
      withVelocity: .slow, thenHoldForDuration: 0.1)
    XCTAssertTrue(latest.waitForExistence(timeout: 5))
    try await Task.sleep(for: .seconds(1))
    let rows = app.descendants(matching: .any).matching(
      NSPredicate(format: "identifier BEGINSWITH %@", "message-visual-message-visual-chat-"))
    let anchor = try XCTUnwrap(
      rows.allElementsBoundByIndex.reversed().first {
        $0.frame.midY > 200 && $0.frame.midY < 650 && $0.isHittable
      })
    let identifier = anchor.identifier
    let y = anchor.frame.minY
    var request = URLRequest(
      url: URL(string: "http://127.0.0.1:19996/api/v0/channels/visual-chat/messages")!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: [
      "content": "Arrived while reading earlier messages", "clientId": UUID().uuidString,
    ])
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    try await Task.sleep(for: .seconds(3))
    XCTAssertEqual(
      app.descendants(matching: .any).matching(identifier: identifier).firstMatch.frame.minY, y,
      accuracy: 8,
      "Incoming messages should not move the reading position")
    XCTAssertTrue(latest.exists)
    latest.tap()
    XCTAssertTrue(
      app.staticTexts["Arrived while reading earlier messages"].waitForExistence(timeout: 8))
    let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    input.tap()
    input.typeText("Draft with keyboard open")
    XCTAssertLessThanOrEqual(input.frame.maxY, app.keyboards.firstMatch.frame.minY)
    XCTAssertFalse(latest.exists)
  }

  func testLoadingEarlierPagePreservesTheVisibleMessage() async throws {
    let app = try await history("history-pages")
    let earlier = app.buttons["Load earlier messages"]
    for _ in 0..<12 {
      if earlier.exists && earlier.isHittable { break }
      app.scrollViews.firstMatch.swipeDown()
    }
    XCTAssertTrue(earlier.isHittable)
    let anchor = app.staticTexts["Page message 121"]
    XCTAssertTrue(anchor.isHittable)
    let oldY = anchor.frame.minY
    earlier.tap()
    try await Task.sleep(for: .seconds(2))
    XCTAssertTrue(anchor.isHittable)
    XCTAssertEqual(
      anchor.frame.minY, oldY, accuracy: 8, "Prepending a page moved the current message")
    app.buttons["Latest messages"].tap()
    XCTAssertTrue(app.staticTexts["Page message 180"].waitForExistence(timeout: 8))
    XCTAssertFalse(app.buttons["Latest messages"].exists)
  }
}
