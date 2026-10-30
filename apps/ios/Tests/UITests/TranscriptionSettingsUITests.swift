import XCTest

@MainActor
final class TranscriptionSettingsUITests: XCTestCase {
  private let base = URL(string: "http://127.0.0.1:20081")!
  private func state() async throws -> [String: Any] {
    let (data, _) = try await URLSession.shared.data(
      from: base.appendingPathComponent("__qa/state"))
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
  private func snapshot(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
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
  func testSavedKeysProviderSwitchesReplacementAndExplicitDeletion() async throws {
    continueAfterFailure = false
    var reset = URLRequest(url: base.appendingPathComponent("__qa/reset"))
    reset.httpMethod = "POST"
    _ = try await URLSession.shared.data(for: reset)
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--server", base.absoluteString, "--appearance", "light",
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
    snapshot("ios-saved-key", app)

    choose("Deepgram", in: app)
    XCTAssertEqual(key.placeholderValue, "API key")
    let beforeSave = try await state()
    XCTAssertEqual((beforeSave["transcriptionPatches"] as? [[String: Any]])?.count, 0)
    app.buttons["voice-save"].tap()
    let failure = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'replacement key'"))
      .firstMatch
    XCTAssertTrue(failure.waitForExistence(timeout: 5))
    let switchedState = try await state()
    let afterSwitch = try XCTUnwrap(switchedState["transcription"] as? [String: Any])
    XCTAssertEqual(afterSwitch["provider"] as? String, "openai")
    XCTAssertEqual(afterSwitch["apiKeySuffix"] as? String, "A7z9")
    snapshot("ios-provider-switch-keeps-key", app)
    choose("OpenAI", in: app)
    XCTAssertEqual(key.placeholderValue, "••••A7z9")

    let language = app.textFields["voice-language"]
    language.tap()
    language.typeText("fr")
    app.swipeUp()
    app.buttons["voice-save"].tap()
    await saved(app)
    let savedState = try await state()
    let patches = try XCTUnwrap(savedState["transcriptionPatches"] as? [[String: Any]])
    XCTAssertNil(patches.last?["apiKey"], "Blank key edits must omit the credential")
    XCTAssertEqual(key.placeholderValue, "••••A7z9")

    app.buttons["voice-remove-key"].tap()
    XCTAssertTrue(app.staticTexts["Key will be deleted when you save."].exists)
    let deletingState = try await state()
    XCTAssertEqual((deletingState["transcription"] as? [String: Any])?["hasApiKey"] as? Bool, true)
    snapshot("ios-delete-pending", app)
    app.buttons["voice-remove-key"].tap()
    XCTAssertEqual(key.placeholderValue, "••••A7z9")

    key.tap()
    key.typeText("synthetic-key-B8x2")
    app.swipeUp()
    app.buttons["voice-save"].tap()
    await saved(app)
    XCTAssertEqual(key.placeholderValue, "••••B8x2")
    snapshot("ios-replacement-saved", app)

    let enabled = app.switches["voice-enabled"]
    enabled.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
    XCTAssertEqual(enabled.value as? String, "0")
    app.buttons["voice-remove-key"].tap()
    app.buttons["voice-save"].tap()
    await saved(app)
    XCTAssertFalse(app.buttons["voice-remove-key"].exists)
    let finalState = try await state()
    let final = try XCTUnwrap(finalState["transcription"] as? [String: Any])
    XCTAssertEqual(final["hasApiKey"] as? Bool, false)
    XCTAssertTrue(final["apiKeySuffix"] is NSNull)
    snapshot("ios-key-deleted", app)
  }
}
