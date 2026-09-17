import XCTest

/// Native material captures and section/navigation regression checks against an inert server.
@MainActor final class GlassSectionsUITests: XCTestCase {
  let base = "http://127.0.0.1:20038"

  @discardableResult func request(
    _ path: String, _ body: [String: Any]? = nil, method: String = "POST"
  ) async throws -> [String: Any] {
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

  func launch(_ appearance: String = "dark", channel: String? = nil) -> XCUIApplication {
    continueAfterFailure = false
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", appearance]
    if let channel { app.launchArguments += ["--open-channel", channel] }
    app.launch()
    XCTAssertTrue(
      app.buttons[channel == nil ? "settings-button" : "chat-back"].waitForExistence(timeout: 15))
    return app
  }

  func capture(_ name: String, _ app: XCUIApplication) {
    Thread.sleep(forTimeInterval: 0.8)
    let image = XCTAttachment(screenshot: app.screenshot())
    image.name = "glass-" + name
    image.lifetime = .keepAlways
    add(image)
    let tree = XCTAttachment(string: app.debugDescription)
    tree.name = "glass-tree-" + name
    tree.lifetime = .keepAlways
    add(tree)
  }

  func testGlassOverEmptyBackgroundAndScrolledMessagesInBothThemes() async throws {
    for theme in ["dark", "light"] {
      try await request("/__qa/scene", ["scene": "dark-chat-seven"])
      let app = launch(theme, channel: "visual-chat")
      XCTAssertTrue(app.staticTexts["Got it — here."].waitForExistence(timeout: 10))
      capture(theme + "-resting", app)
      let point = app.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.5))
      point.press(
        forDuration: 0.05, thenDragTo: point.withOffset(CGVector(dx: 0, dy: 210)),
        withVelocity: .slow, thenHoldForDuration: 0.5)
      XCTAssertTrue(app.buttons["Latest messages"].waitForExistence(timeout: 5))
      capture(theme + "-scrolled", app)
      app.buttons["conversation-details"].tap()
      XCTAssertTrue(app.textFields["profile-name"].waitForExistence(timeout: 5))
      capture(theme + "-details", app)
      app.collectionViews.firstMatch.swipeUp()
      capture(theme + "-details-scrolled", app)
      XCTAssertFalse(app.buttons["Memory"].exists)
      app.terminate()
    }
  }

  func testNoSectionsIgnoresStaleCollapseAndOrphanAssignment() async throws {
    try await request("/__qa/reset", [:])
    try await request(
      "/api/v0/settings/sidebar",
      [
        "version": 2, "sections": [], "pinnedIds": [], "unreadIds": [],
        "unassignedCollapsed": true, "sectionByChannel": ["channel-research": "deleted-section"],
        "channelOrderByGroup": [:],
      ], method: "PATCH")
    let app = launch()
    XCTAssertTrue(app.buttons["channel-channel-research"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["section-unassigned"].exists)
    XCTAssertFalse(app.staticTexts["Unassigned"].exists)
    capture("home-without-sections", app)
  }

  func testSectionLongPressRenameCollapseDeletePreservesConversations() async throws {
    try await request("/__qa/reset", [:])
    try await request(
      "/api/v0/settings/sidebar",
      [
        "version": 2, "sections": [["id": "work", "name": "Work", "collapsed": false]],
        "pinnedIds": [], "unreadIds": [], "unassignedCollapsed": false,
        "sectionByChannel": ["channel-research": "work"], "channelOrderByGroup": [:],
      ], method: "PATCH")
    let app = launch()
    let section = app.buttons["section-work"]
    XCTAssertTrue(section.waitForExistence(timeout: 5))
    section.press(forDuration: 0.8)
    XCTAssertTrue(app.buttons["Rename"].waitForExistence(timeout: 5))
    capture("section-menu", app)
    app.buttons["Rename"].tap()
    let field = app.alerts.textFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.tap()
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 4) + "Projects")
    app.alerts.buttons["Save"].tap()
    XCTAssertTrue(app.buttons["Projects section"].waitForExistence(timeout: 5))
    section.press(forDuration: 0.8)
    app.buttons["Collapse"].tap()
    XCTAssertTrue(app.buttons["channel-channel-research"].waitForNonExistence(timeout: 5))
    section.press(forDuration: 0.8)
    app.buttons["Expand"].tap()
    XCTAssertTrue(app.buttons["channel-channel-research"].waitForExistence(timeout: 5))
    section.press(forDuration: 0.8)
    app.buttons["Delete section"].tap()
    app.buttons["Delete section"].tap()
    XCTAssertTrue(section.waitForNonExistence(timeout: 5))
    XCTAssertFalse(app.buttons["section-unassigned"].exists)
    XCTAssertTrue(app.buttons["channel-channel-research"].exists)
    let state = try await request("/__qa/state", method: "GET")
    let settings = try XCTUnwrap(state["settings"] as? [String: Any])
    XCTAssertEqual((settings["sections"] as? [Any])?.count, 0)
    XCTAssertEqual((settings["sectionByChannel"] as? [String: String])?.count, 0)
    XCTAssertFalse((state["channels"] as? [Any] ?? []).isEmpty)
    capture("section-deleted-chats-kept", app)
  }

  func testDetailsPushSupportsEdgeBackAndInstructionEdits() async throws {
    try await request("/__qa/scene", ["scene": "dark-chat-seven"])
    let app = launch(channel: "visual-chat")
    app.buttons["conversation-details"].tap()
    XCTAssertTrue(app.textFields["profile-name"].waitForExistence(timeout: 5))
    // A native navigation push supports the interactive left-edge pop.
    let left = app.coordinate(withNormalizedOffset: CGVector(dx: 0.001, dy: 0.45))
    left.press(
      forDuration: 0.05,
      thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.45)),
      withVelocity: .slow, thenHoldForDuration: 0.2)
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.textFields["profile-name"].exists)
    app.buttons["conversation-details"].tap()
    XCTAssertTrue(app.textFields["profile-name"].waitForExistence(timeout: 5))
    let instructions = app.buttons["Instructions"]
    for _ in 0..<4 where !instructions.isHittable { app.collectionViews.firstMatch.swipeUp() }
    instructions.tap()
    XCTAssertTrue(app.textViews["profile-instructions"].waitForExistence(timeout: 5))
    app.textViews["profile-instructions"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    try await Task.sleep(for: .milliseconds(500))
    // Let each key event settle; a bulk XCTest typing burst can drop a key on
    // this simulator while the predictive keyboard updates its suggestions.
    for character in "Keep it concise." {
      app.textViews["profile-instructions"].typeText(String(character))
    }
    XCTAssertEqual(app.textViews["profile-instructions"].value as? String, "Keep it concise.")
    app.navigationBars.buttons["Details"].tap()
    app.buttons["profile-save"].tap()
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 8))
    let state = try await request("/__qa/state", method: "GET")
    let bots = try XCTUnwrap(state["bots"] as? [[String: Any]])
    XCTAssertEqual(bots.first?["instructions"] as? String, "Keep it concise.")
    let requests = state["requests"] as? [[String: Any]] ?? []
    XCTAssertFalse(requests.contains { ($0["path"] as? String ?? "").contains("/memories") })
  }
}
