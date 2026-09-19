import XCTest

/// The ten September 16 dark references. Fixture content is inert; every capture is rendered by the app.
@MainActor final class DarkReferenceUITests: XCTestCase {
  let base = "http://127.0.0.1:20009"
  func post(_ path: String, _ body: [String: Any]) async throws {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }
  func launch(_ scene: String, draft: String? = nil, syntheticVoice: Bool = false) async throws
    -> XCUIApplication
  {
    continueAfterFailure = false
    try await post("/__qa/scene", ["scene": scene])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "dark"]
    if !scene.hasPrefix("dark-home") { app.launchArguments += ["--open-channel", "visual-chat"] }
    if let draft { app.launchArguments += ["--visual-draft", draft] }
    if syntheticVoice { app.launchArguments += ["--qa-synthetic-voice"] }
    app.launch()
    XCTAssertTrue(
      app.buttons[scene.hasPrefix("dark-home") ? "settings-button" : "chat-back"].waitForExistence(
        timeout: 15))
    return app
  }
  func capture(_ number: Int, _ app: XCUIApplication) {
    let item = XCTAttachment(screenshot: app.screenshot())
    item.name = String(format: "dark-native-%02d", number)
    item.lifetime = .keepAlways
    add(item)
  }
  func testHomeScrollAndLiftedMenu() async throws {
    var app = try await launch("dark-home")
    let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.7))
    from.press(
      forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 0, dy: -454)),
      withVelocity: .slow, thenHoldForDuration: 0.4)
    XCTAssertLessThan(
      app.buttons["channel-visual-2"].frame.minY, app.buttons["search-button"].frame.maxY)
    capture(1, app)
    app = try await launch("dark-home")
    app.buttons["channel-visual-0"].press(forDuration: 1)
    XCTAssertTrue(app.buttons["Mark unread"].waitForExistence(timeout: 5))
    capture(4, app)
  }
  func testGroupSearchSelectionAndBotCreation() async throws {
    var app = try await launch("dark-home")
    app.buttons["new-button"].tap()
    app.buttons["New Group Chat"].tap()
    XCTAssertTrue(app.textFields["group-search"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    XCTAssertGreaterThan(app.keyboards.firstMatch.frame.height, 200)
    XCTAssertFalse(app.buttons["Next"].isEnabled)
    capture(2, app)
    app.textFields["group-search"].typeText("Box 914")
    app.buttons["Memory Box 914"].tap()
    XCTAssertTrue(app.buttons["Next"].isEnabled)
    app.buttons["Next"].tap()
    XCTAssertTrue(app.textFields["new-name"].waitForExistence(timeout: 5))
    app = try await launch("dark-home")
    app.buttons["new-button"].tap()
    app.buttons["New Bot"].tap()
    XCTAssertTrue(app.textFields["new-name"].waitForExistence(timeout: 5))
    let orange = app.buttons.matching(NSPredicate(format: "label ==[c] %@", "Color #ff9e12"))
      .firstMatch
    if orange.exists { orange.tap() }
    XCTAssertFalse(app.buttons["create-confirm"].isEnabled)
    capture(3, app)
  }
  func testProfileCharacterAndInstructions() async throws {
    let app = try await launch("dark-chat")
    app.buttons["conversation-details"].tap()
    XCTAssertTrue(app.textFields["profile-name"].waitForExistence(timeout: 5))
    capture(5, app)
    let instructions = app.buttons["Instructions"]
    for _ in 0..<3 where !instructions.isHittable { app.collectionViews.firstMatch.swipeUp() }
    instructions.tap()
    XCTAssertTrue(app.textViews["profile-instructions"].waitForExistence(timeout: 5))
    app.textViews["profile-instructions"].tap()
    app.textViews["profile-instructions"].typeText("Keep responses concise.")
    app.navigationBars.buttons["Details"].tap()
    app.buttons["profile-save"].tap()
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 10))
    app.buttons["conversation-details"].tap()
    for _ in 0..<3 where !app.buttons["Add routine"].isHittable {
      app.collectionViews.firstMatch.swipeUp()
    }
    app.buttons["Add routine"].tap()
    XCTAssertTrue(app.textFields["routine-name"].waitForExistence(timeout: 5))
  }
  func testComputerStartingFrameAndNativeKeyboard() async throws {
    let app = try await launch("dark-chat")
    try await post("/__qa/control", ["screenState": "starting"])
    app.buttons["Computer"].tap()
    XCTAssertTrue(app.staticTexts["Starting desktop…"].waitForExistence(timeout: 5))
    capture(7, app)
    try await post("/__qa/control", ["screenState": "ready"])
    XCTAssertTrue(app.images["computer-screen"].waitForExistence(timeout: 10))
    capture(6, app)
    app.buttons["Show computer keyboard"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    XCTAssertLessThan(app.images["computer-screen"].frame.maxY, app.keyboards.firstMatch.frame.minY)
    app.typeText("Native keyboard")
    capture(8, app)
    app.buttons["Hide computer keyboard"].tap()
    app.buttons["Done"].tap()
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 10))
  }
  func testChatDraftTranslucency() async throws {
    let app = try await launch("dark-chat")
    let field = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    field.tap()
    field.typeText("Heheh\n\n")
    XCTAssertGreaterThan(app.keyboards.firstMatch.frame.height, 200)
    XCTAssertLessThanOrEqual(
      app.buttons["send-button"].frame.maxY, app.keyboards.firstMatch.frame.minY)
    capture(9, app)
  }
  func testVoiceRecordingStopAndTranscriptionRetry() async throws {
    let app = try await launch("dark-chat", syntheticVoice: true)
    app.buttons["Record voice note"].tap()
    XCTAssertTrue(app.buttons["Stop recording"].waitForExistence(timeout: 8))
    let recording = app.descendants(matching: .any).matching(identifier: "Recording voice note")
      .firstMatch
    let elapsed = expectation(
      for: NSPredicate(format: "value == %@", "2 seconds"), evaluatedWith: recording)
    await fulfillment(of: [elapsed], timeout: 6)
    XCTAssertFalse(app.keyboards.firstMatch.exists)
    capture(10, app)
    app.buttons["Stop recording"].tap()
    XCTAssertTrue(app.buttons["Discard recording"].waitForExistence(timeout: 5))
    try await post("/__qa/control", ["failures": ["POST /api/v0/transcriptions": ["status": 503]]])
    app.buttons["Transcribe voice note"].tap()
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 8))
    app.alerts.buttons["OK"].tap()
    XCTAssertTrue(app.buttons["Discard recording"].exists)
    app.buttons["Transcribe voice note"].tap()
    let field = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 8))
    XCTAssertEqual(field.value as? String, "Native voice QA transcription")
  }
  func testMicrophoneFailureKeepsComposerUsable() async throws {
    let app = try await launch("dark-chat")
    app.buttons["Record voice note"].tap()
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let microphonePermission = springboard.alerts.containing(
      NSPredicate(format: "label CONTAINS[c] %@", "Microphone")
    ).firstMatch
    if microphonePermission.waitForExistence(timeout: 3) {
      microphonePermission.buttons["Allow"].tap()
    }
    // This optional QA scheme runs on the headless Mac mini, which has no input device.
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 10))
    XCTAssertTrue(app.alerts.staticTexts["The microphone could not start recording."].exists)
    let item = XCTAttachment(screenshot: app.screenshot())
    item.name = "native-microphone-unavailable"
    item.lifetime = .keepAlways
    add(item)
    app.alerts.buttons["OK"].tap()
    let field = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    field.tap()
    field.typeText("Typing still works")
    XCTAssertTrue(app.buttons["send-button"].isEnabled)
  }

  func testLeavingChatWhileTranscribingDoesNotChangeDraft() async throws {
    let original = "Keep this draft"
    let app = try await launch("dark-chat", draft: original, syntheticVoice: true)
    app.buttons["attach-button"].tap()
    app.buttons["Record voice note"].tap()
    XCTAssertTrue(app.buttons["Stop recording"].waitForExistence(timeout: 5))
    app.buttons["Stop recording"].tap()
    try await post("/__qa/control", [
      "failures": ["POST /api/v0/transcriptions": ["delayMs": 8_000]],
    ])
    app.buttons["Transcribe voice note"].tap()
    XCTAssertTrue(app.buttons["Transcribing"].waitForExistence(timeout: 5))
    app.buttons["chat-back"].tap()
    XCTAssertTrue(app.buttons["channel-visual-chat"].waitForExistence(timeout: 5))
    // Wait for the deliberately delayed response, then inspect the saved draft.
    // This exercises the race with a deterministic provider response, not ASR quality.
    let deadline = Date().addingTimeInterval(15)
    var completed = false
    while Date() < deadline {
      let (data, _) = try await URLSession.shared.data(from: URL(string: base + "/__qa/state")!)
      let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
      let requests = state["requests"] as? [[String: Any]] ?? []
      if requests.contains(where: { $0["path"] as? String == "/api/v0/transcriptions" }) {
        completed = true
        break
      }
      try await Task.sleep(for: .milliseconds(250))
    }
    XCTAssertTrue(completed)
    app.buttons["channel-visual-chat"].tap()
    let field = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    XCTAssertEqual(field.value as? String, original)
  }

  func testTranscriptionCanOutlastOrdinaryRequestTimeout() async throws {
    let app = try await launch("dark-chat", syntheticVoice: true)
    app.buttons["Record voice note"].tap()
    XCTAssertTrue(app.buttons["Stop recording"].waitForExistence(timeout: 5))
    app.buttons["Stop recording"].tap()
    try await post("/__qa/control", [
      "failures": ["POST /api/v0/transcriptions": ["delayMs": 70_000]],
    ])
    app.buttons["Transcribe voice note"].tap()
    let field = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 90))
    XCTAssertEqual(field.value as? String, "Native voice QA transcription")
    XCTAssertFalse(app.alerts.firstMatch.exists)
  }

}
