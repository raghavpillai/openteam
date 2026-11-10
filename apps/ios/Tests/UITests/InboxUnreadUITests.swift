import XCTest

/// Run against the inert parity server on its own port: SWIFT_PARITY_PORT=20055.
@MainActor final class InboxUnreadUITests: XCTestCase {
  private let base = ProcessInfo.processInfo.environment["UI_FIXTURE_SERVER"] ?? "http://127.0.0.1:20055"

  @discardableResult private func request(
    _ path: String, body: [String: Any]? = nil, method: String = "POST"
  ) async throws -> [String: Any] {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = method
    if let body {
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  private func launch(_ appearance: String = "dark") -> XCUIApplication {
    continueAfterFailure = false
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", appearance]
    app.launch()
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 20))
    return app
  }

  private func assertChips(_ app: XCUIApplication, above: Int, below: Int,
    file: StaticString = #filePath, line: UInt = #line) {
    for (direction, count) in [("above", above), ("below", below)] {
      let chip = app.buttons["inbox-unread-" + direction]
      let predicate = count == 0 ? NSPredicate(format: "exists == false")
        : NSPredicate(format: "exists == true AND label == %@", "\(count) unread \(direction)")
      let expectation = XCTNSPredicateExpectation(predicate: predicate, object: chip)
      XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 15), .completed,
        "Expected \(count) unread \(direction); tree: \(app.debugDescription)", file: file, line: line)
      if count > 0 { XCTAssertTrue(chip.isHittable, file: file, line: line) }
    }
  }

  private func capture(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func assertNoReadRequests() async throws {
    let state = try await request("/__qa/state", method: "GET")
    let requests = try XCTUnwrap(state["requests"] as? [[String: Any]])
    XCTAssertFalse(requests.contains { ($0["path"] as? String)?.hasSuffix("/read") == true })
    let channels = try XCTUnwrap(state["channels"] as? [[String: Any]])
    for id in ["unread-0", "unread-28", "unread-43"] {
      XCTAssertEqual(channels.first { $0["id"] as? String == id }?["unreadCount"] as? Int, 3)
    }
    let settings = try XCTUnwrap(state["settings"] as? [String: Any])
    XCTAssertEqual(settings["unreadIds"] as? [String], ["unread-14"])
  }

  func testVisibleUnreadAndPartiallyVisibleUnreadDoNotShowChipsInBothThemes() async throws {
    for appearance in ["light", "dark"] {
      try await request("/__qa/scene", body: ["scene": "inbox-reference"])
      let app = launch(appearance)
      let row = app.buttons["channel-inbox-0"]
      XCTAssertTrue(row.waitForExistence(timeout: 10))
      XCTAssertTrue(row.label.contains("Unread"), "Visible unread rows retain their unread dot")
      assertChips(app, above: 0, below: 0)
      let initialFrame = row.frame
      let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
      start.press(forDuration: 0.05,
        thenDragTo: start.withOffset(CGVector(dx: 0, dy: -initialFrame.height * 0.65)),
        withVelocity: .slow, thenHoldForDuration: 0.5)
      XCTAssertLessThan(row.frame.minY, initialFrame.minY)
      XCTAssertGreaterThan(row.frame.maxY, initialFrame.minY,
        "The unread row must still intersect the top of the viewport")
      assertChips(app, above: 0, below: 0)
      capture("inbox-unread-partial-" + appearance, app)
      app.terminate()
    }
  }

  func testDirectionalCountsAndNearestJumpsDoNotMarkRead() async throws {
    try await request("/__qa/scene", body: ["scene": "inbox-unread"])
    let app = launch()
    defer { app.terminate() }
    assertChips(app, above: 0, below: 3)
    capture("inbox-unread-below", app)
    for (id, above, below) in [(14, 1, 2), (28, 2, 1), (43, 3, 0)] {
      app.buttons["inbox-unread-below"].tap()
      assertChips(app, above: above, below: below)
      XCTAssertTrue(app.buttons["channel-unread-\(id)"].isHittable)
      XCTAssertTrue(app.buttons["channel-unread-\(id)"].label.contains("Unread"))
      capture("inbox-unread-jump-\(id)", app)
    }
    for (id, above, below) in [(28, 2, 1), (14, 1, 2), (0, 0, 3)] {
      app.buttons["inbox-unread-above"].tap()
      assertChips(app, above: above, below: below)
      XCTAssertTrue(app.buttons["channel-unread-\(id)"].isHittable)
    }
    XCTAssertFalse(app.buttons["chat-back"].exists)
    try await assertNoReadRequests()
  }

  func testCollapsedUnreadRowsAreExcludedAndPinsUseVerticalStrip() async throws {
    try await request("/__qa/scene", body: ["scene": "inbox-unread"])
    try await request("/api/v0/settings/sidebar", body: [
      "version": 2, "pinnedIds": ["unread-0"], "unreadIds": ["unread-14"],
      "sections": [["id": "hidden", "name": "Hidden", "collapsed": true]],
      "sectionByChannel": ["unread-43": "hidden"], "unassignedCollapsed": false,
      "channelOrderByGroup": ["unassigned": (1..<43).map { "unread-\($0)" }],
    ], method: "PATCH")
    let app = launch()
    defer { app.terminate() }
    XCTAssertTrue(app.buttons["pinned-unread-0"].isHittable)
    assertChips(app, above: 0, below: 2)
    app.buttons["inbox-unread-below"].tap()
    assertChips(app, above: 1, below: 1)
    XCTAssertTrue(app.buttons["channel-unread-14"].isHittable)
    app.buttons["inbox-unread-below"].tap()
    assertChips(app, above: 2, below: 0)
    XCTAssertTrue(app.buttons["channel-unread-28"].isHittable)
    app.buttons["inbox-unread-above"].tap()
    assertChips(app, above: 1, below: 1)
    app.buttons["inbox-unread-above"].tap()
    assertChips(app, above: 0, below: 2)
    XCTAssertTrue(app.buttons["pinned-unread-0"].isHittable)
    try await assertNoReadRequests()
  }
}
