import XCTest

/// Regression checks for the conversation audit defects.
/// Requires audit-proxy.ts on 20010 and its own parity-server.ts on 20011.
@MainActor final class QAAuditUITests: XCTestCase {
  let base = "http://127.0.0.1:20010"
  func launch(_ scene: String, openChat: Bool = true) async throws -> XCUIApplication {
    continueAfterFailure = false
    var request = URLRequest(url: URL(string: base + "/__audit/reset")!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: ["scene": scene])
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "light"]
    app.launch()
    XCTAssertTrue(app.buttons["channel-channel-research"].waitForExistence(timeout: 15))
    if openChat { app.buttons["channel-channel-research"].tap() }
    return app
  }
  func capture(_ name: String, _ app: XCUIApplication) {
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "audit-" + name
    screenshot.lifetime = .keepAlways
    add(screenshot)
    let tree = XCTAttachment(string: app.debugDescription)
    tree.name = "audit-" + name + "-accessibility"
    tree.lifetime = .keepAlways
    add(tree)
  }
  func testHoldingAnAttachmentOffersReply() async throws {
    let app = try await launch("attachment")
    let attachment = app.buttons["Open Fixture image.png"]
    XCTAssertTrue(attachment.waitForExistence(timeout: 10))
    attachment.press(forDuration: 0.8)
    capture("attachment-hold", app)
    XCTAssertTrue(
      app.buttons["Reply"].waitForExistence(timeout: 2),
      "QA-02: Attachment hold has no message-action entry point.")
  }
  func testSwipingAnAttachmentStartsInlineReply() async throws {
    let app = try await launch("attachment")
    let attachment = app.buttons["Open Fixture image.png"]
    XCTAssertTrue(attachment.waitForExistence(timeout: 10))
    let start = attachment.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
    start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 150, dy: 0)))
    capture("attachment-swipe", app)
    XCTAssertTrue(
      app.buttons["Cancel reply"].waitForExistence(timeout: 2),
      "QA-02: Attachment swipe cannot select an inline reply.")
  }
  func testExistingThreadHasVisibleEntryPoint() async throws {
    let app = try await launch("thread")
    XCTAssertTrue(app.staticTexts["QA thread root"].waitForExistence(timeout: 10))
    capture("missing-thread-entry", app)
    XCTAssertTrue(
      app.buttons.containing(
        NSPredicate(format: "label CONTAINS[c] 'repl' OR label CONTAINS[c] 'thread'")
      ).firstMatch.exists,
      "QA-03: An existing thread is hidden without a reply count or Open thread control.")
  }
  func testStartThreadInsideThreadDoesSomething() async throws {
    let app = try await launch("thread")
    let root = app.staticTexts["QA thread root"]
    XCTAssertTrue(root.waitForExistence(timeout: 10))
    root.press(forDuration: 0.7)
    app.buttons["Start a thread"].tap()
    XCTAssertTrue(app.staticTexts["QA hidden thread reply"].waitForExistence(timeout: 5))
    app.staticTexts["QA hidden thread reply"].press(forDuration: 0.7)
    app.buttons["Start a thread"].tap()
    capture("nested-thread-no-op", app)
    // A nested root quotes its parent, and the underlying chat remains in the accessibility tree.
    // The pushed thread must have its own back control, then return to the parent thread.
    let back = app.navigationBars["Thread"].buttons["BackButton"]
    XCTAssertTrue(back.waitForExistence(timeout: 5))
    XCTAssertTrue(
      app.descendants(matching: .any).matching(identifier: "message-audit-reply").firstMatch.exists)
    // Entering a thread selects its root by default; clear it to prove the swipe changes state.
    app.buttons["Cancel reply"].tap()
    XCTAssertFalse(app.buttons["Cancel reply"].exists)
    let reply = app.staticTexts["QA hidden thread reply"]
    let interior = reply.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.5))
    interior.press(forDuration: 0.05, thenDragTo: interior.withOffset(CGVector(dx: 110, dy: 0)))
    XCTAssertTrue(app.buttons["Cancel reply"].waitForExistence(timeout: 5))
    app.buttons["Cancel reply"].tap()
    let edge = app.coordinate(withNormalizedOffset: .zero).withOffset(
      CGVector(dx: 3, dy: reply.frame.midY))
    edge.press(
      forDuration: 0.05, thenDragTo: edge.withOffset(CGVector(dx: app.frame.width * 0.92, dy: 0)),
      withVelocity: .slow, thenHoldForDuration: 0)
    XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 5))
    XCTAssertTrue(back.waitForNonExistence(timeout: 5))
    capture("nested-thread-edge-back", app)
  }
  func testSearchOpensTheMatchingThreadReply() async throws {
    let app = try await launch("thread", openChat: false)
    app.buttons["search-button"].tap()
    let field = app.textFields["search-input"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.typeText("QA")
    let result = app.buttons.containing(
      NSPredicate(format: "label CONTAINS %@", "QA search result")
    ).firstMatch
    XCTAssertTrue(result.waitForExistence(timeout: 10))
    result.tap()
    XCTAssertTrue(app.staticTexts["QA hidden thread reply"].waitForExistence(timeout: 10))
    capture("thread-search-wrong-destination", app)
    XCTAssertTrue(
      app.staticTexts["QA hidden thread reply"].exists,
      "QA-05: Search scrolls a filtered-out reply ID instead of opening its thread.")
  }
  func testRoutineSearchOpensTheRoutine() async throws {
    let app = try await launch("routine-search", openChat: false)
    app.buttons["search-button"].tap()
    let field = app.textFields["search-input"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.typeText("QA")
    let result = app.buttons.containing(
      NSPredicate(format: "label CONTAINS %@", "QA search result")
    ).firstMatch
    XCTAssertTrue(result.waitForExistence(timeout: 10))
    result.tap()
    XCTAssertTrue(app.textFields["routine-name"].waitForExistence(timeout: 10))
    capture("routine-search-wrong-destination", app)
    XCTAssertTrue(
      app.textFields["routine-name"].exists,
      "QA-06: Routine search discards the routine ID and opens chat.")
  }
  func testLinkSearchOpensTheActualURL() async throws {
    let app = try await launch("link-search", openChat: false)
    app.buttons["search-button"].tap()
    let field = app.textFields["search-input"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.typeText("QA")
    let result = app.buttons.containing(
      NSPredicate(format: "label CONTAINS %@", "QA search result")
    ).firstMatch
    XCTAssertTrue(result.waitForExistence(timeout: 10))
    result.tap()
    let browser = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
    XCTAssertTrue(browser.wait(for: .runningForeground, timeout: 10))
    XCTAssertTrue(browser.staticTexts["Isolated search destination"].waitForExistence(timeout: 10))
    let receipt = try await control("/__audit/receipt")
    XCTAssertGreaterThan(receipt["linkVisits"] as? Int ?? 0, 0)
    app.activate()
  }
  func control(_ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
    var request = URLRequest(url: URL(string: base + path)!)
    if let body {
      request.httpMethod = "POST"
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
  func testChromeSelectionAndExecutionReceipts() async throws {
    let app = try await launch("approval")
    let site = app.switches["approval-site-Profile 2-example.com"]
    XCTAssertTrue(site.waitForExistence(timeout: 10))
    site.tap()
    app.buttons["approve-qa-chrome"].tap()
    XCTAssertTrue(app.staticTexts["Running"].waitForExistence(timeout: 10))
    let receipt = try await control("/__audit/receipt")
    let details = (receipt["approval"] as? [String: Any])?["details"] as? [String: Any]
    XCTAssertEqual(
      Set(details?["selectedItems"] as? [String] ?? []),
      Set(["[\"Profile 1\",\"example.com\"]", "[\"Profile 2\",\"docs.example.com\"]"]))
    _ = try await control("/__audit/action-state", ["state": "completed"])
    XCTAssertTrue(app.staticTexts["Completed"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["approve-qa-chrome"].exists)
    capture("completed-approval-receipt", app)
    _ = try await control("/__audit/action-state", ["state": "failed"])
    XCTAssertTrue(app.staticTexts["Failed"].waitForExistence(timeout: 10))
    capture("failed-approval-receipt", app)
  }
  func testAutoReviewRulesSaveAndReload() async throws {
    let app = try await launch("rules", openChat: false)
    app.buttons["settings-button"].tap()
    let more = app.buttons["More preferences"]
    for _ in 0..<7 where !more.isHittable { app.swipeUp() }
    more.tap()
    app.buttons["Auto-review rules"].tap()
    let existing = app.textFields["review-allow-0"]
    XCTAssertTrue(existing.waitForExistence(timeout: 8))
    app.buttons["Add allow rule"].tap()
    let added = app.textFields["review-allow-1"]
    added.tap()
    added.typeText("Inspect QA logs")
    let save = app.buttons["save-review-rules"]
    for _ in 0..<5 where !save.isHittable { app.swipeUp() }
    save.tap()
    let policy = try await control("/__audit/receipt")["policy"] as? [String: Any]
    XCTAssertEqual(
      policy?["allowInstructions"] as? [String], ["Read public documentation", "Inspect QA logs"])
    app.buttons["Reload saved rules"].tap()
    XCTAssertEqual(added.value as? String, "Inspect QA logs")
    capture("saved-auto-review-rules", app)
  }

}
