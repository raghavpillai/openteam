import XCTest

@MainActor final class VoiceNotesSettingsUITests: XCTestCase {
  private let base = ProcessInfo.processInfo.environment["VOICE_SETTINGS_QA_SERVER"]
    ?? "http://127.0.0.1:20072"
  private let path = "/api/v0/server-settings/transcription"

  private func request(_ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
    var request = URLRequest(url: URL(string: base + path)!)
    if let body {
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    return try JSONSerialization.jsonObject(with: data) as! [String: Any]
  }

  private func require(_ condition: Bool, _ message: String) throws {
    guard condition else {
      XCTFail(message)
      throw NSError(domain: "VoiceNotesSettingsUITests", code: 1,
        userInfo: [NSLocalizedDescriptionKey: message])
    }
  }

  private func tap(_ element: XCUIElement, _ app: XCUIApplication) throws {
    try require(element.waitForExistence(timeout: 10), "Missing \(element)")
    for _ in 0..<3 where !element.isHittable { app.swipeUp() }
    try require(element.isHittable, "Not hittable: \(element)")
    element.tap()
  }

  private func text(_ value: String, _ app: XCUIApplication) throws {
    try require(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", value))
      .firstMatch.waitForExistence(timeout: 15), "Missing message: \(value)")
  }

  private func toggle(_ id: String, _ enabled: Bool, _ app: XCUIApplication) throws {
    let row = app.switches[id]
    try require(row.waitForExistence(timeout: 10), "Missing toggle: \(id)")
    // SwiftUI exposes both the labeled row and its actual switch on iOS 26.
    let control = row.switches.firstMatch.exists ? row.switches.firstMatch : row
    try tap(control, app)
    try require(row.value as? String == (enabled ? "1" : "0"), "Toggle value: \(id)")
  }

  private func openVoice(_ app: XCUIApplication) throws {
    try tap(app.buttons["settings-button"], app)
    try tap(app.buttons["voice-settings"], app)
    try require(app.navigationBars["Voice notes"].waitForExistence(timeout: 10), "Voice notes route")
  }

  private func screenshot(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func testTranscriptionSaveRetryTestAndPersistence() async throws {
    continueAfterFailure = false
    _ = try await request("/__qa/reset", [:])
    _ = try await request("/__qa/control", ["failures": [
      "GET \(path)": ["status": 400, "message": "Voice settings unavailable."]
    ]])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "light"]
    app.launch()
    try openVoice(app)
    try text("Could not load transcription settings.", app)
    XCTAssertFalse(app.buttons["voice-save"].exists)
    try tap(app.buttons["retry-error"], app)
    try tap(app.buttons["voice-provider"], app)
    try tap(app.buttons["Deepgram"], app)
    XCTAssertEqual(app.textFields["voice-model"].value as? String, "nova-3")
    XCTAssertFalse(app.textFields["voice-base-url"].exists)
    try toggle("voice-enabled", true, app)
    let key = app.secureTextFields["voice-api-key"]
    try tap(key, app)
    key.typeText("qa-voice-key")
    _ = try await request("/__qa/control", ["failures": [
      "PUT \(path)": ["status": 400, "message": "Voice settings save refused."]
    ]])
    try tap(app.buttons["voice-save"], app)
    try text("Voice settings save refused.", app)
    let refused = try await request(path)
    XCTAssertEqual(refused["enabled"] as? Bool, false)
    XCTAssertTrue(app.buttons["voice-save"].isEnabled)
    try tap(app.buttons["voice-save"], app)
    try text("Saved. Voice notes are enabled", app)
    var saved = try await request(path)
    XCTAssertEqual(saved["provider"] as? String, "deepgram")
    XCTAssertEqual(saved["model"] as? String, "nova-3")
    XCTAssertEqual(saved["hasApiKey"] as? Bool, true)
    XCTAssertEqual(saved["configured"] as? Bool, true)
    _ = try await request("/__qa/control", ["failures": [
      "POST \(path)/check": ["status": 400, "message": "Transcription service unavailable."]
    ]])
    try tap(app.buttons["voice-test"], app)
    try text("Transcription service unavailable.", app)
    try tap(app.buttons["voice-test"], app)
    try text("Voice notes are ready.", app)
    let language = app.textFields["voice-language"]
    try tap(language, app)
    language.typeText("en")
    try tap(app.buttons["voice-save"], app)
    try text("Saved. Voice notes are enabled", app)
    saved = try await request(path)
    XCTAssertEqual(saved["language"] as? String, "en")
    XCTAssertEqual(saved["hasApiKey"] as? Bool, true)

    app.terminate()
    app.launch()
    try openVoice(app)
    try require(app.buttons["voice-provider"].waitForExistence(timeout: 10), "Reloaded provider")
    XCTAssertTrue(app.buttons["voice-provider"].label.contains("Deepgram"))
    XCTAssertEqual(app.textFields["voice-language"].value as? String, "en")
    XCTAssertFalse(app.buttons["voice-save"].isEnabled)
    XCTAssertEqual(app.secureTextFields["voice-api-key"].placeholderValue, "••••-key")
    try tap(app.buttons["voice-remove-key"], app)
    app.swipeDown()
    try toggle("voice-enabled", false, app)
    try tap(app.buttons["voice-save"], app)
    try text("Saved. Voice notes are disabled.", app)
    saved = try await request(path)
    XCTAssertEqual(saved["enabled"] as? Bool, false)
    XCTAssertEqual(saved["hasApiKey"] as? Bool, false)
    let state = try await request("/__qa/state")
    let writes = (state["requests"] as! [[String: Any]]).filter {
      $0["path"] as? String == path && $0["method"] as? String != "GET"
    }
    XCTAssertFalse(writes.isEmpty)
    XCTAssertTrue(writes.allSatisfy { $0["method"] as? String == "PUT" })
    app.terminate()
  }

  // Saved-key handling runs against a fixture seeded with an existing OpenAI key.
  private let keyServer = URL(string: "http://127.0.0.1:20081")!
  private func keyServerState() async throws -> [String: Any] {
    let (data, _) = try await URLSession.shared.data(
      from: keyServer.appendingPathComponent("__qa/state"))
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
  private func choose(_ provider: String, in app: XCUIApplication) {
    app.buttons["voice-provider"].tap()
    app.buttons[provider].tap()
  }
  private func saved(_ app: XCUIApplication) async {
    let finished = expectation(
      for: NSPredicate(format: "enabled == false"), evaluatedWith: app.buttons["voice-save"]
    )
    await fulfillment(of: [finished], timeout: 10)
  }
  private func tapSave(_ app: XCUIApplication) {
    let button = app.buttons["voice-save"]
    // XCTest's automatic scroll-to-visible can consume the tap while the
    // keyboard is open. Reveal the button before sending the actual tap.
    for _ in 0..<6 where !button.isHittable { app.swipeUp() }
    XCTAssertTrue(button.isHittable)
    button.tap()
  }
  func testSavedKeysProviderSwitchesReplacementAndExplicitDeletion() async throws {
    continueAfterFailure = false
    var reset = URLRequest(url: keyServer.appendingPathComponent("__qa/reset"))
    reset.httpMethod = "POST"
    _ = try await URLSession.shared.data(for: reset)
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--server", keyServer.absoluteString, "--appearance", "light",
    ]
    app.launch()
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 15))
    app.buttons["settings-button"].tap()
    let link = app.buttons["voice-settings"]
    if !link.isHittable { app.swipeUp() }
    link.tap()
    let key = app.secureTextFields["voice-api-key"]
    XCTAssertTrue(key.waitForExistence(timeout: 10))
    XCTAssertEqual(key.placeholderValue, "••••A7z9")
    XCTAssertFalse(app.buttons["voice-save"].isEnabled)
    screenshot("ios-saved-key", app)

