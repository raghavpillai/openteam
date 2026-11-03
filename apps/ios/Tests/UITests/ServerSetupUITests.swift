import XCTest

@MainActor final class ServerSetupUITests: XCTestCase {
  private let base = "http://127.0.0.1:20071"

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

  private func launch(
    onboarding: Bool = true, appearance: String = "light"
  ) async throws -> XCUIApplication {
    continueAfterFailure = false
    _ = try await request("/__qa/reset", [:])
    if onboarding { _ = try await request("/__qa/control", ["onboarding": true]) }
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", appearance]
    if onboarding { app.launchArguments.append("--qa-onboarding") }
    app.launch()
    if onboarding { title("You're already connected", app) }
    return app
  }

  private func title(_ text: String, _ app: XCUIApplication) {
    XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 20))
  }

  private func tap(_ identifier: String, _ app: XCUIApplication) {
    let button = app.buttons[identifier]
    XCTAssertTrue(button.waitForExistence(timeout: 8))
    button.tap()
  }

  func testCompletesFirstBotOnboardingInDarkMode() async throws {
    let app = try await launch(appearance: "dark")
    tap("wizard-continue", app)
    title("Let your bots search the web", app)
    tap("wizard-skip", app)
    title("Talk instead of type?", app)
    tap("wizard-skip", app)
    title("Create your first bot", app)
    let name = app.textFields["bot-name-field"]
    name.tap()
    let previous = name.value as? String ?? ""
    name.typeText(
      String(repeating: XCUIKeyboardKey.delete.rawValue, count: previous.count) + "QA First Bot")
    tap("wizard-continue", app)
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 20))
    XCTAssertTrue(app.staticTexts["QA First Bot"].exists)
    let state = try await request("/__qa/state")
    let bots = state["bots"] as! [[String: Any]]
    XCTAssertEqual(bots.count, 1)
    XCTAssertEqual(bots.first?["name"] as? String, "QA First Bot")
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "onboarding-first-bot-dark"
    screenshot.lifetime = .keepAlways
    add(screenshot)
  }

  func testCanKeepSavedAIAfterARefusedAlternative() async throws {
    let app = try await launch()
    tap("wizard-different-ai", app)
    title("Choose your bots' AI", app)
    XCTAssertFalse(app.buttons["wizard-skip"].exists)
    tap("wizard-keep-saved", app)
    title("You're already connected", app)

    tap("wizard-different-ai", app)
    tap("provider-card-chatgpt", app)
    tap("method-openai", app)
    let key = app.secureTextFields["api-key-field"]
    XCTAssertTrue(key.waitForExistence(timeout: 8))
    key.tap()
    key.typeText("qa-invalid-key")
    tap("wizard-continue", app)
    XCTAssertTrue(app.staticTexts["api-key-error"].waitForExistence(timeout: 8))
    app.navigationBars.buttons.firstMatch.tap()
    title("Connect ChatGPT", app)
    app.navigationBars.buttons.firstMatch.tap()
    title("Choose your bots' AI", app)
    tap("wizard-keep-saved", app)
    title("You're already connected", app)
    XCTAssertTrue(
      app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Saved QA model"))
        .firstMatch.exists)
    XCTAssertFalse(app.buttons["wizard-skip"].exists)
  }

  func testSearchOnboardingChoosesOnlyACheckedProvider() async throws {
    let app = try await launch()
    tap("wizard-continue", app)
    title("Let your bots search the web", app)
    XCTAssertTrue(app.staticTexts["Recommended"].exists)
    let key = app.secureTextFields["search-key-field"]
    key.tap()
    key.typeText("bad-search-key")
    tap("wizard-continue", app)
    XCTAssertTrue(
      app.staticTexts["Exa rejected the API key (HTTP 401)."].waitForExistence(timeout: 8))
    let refused = try await request("/api/v0/server-settings/web-providers")
    let search = refused["search"] as! [String: Any]
    XCTAssertTrue(search["selected"] is NSNull)
    key.tap()
    key.typeText(
      String(repeating: XCUIKeyboardKey.delete.rawValue, count: 14) + "good-search-key")
    tap("wizard-continue", app)
    title("Talk instead of type?", app)
    let chosen = try await request("/api/v0/server-settings/web-providers")
    XCTAssertEqual((chosen["search"] as! [String: Any])["selected"] as? String, "exa")
  }

  func testVoiceOnboardingSavesAndDisablesARefusedService() async throws {
    let app = try await launch()
    tap("wizard-continue", app)
    title("Let your bots search the web", app)
    tap("wizard-skip", app)
    title("Talk instead of type?", app)
    let key = app.secureTextFields["voice-key-field"]
    key.tap()
    key.typeText("qa-voice-key")
    tap("voice-provider-deepgram", app)
    XCTAssertFalse(app.buttons["wizard-continue"].isEnabled)
    key.tap()
    key.typeText("qa-voice-key")
    _ = try await request(
      "/__qa/control",
      [
        "failures": [
          "POST /api/v0/server-settings/transcription/check": [
            "status": 400, "message": "Voice service refused the key.",
          ]
        ]
      ])
    tap("wizard-continue", app)
    XCTAssertTrue(app.staticTexts["Voice service refused the key."].waitForExistence(timeout: 8))
    let disabled = try await request("/api/v0/server-settings/transcription")
    XCTAssertEqual(disabled["enabled"] as? Bool, false)
    XCTAssertEqual(disabled["hasApiKey"] as? Bool, false)
    tap("wizard-continue", app)
    title("Create your first bot", app)
    let enabled = try await request("/api/v0/server-settings/transcription")
    XCTAssertEqual(enabled["configured"] as? Bool, true)
    let state = try await request("/__qa/state")
    let saves = (state["requests"] as! [[String: Any]]).filter {
      $0["path"] as? String == "/api/v0/server-settings/transcription"
        && $0["method"] as? String != "GET"
    }
    XCTAssertEqual(saves.map { $0["method"] as! String }, ["PUT", "PUT", "PUT"])
  }

  func testVoiceSettingsSaveUsesTheServerRoute() async throws {
    let app = try await launch(onboarding: false)
    tap("settings-button", app)
    tap("voice-settings", app)
    let language = app.textFields["voice-language"]
    XCTAssertTrue(language.waitForExistence(timeout: 8))
    if !language.isHittable { app.swipeUp() }
    language.tap()
    language.typeText("en")
    let save = app.buttons["voice-save"]
    if !save.isHittable { app.swipeUp() }
    save.tap()
    XCTAssertTrue(app.staticTexts["Saved. Voice notes are disabled."].waitForExistence(timeout: 8))
    let state = try await request("/__qa/state")
    XCTAssertTrue(
      (state["requests"] as! [[String: Any]]).contains {
        $0["method"] as? String == "PUT"
          && $0["path"] as? String == "/api/v0/server-settings/transcription"
      })
  }
}
