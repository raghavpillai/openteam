import XCTest

@MainActor final class EdgeBackUITests: XCTestCase {
  let base = "http://127.0.0.1:20043"
  func request(_ path: String, _ body: [String: Any] = [:], method: String = "POST") async throws {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }
  func launch(_ scene: String) async throws -> XCUIApplication {
    continueAfterFailure = false
    try await request("/__qa/reset")
    try await request("/__qa/content", ["scene": scene])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "dark", "--haptic-audit"]
    app.launch()
    openChat(app)
    return app
  }
  func openChat(_ app: XCUIApplication) {
    let channel = app.buttons["channel-channel-research"]
    XCTAssertTrue(channel.waitForExistence(timeout: 15)); channel.tap()
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 8))
  }
  func capture(_ name: String, _ app: XCUIApplication) {
    let image = XCTAttachment(screenshot: app.screenshot()); image.name = "edge-" + name; image.lifetime = .keepAlways; add(image)
    let tree = XCTAttachment(string: app.debugDescription); tree.name = "edge-tree-" + name; tree.lifetime = .keepAlways; add(tree)
  }
  func row(_ app: XCUIApplication) -> XCUIElement {
    let value = app.descendants(matching: .any).matching(identifier: "message-content-fixture").firstMatch
    XCTAssertTrue(value.waitForExistence(timeout: 10)); return value
  }
  func drag(_ app: XCUIApplication, x: CGFloat, y: CGFloat, endX: CGFloat, velocity: XCUIGestureVelocity = .slow) {
    let origin = app.coordinate(withNormalizedOffset: .zero)
    origin.withOffset(CGVector(dx: x, dy: y)).press(forDuration: 0.05,
      thenDragTo: origin.withOffset(CGVector(dx: endX, dy: y)), withVelocity: velocity, thenHoldForDuration: velocity == .fast ? 0 : 0.3)
  }
  func assertBack(_ app: XCUIApplication, name: String) {
    let home = app.buttons["channel-channel-research"].waitForExistence(timeout: 6)
    capture(name, app)
    XCTAssertTrue(home, "The edge gesture must navigate back instead of claiming the message")
    XCTAssertFalse(app.buttons["Cancel reply"].exists)
    XCTAssertFalse(app.buttons["photo-close"].exists)
    XCTAssertFalse(app.buttons["file-preview-close"].exists)
  }
  func testEdgeSwipeOverTextUsesBack() async throws {
    let app = try await launch("edge-text")
    for x: CGFloat in [22, 3, 32] {
      drag(app, x: x, y: row(app).frame.midY, endX: app.frame.width * 0.85)
      assertBack(app, name: "text-back-\(Int(x))")
      openChat(app)
      XCTAssertFalse(app.buttons["Cancel reply"].exists)
    }
    app.terminate()
  }
  func testExactScreenEdgeUsesBack() async throws {
    let app = try await launch("edge-text")
    drag(app, x: 3, y: row(app).frame.midY, endX: app.frame.width * 0.85)
    assertBack(app, name: "exact-edge")
    app.terminate()
  }
  // End well past UIKit's completion boundary. A fast synthetic drag ending at
  // 85% of the screen intermittently cancels even in an unmodified NavigationStack.
  func testFastEdgeSwipeOverText() async throws {
    let app = try await launch("edge-text")
    drag(app, x: 22, y: row(app).frame.midY, endX: app.frame.width * 0.95, velocity: .fast)
    assertBack(app, name: "fast-text")
    app.terminate()
  }
  func testFastEdgeSwipeOverPhoto() async throws {
    let app = try await launch("edge-photo")
    drag(app, x: 22, y: row(app).frame.midY, endX: app.frame.width * 0.95, velocity: .fast)
    assertBack(app, name: "fast-photo")
    app.terminate()
  }
  func testEdgeCancellationHasNoMessageHapticButReplyDoes() async throws {
    let app = try await launch("edge-text")
    try await request("/__qa/haptics", method: "DELETE")
    drag(app, x: 22, y: row(app).frame.midY, endX: app.frame.width * 0.24)
    try await Task.sleep(for: .milliseconds(600))
    XCTAssertFalse(app.buttons["Cancel reply"].exists)
    let (before, _) = try await URLSession.shared.data(from: URL(string: base + "/__qa/haptics")!)
    let beforeEvents = try XCTUnwrap(JSONSerialization.jsonObject(with: before) as? [[String: Any]])
    XCTAssertFalse(beforeEvents.contains { ($0["source"] as? String ?? "").hasPrefix("message.") })
    drag(app, x: 80, y: row(app).frame.midY, endX: 235)
    XCTAssertTrue(app.buttons["Cancel reply"].waitForExistence(timeout: 5))
    let (after, _) = try await URLSession.shared.data(from: URL(string: base + "/__qa/haptics")!)
    let afterEvents = try XCTUnwrap(JSONSerialization.jsonObject(with: after) as? [[String: Any]])
    XCTAssertTrue(afterEvents.contains { ($0["source"] as? String) == "message.reply-swipe" && ($0["emitted"] as? Bool) == true })
    app.terminate()
  }
  func testEdgeSwipeOverAttachmentsWithAndWithoutKeyboard() async throws {
    for scene in ["edge-photo", "edge-file"] {
      for keyboard in [false, true] {
        let app = try await launch(scene)
        let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
        if keyboard {
          input.tap(); input.typeText("Keep this draft")
          XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        }
        drag(app, x: 22, y: row(app).frame.midY, endX: app.frame.width * 0.95, velocity: .fast)
        assertBack(app, name: scene + (keyboard ? "-keyboard" : "-back"))
        openChat(app)
        XCTAssertFalse(app.buttons["Cancel reply"].exists)
        if keyboard { XCTAssertEqual(input.value as? String, "Keep this draft") }
        app.terminate()
      }
    }
  }
  func testCanceledEdgeSwipeDoesNotBecomeReply() async throws {
    for keyboard in [false, true] {
      let app = try await launch("edge-text")
      let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
      if keyboard { input.tap(); input.typeText("Draft survives canceled back") }
      drag(app, x: 22, y: row(app).frame.midY, endX: app.frame.width * 0.24)
      try await Task.sleep(for: .milliseconds(600))
      XCTAssertTrue(app.buttons["chat-back"].exists)
      XCTAssertFalse(app.buttons["Cancel reply"].exists)
      XCTAssertFalse(app.buttons["Reply"].exists)
      if keyboard { XCTAssertEqual(input.value as? String, "Draft survives canceled back") }
      capture(keyboard ? "canceled-with-keyboard" : "canceled", app)
      drag(app, x: 22, y: row(app).frame.midY, endX: app.frame.width * 0.85)
      assertBack(app, name: "back-after-cancel")
      app.terminate()
    }
  }
  func testInteriorMessageSwipesAndHoldsStillWork() async throws {
    for scene in ["edge-text", "edge-photo", "edge-file"] {
      let app = try await launch(scene)
      drag(app, x: 80, y: row(app).frame.midY, endX: 235)
      XCTAssertTrue(app.buttons["Cancel reply"].waitForExistence(timeout: 5))
      capture(scene + "-reply", app)
      app.buttons["Cancel reply"].tap()
      app.terminate(); app.launch(); openChat(app)
      row(app).press(forDuration: 0.8)
      XCTAssertTrue(app.buttons["Reply"].waitForExistence(timeout: 5))
      capture(scene + "-hold", app)
      app.terminate()
    }
  }
  func testVerticalEdgeScrollKeepsChatOpen() async throws {
    let app = try await launch("media")
    let photo = app.buttons["attachment-" + String(repeating: "6", count: 64)]
    XCTAssertTrue(photo.waitForExistence(timeout: 10))
    let before = photo.frame.minY
    let origin = app.coordinate(withNormalizedOffset: .zero)
    origin.withOffset(CGVector(dx: 22, dy: app.frame.height * 0.4)).press(forDuration: 0.05,
      thenDragTo: origin.withOffset(CGVector(dx: 22, dy: app.frame.height * 0.7)),
      withVelocity: .slow, thenHoldForDuration: 0.3)
    XCTAssertTrue(app.buttons["chat-back"].exists)
    XCTAssertFalse(app.buttons["Cancel reply"].exists)
    XCTAssertGreaterThan(photo.frame.minY, before + 50)
    capture("vertical-scroll", app)
    app.terminate()
  }
  func testAttachmentTapsAndReturnFromPreviewStillWork() async throws {
    for (scene, digit, close) in [("edge-photo", "6", "photo-close"), ("edge-file", "9", "file-preview-close")] {
      let app = try await launch(scene)
      let attachment = app.buttons["attachment-" + String(repeating: digit, count: 64)]
      XCTAssertTrue(attachment.waitForExistence(timeout: 10))
      attachment.tap()
      XCTAssertTrue(app.buttons[close].waitForExistence(timeout: 10))
      app.buttons[close].tap()
      XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 5))
      drag(app, x: 22, y: row(app).frame.midY, endX: app.frame.width * 0.85)
      assertBack(app, name: scene + "-after-preview")
      app.terminate()
    }
  }
  func testRepeatedProfileAndChatBackDoesNotDisableNavigation() async throws {
    let app = try await launch("edge-text")
    for index in 0..<3 {
      app.buttons["conversation-details"].tap()
      XCTAssertTrue(app.textFields["profile-name"].waitForExistence(timeout: 5))
      drag(app, x: 22, y: app.frame.height * 0.45, endX: app.frame.width * 0.85)
      XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 5))
      drag(app, x: 22, y: row(app).frame.midY, endX: app.frame.width * 0.85)
      assertBack(app, name: "repeat-\(index)")
      // No back destination on home: an edge drag must not wedge the next push.
      drag(app, x: 3, y: app.frame.height * 0.45, endX: app.frame.width * 0.7)
      openChat(app)
    }
    app.terminate()
  }
}
