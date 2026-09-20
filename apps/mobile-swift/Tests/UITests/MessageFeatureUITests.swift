import XCTest

@MainActor final class MessageFeatureUITests: XCTestCase {
  private let base = "http://127.0.0.1:19997"
  @discardableResult private func control(_ path: String, _ body: [String: Any] = [:]) async throws -> [String: Any] {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (data, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
  }
  private func launch(_ scene: String, visual: Bool = false, appearance: String = "dark") async throws -> XCUIApplication {
    continueAfterFailure = false
    try await control("/__qa/reset")
    try await control(visual ? "/__qa/scene" : "/__qa/content", ["scene": scene])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", appearance,
      "--open-channel", visual ? "visual-chat" : "channel-research", "--qa-session", UUID().uuidString]
    app.launch()
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 20))
    let loading = app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch
    XCTAssertTrue(loading.waitForNonExistence(timeout: 20), "History never finished positioning")
    return app
  }
  private func capture(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
  }
  func testShortAndEmptyChatsStartAtBottomWithoutAStuckSpinner() async throws {
    for scene in ["empty-chat", "dark-chat"] {
      let app = try await launch(scene, visual: true)
      XCTAssertFalse(app.buttons["Latest messages"].exists)
      let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
      XCTAssertTrue(input.isEnabled)
      if scene == "dark-chat" { XCTAssertTrue(app.staticTexts["Got it — here."].isHittable) }
      capture(scene + "-native-timeline", app)
      app.terminate()
    }
  }
  func testDraftPersistsWhenLeavingAndReopeningChat() async throws {
    let app = try await launch("edge-text")
    let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    input.tap(); input.typeText("Keep this unsent draft")
    app.buttons["chat-back"].tap()
    let research = app.buttons["channel-channel-research"]
    XCTAssertTrue(research.waitForExistence(timeout: 5))
    research.tap()
    XCTAssertTrue(input.waitForExistence(timeout: 5))
    XCTAssertEqual(input.value as? String, "Keep this unsent draft")
    capture("restored-chat-draft", app)
    app.buttons["chat-back"].tap()
    app.terminate()
    app.launch()
    XCTAssertTrue(input.waitForExistence(timeout: 20))
    XCTAssertEqual(input.value as? String, "Keep this unsent draft", "The draft must survive a process relaunch")
  }
  func testReactionCountsAndOwnSelectionToggleIndependently() async throws {
    let app = try await launch("reactions")
    let thumbs = app.buttons["reaction-content-fixture-👍"]
    XCTAssertTrue(thumbs.waitForExistence(timeout: 5))
    XCTAssertEqual(thumbs.label, "👍, 2 reactions")
    XCTAssertEqual(thumbs.value as? String, "Selected")
    thumbs.tap()
    let changed = expectation(for: NSPredicate(format: "label == %@ AND value == %@", "👍, 1 reactions", "Not selected"), evaluatedWith: thumbs)
    await fulfillment(of: [changed], timeout: 8)
    XCTAssertTrue(app.buttons["reaction-content-fixture-❤️"].exists)
    capture("reaction-counts-and-selection", app)
  }
  func testExchangeIsNavigableAndViewOnly() async throws {
    let app = try await launch("exchange")
    XCTAssertFalse(app.staticTexts["Outgoing exchange payload"].exists)
    app.buttons["exchange-exchange-in"].tap()
    XCTAssertTrue(app.buttons["exchange-close"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.staticTexts["This chat is view-only"].exists)
    XCTAssertTrue(app.staticTexts["Incoming exchange payload"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Outgoing exchange payload"].exists)
    XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "message-input").firstMatch.exists)
    capture("bot-exchange-view-only", app)
    app.buttons["exchange-close"].tap()
    XCTAssertTrue(app.buttons["exchange-exchange-in"].waitForExistence(timeout: 5))
  }
  func testGroupSpeakerIdentityInBothAppearances() async throws {
    for mode in ["light", "dark"] {
      let app = try await launch("group-speakers", appearance: mode)
      XCTAssertTrue(app.buttons["speaker-content-fixture"].waitForExistence(timeout: 5))
      XCTAssertEqual(app.buttons["speaker-content-fixture"].label, "Ops")
      capture("group-speaker-" + mode, app)
      app.buttons["speaker-content-fixture"].tap()
      XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.staticTexts["Ops"].exists)
      app.terminate()
    }
  }
  func testCanonicalSecretMetadataAndSafeFormReceipt() async throws {
    var app = try await launch("secret-canonical")
    XCTAssertTrue(app.staticTexts["Deployment token"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["DEPLOY_TOKEN"].exists)
    XCTAssertTrue(app.staticTexts["Saved securely for you"].exists)
    capture("canonical-secret-request", app)
    app.terminate()
    app = try await launch("secret-bot")
    XCTAssertTrue(app.staticTexts["Shared bot token"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Saved for all users of this Bot"].exists)
    XCTAssertTrue(app.staticTexts["Provided securely"].exists)
    app.terminate()
    app = try await launch("form-receipt")
    XCTAssertTrue(app.staticTexts["Held for recovery"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Filled"].exists)
    XCTAssertFalse(app.staticTexts["NEVER_RENDER_EMAIL"].exists)
    XCTAssertFalse(app.staticTexts["NEVER_RENDER_SECRET"].exists)
    XCTAssertTrue(app.buttons["Open computer"].exists)
    capture("safe-form-receipt", app)
  }
  func testFormEscalationOpensComputerOnlyAfterAcceptedAction() async throws {
    let app = try await launch("form")
    let escalate = app.buttons["form-escalate"]
    XCTAssertTrue(escalate.waitForExistence(timeout: 5))
    escalate.tap()
    XCTAssertTrue(app.buttons["Computer help"].waitForExistence(timeout: 10))
    let (data, _) = try await URLSession.shared.data(from: URL(string: base + "/__qa/state")!)
    let state = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    let messages = try XCTUnwrap(state["messages"] as? [[String: Any]])
    let message = try XCTUnwrap(messages.first { $0["id"] as? String == "content-fixture" })
    XCTAssertEqual((message["metadata"] as? [String: Any])?["cardState"] as? String, "escalated")
    capture("form-escalation-computer", app)
  }
  func testRoutineEventOpensTheReferencedEditor() async throws {
    let app = try await launch("routine-event")
    app.buttons["routine-event-content-fixture"].tap()
    XCTAssertTrue(app.textFields["routine-name"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.textFields["routine-name"].value as? String, "Morning summary")
    capture("routine-event-destination", app)
  }
  func testFocusedExchangeMessageOpensTheReadOnlyConversation() async throws {
    let app = try await launch("exchange")
    app.open(URL(string: "openteam-swift://chat/channel-research?messageId=exchange-in")!)
    XCTAssertTrue(app.buttons["exchange-close"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Incoming exchange payload"].isHittable)
    XCTAssertTrue(app.staticTexts["This chat is view-only"].exists)
    XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "message-input").firstMatch.exists)
  }
  func testOlderSearchContextLoadsForwardWithoutSkippingPages() async throws {
    let app = try await launch("history-pages", visual: true)
    app.open(URL(string: "openteam-swift://chat/visual-chat?messageId=visual-message-visual-chat-20")!)
    XCTAssertTrue(app.staticTexts["Page message 20"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.staticTexts["Page message 180"].exists)
    let later = app.buttons["Load later messages"]
    for _ in 0..<12 {
      if later.isHittable { break }
      app.tables["chat-history"].swipeUp()
    }
    XCTAssertTrue(later.isHittable)
    later.tap()
    for _ in 0..<5 {
      if app.staticTexts["Page message 41"].isHittable { break }
      app.tables["chat-history"].swipeUp()
    }
    XCTAssertTrue(app.staticTexts["Page message 41"].exists)
    XCTAssertFalse(app.staticTexts["Page message 180"].exists)
    app.buttons["Latest messages"].tap()
    XCTAssertTrue(app.staticTexts["Page message 180"].waitForExistence(timeout: 8))
  }
  func testContinuousScrollCrossesNativeWindowsAndReturnsToLatest() async throws {
    let app = try await launch("window-history", visual: true)
    XCTAssertTrue(app.staticTexts["Page message 180"].isHittable)
    for _ in 0..<24 {
      if app.staticTexts["Page message 1"].exists && app.staticTexts["Page message 1"].isHittable { break }
      app.tables["chat-history"].swipeDown(velocity: .fast)
    }
    XCTAssertTrue(app.staticTexts["Page message 1"].isHittable)
    XCTAssertTrue(app.staticTexts["Page message 2"].isHittable)
    XCTAssertTrue(app.staticTexts["Page message 3"].isHittable)
    XCTAssertTrue(app.buttons["Latest messages"].exists)
    capture("continuous-history-first-window", app)
    app.buttons["Latest messages"].tap()
    XCTAssertTrue(app.staticTexts["Page message 180"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.staticTexts["Page message 180"].isHittable)
    XCTAssertFalse(app.buttons["Latest messages"].exists)
  }

}