    choose("Deepgram", in: app)
    XCTAssertEqual(key.placeholderValue, "API key")
    let beforeSave = try await keyServerState()
    XCTAssertEqual((beforeSave["transcriptionPatches"] as? [[String: Any]])?.count, 0)
    tapSave(app)
    let failure = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'replacement key'"))
      .firstMatch
    XCTAssertTrue(failure.waitForExistence(timeout: 5))
    let switchedState = try await keyServerState()
    let afterSwitch = try XCTUnwrap(switchedState["transcription"] as? [String: Any])
    XCTAssertEqual(afterSwitch["provider"] as? String, "openai")
    XCTAssertEqual(afterSwitch["apiKeySuffix"] as? String, "A7z9")
    screenshot("ios-provider-switch-keeps-key", app)
    choose("OpenAI", in: app)
    XCTAssertEqual(key.placeholderValue, "••••A7z9")

    let language = app.textFields["voice-language"]
    language.tap()
    language.typeText("fr")
    app.swipeUp()
    tapSave(app)
    await saved(app)
    let savedState = try await keyServerState()
    let patches = try XCTUnwrap(savedState["transcriptionPatches"] as? [[String: Any]])
    XCTAssertNil(patches.last?["apiKey"], "Blank key edits must omit the credential")
    XCTAssertEqual(key.placeholderValue, "••••A7z9")

    app.buttons["voice-remove-key"].tap()
    XCTAssertTrue(app.staticTexts["Key will be deleted when you save."].exists)
    let deletingState = try await keyServerState()
    XCTAssertEqual((deletingState["transcription"] as? [String: Any])?["hasApiKey"] as? Bool, true)
    screenshot("ios-delete-pending", app)
    app.buttons["voice-remove-key"].tap()
    XCTAssertEqual(key.placeholderValue, "••••A7z9")

    key.tap()
    key.typeText("synthetic-key-B8x2")
    app.swipeUp()
    tapSave(app)
    await saved(app)
    XCTAssertEqual(key.placeholderValue, "••••B8x2")
    screenshot("ios-replacement-saved", app)

    let enabled = app.switches["voice-enabled"]
    enabled.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
    XCTAssertEqual(enabled.value as? String, "0")
    app.buttons["voice-remove-key"].tap()
    tapSave(app)
    await saved(app)
    XCTAssertFalse(app.buttons["voice-remove-key"].exists)
    let finalState = try await keyServerState()
    let final = try XCTUnwrap(finalState["transcription"] as? [String: Any])
    XCTAssertEqual(final["hasApiKey"] as? Bool, false)
    XCTAssertTrue(final["apiKeySuffix"] is NSNull)
    screenshot("ios-key-deleted", app)
  }
}
