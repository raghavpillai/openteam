import XCTest

/// Extra regression assertions for the November 10 reference review.
@MainActor final class InboxDeepQAUITests: XCTestCase {
  private let base = ProcessInfo.processInfo.environment["UI_FIXTURE_SERVER"] ?? "http://127.0.0.1:20053"

  private func state() async throws -> [String: Any] {
    let (data, _) = try await URLSession.shared.data(from: URL(string: base + "/__qa/state")!)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  private func launch() async throws -> XCUIApplication {
    continueAfterFailure = false
    var request = URLRequest(url: URL(string: base + "/__qa/scene")!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = Data(#"{"scene":"inbox-reference"}"#.utf8)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "dark"]
    app.launch()
    XCTAssertTrue(app.buttons["channel-inbox-0"].waitForExistence(timeout: 20))
    return app
  }

  private func capture(_ name: String, _ app: XCUIApplication) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "deep-" + name
    shot.lifetime = .keepAlways
    add(shot)
    let tree = XCTAttachment(string: app.debugDescription)
    tree.name = "deep-tree-" + name
    tree.lifetime = .keepAlways
    add(tree)
  }

  func testPullDownDoesNotRefreshOrLoseBackgroundActivity() async throws {
    let app = try await launch()
    let first = app.buttons["channel-inbox-0"]
    XCTAssertTrue(first.label.contains("Working"))
    capture("background-working", app)
    let before = try await state()
    let beforeRequests = (before["requests"] as? [[String: Any]] ?? [])
    let scroll = app.scrollViews["inbox-scroll"]
    let start = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.18))
    start.press(forDuration: 0.05,
      thenDragTo: start.withOffset(CGVector(dx: 0, dy: 210)),
      withVelocity: .slow, thenHoldForDuration: 0.5)
    try await Task.sleep(for: .milliseconds(800))
    XCTAssertEqual(app.activityIndicators.count, 0, "The inbox must not expose pull-to-refresh")
    XCTAssertTrue(first.label.contains("Working"))
    let after = try await state()
    let afterRequests = (after["requests"] as? [[String: Any]] ?? [])
    let bootstrapCount: ([[String: Any]]) -> Int = { requests in
      requests.filter { ($0["path"] as? String ?? "").contains("bootstrap") }.count
    }
    XCTAssertEqual(bootstrapCount(afterRequests), bootstrapCount(beforeRequests),
      "Pulling the inbox must not fetch bootstrap again")
    capture("after-pull-no-refresh", app)
  }

  func testLongTitleStaysCenteredAndLeavesRailReachable() async throws {
    let app = try await launch()
    let long = app.buttons["channel-inbox-8"]
    if !long.isHittable { app.scrollViews["inbox-scroll"].swipeUp() }
    XCTAssertTrue(long.waitForExistence(timeout: 5))
    XCTAssertTrue(long.label.contains("Sep 30"))
    capture("long-inbox-title-date", app)
    long.tap()
    let title = app.buttons["conversation-details"]
    XCTAssertTrue(title.waitForExistence(timeout: 8))
    let back = app.buttons["chat-back"], more = app.buttons["chat-more"]
    XCTAssertTrue(back.isHittable)
    XCTAssertTrue(more.isHittable)
    XCTAssertFalse(title.frame.intersects(more.frame))
    // The reference and UIKit's principal slot both center at x=201 on the
    // 466pt Duo outer display; the 382pt chat viewport centers at x=191.
    XCTAssertEqual(title.frame.midX, app.tables["chat-history"].frame.midX, accuracy: 12)
    capture("long-chat-header", app)
    more.tap()
    XCTAssertTrue(app.buttons["Conversation details"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Computer"].exists)
    capture("long-chat-more-computer", app)
  }

  func testTappingRevealedRowClosesActionsBeforeNavigation() async throws {
    let app = try await launch()
    let row = app.buttons["channel-inbox-0"]
    let start = row.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
    start.press(forDuration: 0.05,
      thenDragTo: start.withOffset(CGVector(dx: 105, dy: 0)),
      withVelocity: .slow, thenHoldForDuration: 0.2)
    XCTAssertTrue(app.buttons["conversation-swipe-mark-read"].waitForExistence(timeout: 5))
    row.tap()
    XCTAssertTrue(app.buttons["channel-inbox-1"].exists,
      "The first tap on a revealed row must dismiss its actions")
    XCTAssertFalse(app.buttons["conversation-swipe-mark-read"].exists)
    capture("swipe-dismissed-by-row-tap", app)
    row.tap()
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 5))
  }

  func testQuestionOptionsAndSwipeCancelPreserveButtons() async throws {
    let app = try await launch()
    let row = app.buttons["channel-inbox-1"]
    row.tap()
    XCTAssertTrue(app.buttons["Still on track"].waitForExistence(timeout: 8))
    // Decorative A–D badges are deliberately hidden from accessibility; inspect
    // them in the retained screenshot while asserting the actionable labels.
    for label in ["Still on track", "Delayed on customs", "Not proceeding", "I’ll handle it"] {
      XCTAssertTrue(app.buttons[label].isHittable, "Question option needs label \(label)")
    }
    XCTAssertTrue(app.buttons["I’ll handle it"].exists)
    capture("question-format", app)
    let origin = app.coordinate(withNormalizedOffset: .zero)
    let start = origin.withOffset(CGVector(dx: 22, dy: app.frame.height * 0.40))
    start.press(forDuration: 0.05,
      thenDragTo: origin.withOffset(CGVector(dx: app.frame.width * 0.24, dy: app.frame.height * 0.40)),
      withVelocity: .slow, thenHoldForDuration: 0.4)
    XCTAssertTrue(app.buttons["chat-back"].isHittable)
    XCTAssertTrue(app.buttons["chat-more"].isHittable)
    XCTAssertTrue(app.buttons["Still on track"].isHittable)
    capture("question-after-cancel", app)
    app.buttons["chat-back"].tap()
    XCTAssertTrue(app.buttons["search-button"].waitForExistence(timeout: 5))
    capture("rail-after-pop", app)
  }
}
