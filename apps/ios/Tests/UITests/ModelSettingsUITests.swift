import XCTest

@MainActor final class ModelSettingsUITests: XCTestCase {
  private let base = "http://127.0.0.1:20072"

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

  private func tap(_ id: String, _ app: XCUIApplication) {
    let button = app.buttons[id]
    XCTAssertTrue(button.waitForExistence(timeout: 10), id)
    button.tap()
  }

  private func select(_ id: String, _ name: String, _ app: XCUIApplication) {
    tap(id, app)
    tap(name, app)
  }

  private func text(_ value: String, _ app: XCUIApplication) {
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", value))
      .firstMatch.waitForExistence(timeout: 15), value)
  }

  private func openModel(_ app: XCUIApplication) {
    tap("settings-button", app)
    tap("model-settings", app)
    XCTAssertTrue(app.navigationBars["Model"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["model-provider-picker"].waitForExistence(timeout: 10))
  }

  func testCanRetryLoadingModelSettings() async throws {
    continueAfterFailure = false
    _ = try await request("/__qa/reset", [:])
    _ = try await request("/__qa/control", ["modelSettings": true, "failures": [
      "GET /api/v0/server-settings": ["status": 400, "message": "Settings unavailable."]
    ]])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "light"]
    app.launch()
    openModel(app)
    text("Settings unavailable.", app)
    tap("model-retry", app)
    text("qa-saved-model", app)
    XCTAssertTrue(app.buttons["model-test"].isEnabled)
    app.terminate()
  }

  func testModelConnectionSelectionAndPersistenceInBothAppearances() async throws {
    continueAfterFailure = false
    for appearance in ["light", "dark"] {
      _ = try await request("/__qa/reset", [:])
      _ = try await request("/__qa/control", ["modelSettings": true])
      let app = XCUIApplication()
      app.launchArguments = ["--ui-testing", "--server", base, "--appearance", appearance]
      app.launch()
      openModel(app)
      text("qa-saved-model", app)
      XCTAssertFalse(app.buttons["model-reasoning-picker"].isEnabled)
      XCTAssertFalse(app.buttons["model-apply"].isEnabled)

      _ = try await request("/__qa/control", ["failures": [
        "GET /api/v0/server-settings": ["status": 400, "message": "Provider catalog unavailable."]
      ]])
      select("model-provider-picker", "OpenAI", app)
      text("Provider catalog unavailable.", app)
      XCTAssertTrue(app.buttons["model-provider-picker"].label.contains("OpenRouter"))
      XCTAssertTrue(app.buttons["model-model-picker"].label.contains("Saved QA model"))
      XCTAssertFalse(app.buttons["model-apply"].isEnabled)
      select("model-provider-picker", "OpenAI", app)
      tap("model-connect-api_key", app)
      let key = app.secureTextFields["model-prompt-field"]
      XCTAssertTrue(key.waitForExistence(timeout: 10))
      key.tap()
      key.typeText("qa-model-key")
      tap("model-prompt-continue", app)
      text("Connected with an API key.", app)
      tap("model-apply", app)
      text("Working · replied", app)
      var state = try await request("/__qa/state")["modelSettings"] as! [String: Any]
      XCTAssertEqual((state["inference"] as! [String: String])["providerId"], "openai")
      XCTAssertEqual((state["tests"] as! [[String: String]]).last?["modelId"], "qa-openai-model")

      select("model-provider-picker", "OpenRouter", app)
      select("model-model-picker", "Reasoning QA model", app)
      select("model-reasoning-picker", "High", app)
      XCTAssertFalse(app.buttons["model-test"].isEnabled)
      _ = try await request("/__qa/control", ["failures": [
        "PATCH /api/v0/server-settings/inference": ["status": 400, "message": "Model save refused."]
      ]])
      tap("model-apply", app)
      text("Model save refused.", app)
      state = try await request("/__qa/state")["modelSettings"] as! [String: Any]
      XCTAssertEqual((state["inference"] as! [String: String])["providerId"], "openai")
      XCTAssertTrue(app.buttons["model-model-picker"].label.contains("Reasoning QA model"))
      XCTAssertTrue(app.buttons["model-reasoning-picker"].label.contains("High"))
      tap("model-apply", app)
      text("Working · replied", app)
      state = try await request("/__qa/state")["modelSettings"] as! [String: Any]
      let saved = ["providerId": "openrouter", "modelId": "qa-reasoning-model", "reasoning": "high"]
      XCTAssertEqual(state["inference"] as! [String: String], saved)
      XCTAssertEqual((state["tests"] as! [[String: String]]).last, saved)
      let screenshot = XCTAttachment(screenshot: app.screenshot())
      screenshot.name = "model-settings-" + appearance
      screenshot.lifetime = .keepAlways
      add(screenshot)

      // Recreate the app and its setup state; the server is the source of truth.
      app.terminate()
      app.launch()
      openModel(app)
      text("qa-reasoning-model", app)
      XCTAssertTrue(app.buttons["model-reasoning-picker"].label.contains("High"))
      XCTAssertFalse(app.buttons["model-apply"].isEnabled)
      select("model-model-picker", "Saved QA model", app)
      XCTAssertFalse(app.buttons["model-reasoning-picker"].isEnabled)
      tap("model-apply", app)
      text("Working · replied", app)
      state = try await request("/__qa/state")["modelSettings"] as! [String: Any]
      XCTAssertEqual((state["inference"] as! [String: String])["reasoning"], "off")
      app.terminate()
    }
  }
}
