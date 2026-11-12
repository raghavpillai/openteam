import XCTest

@MainActor final class InboxReferenceUITests: XCTestCase {
  private let base = ProcessInfo.processInfo.environment["UI_FIXTURE_SERVER"] ?? "http://127.0.0.1:20053"

  @discardableResult private func request(_ path: String, _ body: [String: Any]? = nil,
    method: String = "POST") async throws -> [String: Any] {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = method
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  private func launch(_ appearance: String = "dark") async throws -> XCUIApplication {
    continueAfterFailure = false
    try await request("/__qa/scene", ["scene": "inbox-reference"])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", appearance]
    app.launch()
    XCTAssertTrue(app.buttons["channel-inbox-0"].waitForExistence(timeout: 20))
    return app
  }

  private func capture(_ name: String, _ app: XCUIApplication) {
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "inbox-reference-" + name
    screenshot.lifetime = .keepAlways
    add(screenshot)
    let tree = XCTAttachment(string: app.debugDescription)
    tree.name = "inbox-tree-" + name
    tree.lifetime = .keepAlways
    add(tree)
  }

  private func drag(_ row: XCUIElement, _ distance: CGFloat) {
    let start = row.coordinate(withNormalizedOffset: CGVector(dx: distance > 0 ? 0.2 : 0.8, dy: 0.5))
    start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: distance, dy: 0)),
      withVelocity: .slow, thenHoldForDuration: 0.15)
  }

  func testReferenceRowsDatesActivityAndQuestionPresentation() async throws {
    let app = try await launch()
    let first = app.buttons["channel-inbox-0"]
    let question = app.buttons["channel-inbox-1"]
    XCTAssertTrue(first.label.contains("Are my replies showing up for you?"))
    XCTAssertTrue(first.label.contains("Working"))
    XCTAssertTrue(question.label.contains("What should I draft for Jayne?"))
    XCTAssertTrue(question.label.contains("Waiting for your answer"))
    XCTAssertTrue(app.buttons["channel-inbox-2"].label.contains("Nov 2"))
    XCTAssertTrue(app.buttons["channel-inbox-3"].label.contains("Sep 30"))
    XCTAssertEqual(first.frame.height, 80, accuracy: 1)
    XCTAssertEqual(question.frame.minY - first.frame.minY, 80, accuracy: 1)
    capture("home-dark", app)
    question.tap()
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["Still on track"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["Delayed on customs"].exists)
    XCTAssertTrue(app.buttons["Not proceeding"].exists)
    capture("question-dark", app)
    app.chatBackButton.tap()
    XCTAssertTrue(first.waitForExistence(timeout: 8))
    capture("returned-home", app)
    try await request("/__qa/update-message", ["id": "visual-message-inbox-1-2",
      "metadata": ["respondedValue": "on-track"]])
    let cleared = XCTNSPredicateExpectation(predicate: NSPredicate(format:
      "NOT (label CONTAINS %@)", "Waiting for your answer"), object: question)
    await fulfillment(of: [cleared], timeout: 8)
  }

  func testBidirectionalSwipeReadPinAndFullSwipeUnread() async throws {
    let app = try await launch()
    let row = app.buttons["channel-inbox-0"]
    drag(row, 105)
    let read = app.buttons["conversation-swipe-mark-read"]
    XCTAssertTrue(read.waitForExistence(timeout: 5))
    capture("swipe-read", app)
    read.tap()
    let readState = XCTNSPredicateExpectation(predicate: NSPredicate(format:
      "NOT (label CONTAINS %@)", "Unread"), object: row)
    await fulfillment(of: [readState], timeout: 8)
    drag(row, -105)
    let pin = app.buttons["conversation-swipe-pin"]
    XCTAssertTrue(pin.waitForExistence(timeout: 5))
    capture("swipe-pin", app)
    pin.tap()
    let pinned = app.buttons["pinned-inbox-0"]
    XCTAssertTrue(pinned.waitForExistence(timeout: 8))
    if !pinned.isHittable { app.scrollViews["inbox-scroll"].swipeDown() }
    pinned.press(forDuration: 0.8)
    XCTAssertTrue(app.buttons["Unpin"].waitForExistence(timeout: 5))
    app.buttons["Unpin"].tap()
    XCTAssertTrue(row.waitForExistence(timeout: 8))
    drag(row, row.frame.width * 0.72)
    let unreadState = XCTNSPredicateExpectation(predicate: NSPredicate(format:
      "label CONTAINS %@", "Unread"), object: row)
    await fulfillment(of: [unreadState], timeout: 8)
    let state = try await request("/__qa/state", method: "GET")
    let settings = try XCTUnwrap(state["settings"] as? [String: Any])
    XCTAssertTrue((settings["unreadIds"] as? [String] ?? []).contains("inbox-0"))
    capture("full-swipe-unread", app)
  }

  func testReferenceLightAppearanceAndMoreMenu() async throws {
    let app = try await launch("light")
    capture("home-light", app)
    app.buttons["channel-inbox-2"].tap()
    XCTAssertTrue(app.buttons["chat-more"].waitForExistence(timeout: 10))
    app.buttons["chat-more"].tap()
    XCTAssertTrue(app.buttons["Conversation details"].waitForExistence(timeout: 5))
    capture("more-light", app)
  }

  func testNativeBackCancellationPreservesInteriorReplySwipe() async throws {
    continueAfterFailure = false
    try await request("/__qa/reset", [:])
    try await request("/__qa/content", ["scene": "edge-text"])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "dark"]
    app.launch()
    let channel = app.buttons["channel-channel-research"]
    XCTAssertTrue(channel.waitForExistence(timeout: 15))
    channel.tap()
    let row = app.descendants(matching: .any).matching(identifier: "message-content-fixture").firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 15))
    XCTAssertTrue(app.otherElements["chat-loading"].waitForNonExistence(timeout: 15))
    XCTAssertTrue(app.chatBackButton.waitForExistence(timeout: 8))
    let origin = app.coordinate(withNormalizedOffset: .zero)
    let edge = origin.withOffset(CGVector(dx: 22, dy: row.frame.midY))
    edge.press(forDuration: 0.05,
      thenDragTo: origin.withOffset(CGVector(dx: app.frame.width * 0.24, dy: row.frame.midY)),
      withVelocity: .slow, thenHoldForDuration: 0.3)
    XCTAssertTrue(app.chatBackButton.waitForExistence(timeout: 8))
    XCTAssertTrue(row.exists, "A cancelled pop must keep the conversation visible")
    XCTAssertFalse(app.buttons["thread-back"].exists)
    capture("cancelled-native-back", app)
    let interior = origin.withOffset(CGVector(dx: 80, dy: row.frame.midY))
    interior.press(forDuration: 0.05, thenDragTo: interior.withOffset(CGVector(dx: 160, dy: 0)),
      withVelocity: .slow, thenHoldForDuration: 0.2)
    // Current main replies inline; preserve that behavior after a cancelled pop.
    XCTAssertTrue(app.buttons["Cancel reply"].waitForExistence(timeout: 8))
    XCTAssertFalse(app.buttons["thread-back"].exists)
    app.buttons["Cancel reply"].tap()
    XCTAssertTrue(app.chatBackButton.exists)
    app.chatBackButton.tap()
    XCTAssertTrue(app.buttons["channel-channel-research"].waitForExistence(timeout: 8))
  }
}
