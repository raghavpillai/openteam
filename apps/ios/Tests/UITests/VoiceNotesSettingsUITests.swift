import XCTest

@MainActor final class VoiceNotesSettingsUITests: XCTestCase {
  private let base = "http://127.0.0.1:20072"
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

  func testTranscriptionSaveRetryTestAndPersistenceInBothAppearances() async throws {
    continueAfterFailure = false
    for appearance in ["light", "dark"] {
      _ = try await request("/__qa/reset", [:])
      if appearance == "light" {
        _ = try await request("/__qa/control", ["failures": [
          "GET \(path)": ["status": 400, "message": "Voice settings unavailable."]
        ]])
      }
      let app = XCUIApplication()
      app.launchArguments = ["--ui-testing", "--server", base, "--appearance", appearance]
      app.launch()
      try openVoice(app)
      if appearance == "light" {
        try text("Could not load transcription settings.", app)
        XCTAssertFalse(app.buttons["voice-save"].exists)
        try tap(app.buttons["retry-error"], app)
      }
      try tap(app.buttons["voice-provider"], app)
      try tap(app.buttons["Deepgram"], app)
      XCTAssertEqual(app.textFields["voice-model"].value as? String, "nova-3")
      XCTAssertFalse(app.textFields["voice-base-url"].exists)
      try toggle("voice-enabled", true, app)
      let key = app.secureTextFields["voice-api-key"]
      try tap(key, app)
      key.typeText("qa-voice-key")
      if appearance == "light" {
        _ = try await request("/__qa/control", ["failures": [
          "PUT \(path)": ["status": 400, "message": "Voice settings save refused."]
        ]])
        try tap(app.buttons["voice-save"], app)
        try text("Voice settings save refused.", app)
        let refused = try await request(path)
        XCTAssertEqual(refused["enabled"] as? Bool, false)
        XCTAssertTrue(app.buttons["voice-save"].isEnabled)
      }
      try tap(app.buttons["voice-save"], app)
      try text("Saved. Voice notes are enabled", app)
      var saved = try await request(path)
      XCTAssertEqual(saved["provider"] as? String, "deepgram")
      XCTAssertEqual(saved["model"] as? String, "nova-3")
      XCTAssertEqual(saved["hasApiKey"] as? Bool, true)
      XCTAssertEqual(saved["configured"] as? Bool, true)
      if appearance == "light" {
        _ = try await request("/__qa/control", ["failures": [
          "POST \(path)/check": ["status": 400, "message": "Transcription service unavailable."]
        ]])
        try tap(app.buttons["voice-test"], app)
        try text("Transcription service unavailable.", app)
      }
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
      screenshot("voice-notes-actions-" + appearance, app)
      app.swipeDown()
      app.swipeDown()
      screenshot("voice-notes-" + appearance, app)

      app.terminate()
      app.launch()
      try openVoice(app)
      try require(app.buttons["voice-provider"].waitForExistence(timeout: 10), "Reloaded provider")
      XCTAssertTrue(app.buttons["voice-provider"].label.contains("Deepgram"))
      XCTAssertEqual(app.textFields["voice-language"].value as? String, "en")
      XCTAssertFalse(app.buttons["voice-save"].isEnabled)
      try toggle("voice-remove-key", true, app)
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
  }
}
