import XCTest

/// Run separately, on the same idle simulator/device and configuration before and
/// after a change. Simulator results are comparative, not an iPhone FPS guarantee.
@MainActor
final class MessagePerformanceUITests: XCTestCase {
  private var server: String {
    ProcessInfo.processInfo.environment["MESSAGE_PERFORMANCE_SERVER"] ?? "http://127.0.0.1:19996"
  }

  func history(_ scene: String, layoutGeometry: Bool = false, scrollGeometry: Bool = false) async throws -> XCUIApplication {
    continueAfterFailure = false
    let base = server
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
    if layoutGeometry { app.launchArguments.append("--ui-testing-layout-geometry") }
    if scrollGeometry { app.launchArguments.append("--ui-testing-scroll-geometry") }
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
    if scene.hasPrefix("performance-") {
      // Initial history positioning and document heights settle asynchronously.
      // Keep this outside the measured interval so a transient Latest button
      // cannot disappear between XCTest's existence check and tap.
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
    app.tables["chat-history"].swipeDown()
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

  func testMarkdownResizesAcrossViewportWidths() async throws {
    let app = try await history("performance-rich", layoutGeometry: true)
    defer { XCUIDevice.shared.orientation = .portrait }
    func geometry() throws -> CGRect {
      let value = try XCTUnwrap(app.tables["chat-history"].value as? String)
      let documents = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(value.utf8)) as? [[String: Any]])
      let document = try XCTUnwrap(documents.last)
      XCTAssertEqual(document["ready"] as? Bool, true)
      return CGRect(x: 0, y: try XCTUnwrap(document["y"] as? Double),
        width: try XCTUnwrap(document["width"] as? Double),
        height: try XCTUnwrap(document["height"] as? Double))
    }
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-loading")
      .firstMatch.waitForNonExistence(timeout: 15))
    let portrait = try geometry()
    XCTAssertGreaterThan(portrait.height, 80)
    XCUIDevice.shared.orientation = .landscapeLeft
    try await Task.sleep(for: .seconds(3))
    let landscape = try geometry()
    XCTAssertGreaterThan(landscape.width, portrait.width + 50)
    XCTAssertGreaterThan(landscape.height, 80)
    XCTAssertLessThanOrEqual(landscape.height, portrait.height + 8,
      "A wider document must not adopt a stale inflated height")
    XCTAssertFalse(app.buttons["Latest messages"].exists)
    XCUIDevice.shared.orientation = .portrait
    try await Task.sleep(for: .seconds(3))
    let restored = try geometry()
    XCTAssertEqual(restored.height, portrait.height, accuracy: 8)
    XCTAssertFalse(app.buttons["Latest messages"].exists)
    let measurements = XCTAttachment(string: "portrait=\(portrait), landscape=\(landscape), restored=\(restored)")
    measurements.name = "markdown-viewport-geometry"
    measurements.lifetime = .keepAlways
    add(measurements)
    let capture = XCTAttachment(screenshot: app.screenshot())
    capture.name = "markdown-after-viewport-width-roundtrip"
    capture.lifetime = .keepAlways
    add(capture)
  }

  func testMixedDocumentScrolling() async throws {
    scroll(try await history("performance-rich"))
  }

  func testComposerTapsAfterRichHistoryWindowChanges() async throws {
    let app = try await history("performance-rich")
    let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    for pass in 0..<2 {
      let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.35))
      for _ in 0..<6 {
        from.press(forDuration: 0.02,
          thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.78)),
          withVelocity: .fast, thenHoldForDuration: 0)
      }
      let latest = app.buttons["Latest messages"]
      XCTAssertTrue(latest.isHittable)
      latest.tap()
      input.tap()
      XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "The first composer tap must focus")
      input.typeText("Tap \(pass) ")
      XCTAssertTrue((input.value as? String)?.contains("Tap \(pass)") == true)
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.3)).tap()
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    }
  }

  func testReplyQuoteNavigatesToDistantHistory() async throws {
    let app = try await history("performance-text")
    let targetID = "visual-message-visual-chat-11"
    var request = URLRequest(
      url: URL(string: server + "/api/v0/channels/visual-chat/messages")!)
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
    let mainQuoteY = quote.frame.minY
    quote.tap()
    XCTAssertTrue(app.buttons["thread-back"].waitForExistence(timeout: 8))
    let target = app.otherElements["message-" + targetID].firstMatch
    XCTAssertTrue(target.waitForExistence(timeout: 8))
    XCTAssertTrue(target.isHittable)
    XCTAssertTrue(app.staticTexts["A quote to distant history"].isHittable)
    // A quoted message opens focused reply context. The main timeline keeps
    // its reading position instead of scrolling back through 989 messages.
    app.buttons["thread-back"].tap()
    XCTAssertTrue(quote.waitForExistence(timeout: 8))
    XCTAssertTrue(quote.isHittable)
    XCTAssertEqual(quote.frame.minY, mainQuoteY, accuracy: 8)
    XCTAssertFalse(app.buttons["Latest messages"].exists)
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
    // A SwiftUI accessibility wrapper can briefly report a zero frame when
    // the row reconfigures. The native cell owns its transcript position.
    let cell = app.tables["chat-history"].cells.containing(.any, identifier: identifier).firstMatch
    let beforeFrame = cell.frame
    XCTAssertGreaterThan(beforeFrame.height, 0)
    var request = URLRequest(
      url: URL(string: server + "/api/v0/channels/visual-chat/messages")!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: [
      "content": "Arrived while reading earlier messages", "clientId": UUID().uuidString,
    ])
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    try await Task.sleep(for: .seconds(3))
    let afterFrame = cell.frame
    XCTAssertGreaterThan(afterFrame.height, 0)
    XCTAssertTrue(app.tables["chat-history"].frame.intersects(afterFrame))
    XCTAssertEqual(afterFrame.minY, beforeFrame.minY, accuracy: 8,
      "Incoming messages should not move the reading position")
    XCTAssertEqual(afterFrame.height, beforeFrame.height, accuracy: 8,
      "Incoming messages should not resize the message being read")
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
      app.tables["chat-history"].swipeDown()
    }
    XCTAssertTrue(earlier.isHittable)
    let anchor = app.staticTexts["Page message 121"]
    XCTAssertTrue(anchor.exists)
    XCTAssertGreaterThan(anchor.frame.height, 0)
    XCTAssertTrue(app.tables["chat-history"].frame.intersects(anchor.frame))
    let oldY = anchor.frame.minY
    let before = XCTAttachment(screenshot: app.screenshot())
    before.name = "history-before-prepend"; before.lifetime = .keepAlways; add(before)
    earlier.tap()
    try await Task.sleep(for: .seconds(2))
    // This is a reading-position assertion, not a tap target. UIKit can report
    // no activation point for a noninteractive hosted label after reconfiguration.
    XCTAssertTrue(anchor.exists)
    XCTAssertGreaterThan(anchor.frame.height, 0)
    XCTAssertTrue(app.tables["chat-history"].frame.intersects(anchor.frame))
    XCTAssertEqual(
      anchor.frame.minY, oldY, accuracy: 8, "Prepending a page moved the current message")
    let after = XCTAttachment(screenshot: app.screenshot())
    after.name = "history-after-prepend"; after.lifetime = .keepAlways; add(after)
    app.buttons["Latest messages"].tap()
    XCTAssertTrue(app.staticTexts["Page message 180"].waitForExistence(timeout: 8))
    XCTAssertFalse(app.buttons["Latest messages"].exists)
  }

  private struct ScrollRow: Codable {
    let id: String
    let y: Double
    let height: Double
    var number: Int? { Int(id.split(separator: "-").last ?? "") }
  }
  private struct ScrollFrame: Codable {
    let rows: [ScrollRow]
    let mounted: Int
    let offset: Double
    let following: Bool
    let moving: Bool
    let viewportTop: Double
    let viewportBottom: Double
    var messages: [ScrollRow] { rows.filter { $0.number != nil } }
  }
  private func scrollFrame(_ app: XCUIApplication) throws -> ScrollFrame {
    let value = try XCTUnwrap(app.tables["chat-history"].value as? String)
    let frame = try JSONDecoder().decode(ScrollFrame.self, from: Data(value.utf8))
    XCTAssertLessThanOrEqual(frame.mounted, 80, "Native history window must stay bounded")
    XCTAssertFalse(frame.messages.isEmpty, "Scrolling exposed an empty transcript")
    for (previous, next) in zip(frame.rows, frame.rows.dropFirst()) {
      XCTAssertLessThanOrEqual(previous.y + previous.height, next.y + 1, "Rows overlap")
      if let a = previous.number, let b = next.number {
        XCTAssertEqual(b, a + 1, "Visible transcript skipped or reordered messages")
      }
    }
    return frame
  }
  private func stableScrollFrame(_ app: XCUIApplication) async throws -> ScrollFrame {
    var previous = try scrollFrame(app)
    // XCTest can return while a fast swipe is still decelerating.
    for _ in 0..<40 {
      if !previous.moving { break }
      try await Task.sleep(for: .milliseconds(150))
      previous = try scrollFrame(app)
    }
    XCTAssertFalse(previous.moving, "Scroll never settled")
    for _ in 0..<3 {
      try await Task.sleep(for: .milliseconds(150))
      let next = try scrollFrame(app)
      if next.messages.map(\.id) != previous.messages.map(\.id) {
        let geometry = XCTAttachment(data: try JSONEncoder().encode([previous, next]), uniformTypeIdentifier: "public.json")
        geometry.name = "unexpected-idle-geometry"; geometry.lifetime = .keepAlways; add(geometry)
      }
      // A sub-point edge sliver can enter/leave the viewport without a reading
      // position change. Apply the same 1pt tolerance to visibility and position.
      for (frame, other) in [(previous, next), (next, previous)] {
        for row in frame.messages where !other.messages.contains(where: { $0.id == row.id }) {
          let visible = min(row.y + row.height, frame.viewportBottom) - max(row.y, frame.viewportTop)
          XCTAssertLessThanOrEqual(visible, 1, "Idle transcript changed a visible message")
        }
      }
      for a in previous.messages {
        guard let b = next.messages.first(where: { $0.id == a.id }) else { continue }
        XCTAssertEqual(a.y, b.y, accuracy: 1, "Reading position drifted after the gesture")
        XCTAssertEqual(a.height, b.height, accuracy: 1, "A visible row resized after settling")
      }
      previous = next
    }
    return previous
  }
  private func stressScroll(_ app: XCUIApplication, phases: [(Bool, Bool, Int)], name: String) async throws {
    var evidence: [[String: Any]] = []
    let first = try await stableScrollFrame(app)
    var oldest = try XCTUnwrap(first.messages.first?.number)
    var newest = try XCTUnwrap(first.messages.last?.number)
    for (older, fast, count) in phases {
      for iteration in 0..<count {
        let before = try scrollFrame(app)
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.72, dy: older ? 0.32 : 0.75))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.72, dy: older ? 0.75 : 0.32))
        if fast {
          if older { app.tables["chat-history"].swipeDown(velocity: .fast) }
          else { app.tables["chat-history"].swipeUp(velocity: .fast) }
        } else {
          from.press(forDuration: 0.02, thenDragTo: to,
            withVelocity: .slow, thenHoldForDuration: 0.1)
        }
        let frame = try await stableScrollFrame(app)
        let low = try XCTUnwrap(frame.messages.first?.number)
        let high = try XCTUnwrap(frame.messages.last?.number)
        let oldLow = try XCTUnwrap(before.messages.first?.number)
        if older { XCTAssertLessThanOrEqual(low, oldLow + 1, "Upward history browsing moved toward newer messages") }
        else { XCTAssertGreaterThanOrEqual(low, oldLow - 1, "Downward browsing moved toward older messages") }
        oldest = min(oldest, low); newest = max(newest, high)
        evidence.append(["older": older, "fast": fast, "iteration": iteration,
          "first": low, "last": high, "offset": frame.offset, "mounted": frame.mounted])
        let load = app.buttons[older ? "Load earlier messages" : "Load later messages"]
        if load.exists && load.isHittable {
          let anchor = try XCTUnwrap(frame.messages.first)
          load.tap()
          try await Task.sleep(for: .milliseconds(400))
          let loaded = try await stableScrollFrame(app)
          if !loaded.messages.contains(where: { $0.id == anchor.id }) {
            let geometry = XCTAttachment(data: try JSONEncoder().encode([frame, loaded]), uniformTypeIdentifier: "public.json")
            geometry.name = "unexpected-pagination-geometry"; geometry.lifetime = .keepAlways; add(geometry)
          }
          let retained = try XCTUnwrap(loaded.messages.first { $0.id == anchor.id })
          // Removing a timestamp can shrink the row; preserve its message bottom.
          XCTAssertEqual(retained.y + retained.height, anchor.y + anchor.height, accuracy: 8)
        }
      }
    }
    let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: evidence, options: .prettyPrinted), uniformTypeIdentifier: "public.json")
    attachment.name = name + "-scroll-geometry"; attachment.lifetime = .keepAlways; add(attachment)
    XCTAssertGreaterThan(newest - oldest, 60, "Stress test did not traverse enough history")
    let capture = XCTAttachment(screenshot: app.screenshot())
    capture.name = name + "-finished"; capture.lifetime = .keepAlways; add(capture)
  }
  func testFastSlowAndReversingLongTextHistory() async throws {
    let app = try await history("performance-text", scrollGeometry: true)
    defer { app.terminate() }
    try await stressScroll(app, phases: [(true, true, 24), (true, false, 6),
      (false, true, 8), (true, false, 3), (false, false, 3), (true, true, 4), (false, true, 4)], name: "text")
  }
  func testFastSlowAndReversingRichHistory() async throws {
    let app = try await history("performance-rich", scrollGeometry: true)
    defer { app.terminate() }
    try await stressScroll(app, phases: [(true, true, 24), (true, false, 6),
      (false, true, 8), (true, false, 3), (false, false, 3), (true, true, 4), (false, true, 4)], name: "rich")
  }
  func testFastSlowAndReversingMixedMediaHistory() async throws {
    // WebKit documents, diagrams, photos, files, cards and replies size
    // asynchronously or differ from estimates; none may move settled rows.
    let app = try await history("scroll-mixed", scrollGeometry: true)
    defer { app.terminate() }
    try await stressScroll(app, phases: [(true, true, 16), (true, false, 6),
      (false, true, 8), (true, false, 3), (false, false, 3), (true, true, 4), (false, true, 4)], name: "mixed")
  }

  func testIncomingDocumentsAtLatestEndWithTheLatestMessage() async throws {
    let app = try await history("scroll-mixed")
    let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch
      .waitForNonExistence(timeout: 15))
    for round in 1...3 {
      // A reply that arrives while the chat is open or reopened from a
      // notification: its document sizes during or after the scroll to it.
      for content in [
        "## Deploy \(round)\n\n- API is healthy\n- Worker restarted\n- Cache warmed\n\n| Region | Status |\n| --- | --- |\n| us-west | Ready |",
        "Follow-up \(round) after the deploy.",
      ] {
        var request = URLRequest(url: URL(string: server + "/__qa/motion")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["content": content])
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
      }
      let latest = app.staticTexts["Follow-up \(round) after the deploy."]
      XCTAssertTrue(latest.waitForExistence(timeout: 10))
      try await Task.sleep(for: .seconds(2))
      XCTAssertLessThanOrEqual(latest.frame.maxY, input.frame.minY,
        "The latest message must end above the composer after its document sizes")
      XCTAssertFalse(app.buttons["Latest messages"].exists)
    }
  }

  func testSearchResultCanBrowseOlderAndNewerHistory() async throws {
    let app = try await history("performance-text", scrollGeometry: true)
    defer { app.terminate() }
    app.buttons["chat-back"].tap()
    app.buttons["search-button"].tap()
    let field = app.textFields["search-input"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.typeText("History item 500.")
    let result = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "History item 500.")).firstMatch
    XCTAssertTrue(result.waitForExistence(timeout: 10))
    result.tap()
    XCTAssertTrue(app.tables["chat-history"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch.waitForNonExistence(timeout: 15))
    let frame = try await stableScrollFrame(app)
    XCTAssertTrue(frame.messages.contains { $0.number == 500 }, "Search did not reveal its target")
    try await stressScroll(app, phases: [(true, true, 8), (false, true, 16),
      (true, false, 4), (false, false, 4), (true, true, 4)], name: "search")
  }

  func testUnloadedSearchResultCanBrowseBothPageBoundaries() async throws {
    let app = try await history("history-pages", scrollGeometry: true)
    defer { app.terminate() }
    app.buttons["chat-back"].tap()
    app.buttons["search-button"].tap()
    let field = app.textFields["search-input"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.typeText("Page message 80")
    let result = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Page message 80")).firstMatch
    XCTAssertTrue(result.waitForExistence(timeout: 10))
    result.tap()
    XCTAssertTrue(app.tables["chat-history"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch.waitForNonExistence(timeout: 15))
    let frame = try await stableScrollFrame(app)
    XCTAssertTrue(frame.messages.contains { $0.number == 80 }, "Search did not reveal its target")
    try await stressScroll(app, phases: [(true, true, 16), (false, true, 32),
      (true, false, 4), (false, false, 4), (true, true, 4)], name: "paged-search")
  }

}
