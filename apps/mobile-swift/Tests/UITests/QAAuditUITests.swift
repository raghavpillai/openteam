import XCTest

/// Optional diagnostic suite. Its failing assertions document open product defects.
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
    XCTAssertTrue(app.buttons["Reply"].waitForExistence(timeout: 2), "QA-02: Attachment hold has no message-action entry point.")
  }
  func testSwipingAnAttachmentStartsInlineReply() async throws {
    let app = try await launch("attachment")
    let attachment = app.buttons["Open Fixture image.png"]
    XCTAssertTrue(attachment.waitForExistence(timeout: 10))
    let start = attachment.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
    start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 150, dy: 0)))
    capture("attachment-swipe", app)
    XCTAssertTrue(app.buttons["Cancel reply"].waitForExistence(timeout: 2), "QA-02: Attachment swipe cannot select an inline reply.")
  }
  func testExistingThreadHasVisibleEntryPoint() async throws {
    let app = try await launch("thread")
    XCTAssertTrue(app.staticTexts["QA thread root"].waitForExistence(timeout: 10))
    capture("missing-thread-entry", app)
    XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label CONTAINS[c] 'repl' OR label CONTAINS[c] 'thread'")).firstMatch.exists, "QA-03: An existing thread is hidden without a reply count or Open thread control.")
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
    XCTAssertFalse(app.staticTexts["QA thread root"].exists, "QA-04: The offered Start a thread action calls an empty closure; the original thread remains unchanged.")
  }
  func testSearchOpensTheMatchingThreadReply() async throws {
    let app = try await launch("thread", openChat: false)
    app.buttons["search-button"].tap()
    let field = app.textFields["search-input"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.typeText("QA")
    let result = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "QA search result")).firstMatch
    XCTAssertTrue(result.waitForExistence(timeout: 10))
    result.tap()
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 10))
    capture("thread-search-wrong-destination", app)
    XCTAssertTrue(app.staticTexts["QA hidden thread reply"].exists, "QA-05: Search scrolls a filtered-out reply ID instead of opening its thread.")
  }
  func testRoutineSearchOpensTheRoutine() async throws {
    let app = try await launch("routine-search", openChat: false)
    app.buttons["search-button"].tap()
    let field = app.textFields["search-input"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.typeText("QA")
    let result = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "QA search result")).firstMatch
    XCTAssertTrue(result.waitForExistence(timeout: 10))
    result.tap()
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 10))
    capture("routine-search-wrong-destination", app)
    XCTAssertTrue(app.textFields["routine-name"].exists, "QA-06: Routine search discards the routine ID and opens chat.")
  }
}
