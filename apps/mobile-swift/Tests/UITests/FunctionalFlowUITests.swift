import XCTest

@MainActor
final class FunctionalFlowUITests: XCTestCase {
  let base = "http://127.0.0.1:19992"
  func fixture(_ path: String = "/__qa/control", _ body: [String: Any] = [:]) async throws {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }
  func state() async throws -> [String: Any] {
    let (data, _) = try await URLSession.shared.data(from: URL(string: base + "/__qa/state")!)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
  func fail(_ route: String, code: Int = 503) async throws {
    try await fixture("/__qa/control", ["failures": [route: ["status": code]]])
  }
  func launch() async throws -> XCUIApplication {
    continueAfterFailure = false
    try await fixture("/__qa/reset")
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "light"]
    app.launch()
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 15))
    return app
  }
  func capture(_ name: String, _ app: XCUIApplication) {
    let a = XCTAttachment(screenshot: app.screenshot())
    a.name = "parity-" + name
    a.lifetime = .keepAlways
    add(a)
  }
  func find(_ element: XCUIElement, _ app: XCUIApplication, limit: Int = 7) {
    if app.keyboards.firstMatch.exists && app.buttons["Hide keyboard"].exists {
      app.buttons["Hide keyboard"].tap()
    }
    for _ in 0..<limit {
      if element.exists && element.isHittable { return }
      // Keep the gesture inside the form; an application-wide swipe starts on
      // the software keyboard on compact phones and never scrolls the form.
      let top = max(130, app.frame.height * 0.2)
      let bottom =
        app.keyboards.firstMatch.exists
        ? min(app.frame.height * 0.8, app.keyboards.firstMatch.frame.minY - 25)
        : app.frame.height * 0.8
      let origin = app.coordinate(withNormalizedOffset: .zero)
      origin.withOffset(CGVector(dx: app.frame.width * 0.85, dy: bottom))
        .press(
          forDuration: 0.05,
          thenDragTo: origin.withOffset(CGVector(dx: app.frame.width * 0.85, dy: top)),
          withVelocity: .slow, thenHoldForDuration: 0.1)
    }
    XCTAssertTrue(element.isHittable, element.debugDescription)
  }
  func replace(_ field: XCUIElement, _ text: String) {
    field.tap()
    field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
    let value = field.value as? String ?? ""
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count) + text)
  }
  func error(_ app: XCUIApplication, _ fragment: String = "try again shortly") {
    XCTAssertTrue(
      app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", fragment)).firstMatch
        .waitForExistence(timeout: 12))
  }
  func closeError(_ app: XCUIApplication) {
    if app.alerts.buttons["OK"].exists { app.alerts.buttons["OK"].tap() }
  }
  func details(_ app: XCUIApplication) {
    app.buttons["channel-channel-research"].tap()
    app.buttons["conversation-details"].tap()
    XCTAssertTrue(app.textFields["profile-name"].waitForExistence(timeout: 8))
  }
  func plugins(_ app: XCUIApplication) {
    app.buttons["settings-button"].tap()
    app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Plugins")).firstMatch.tap()
  }
  func testCreateAndEditRetainInputOnFailureAndPersistRobot() async throws {
    let app = try await launch()
    app.buttons["new-button"].tap()
    app.buttons["New Bot"].tap()
    let name = app.textFields["new-name"]
    XCTAssertTrue(name.waitForExistence(timeout: 8))
    name.tap()
    name.typeText("Native persistence bot")
    try await fail("POST /api/v0/bots")
    app.buttons["create-confirm"].tap()
    error(app)
    capture("create-failure", app)
    closeError(app)
    XCTAssertEqual(name.value as? String, "Native persistence bot")
    app.buttons["create-confirm"].tap()
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 12))
    app.buttons["conversation-details"].tap()
    replace(app.textFields["profile-name"], "Native edited bot")
    let robot = app.buttons["profile-robot-owl"]
    find(robot, app)
    robot.tap()
    capture("profile-robot-selected", app)
    XCTAssertEqual(robot.value as? String, "Selected")
    let before = try await state()
    let created = try XCTUnwrap(
      (before["bots"] as? [[String: Any]])?.first {
        $0["name"] as? String == "Native persistence bot"
      })
    let id = try XCTUnwrap(created["id"] as? String)
    try await fail("PATCH /api/v0/bots/" + id)
    app.buttons["profile-save"].tap()
    error(app)
    closeError(app)
    XCTAssertTrue(app.buttons["profile-save"].exists)
    app.buttons["profile-save"].tap()
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 12))
    capture("profile-saved", app)
    let after = try await state()
    let edited = try XCTUnwrap(
      (after["bots"] as? [[String: Any]])?.first { $0["id"] as? String == id })
    XCTAssertEqual(edited["name"] as? String, "Native edited bot")
    XCTAssertEqual(edited["icon"] as? String, "owl")
  }
  func testMemoryLoadAndDeleteFailuresRecoverWithoutLosingProfileEdits() async throws {
    let app = try await launch()
    details(app)
    replace(app.textFields["profile-name"], "Unsaved profile edit")
    try await fail("GET /api/v0/bots/bot-research/memories")
    find(app.buttons["Memory"], app)
    app.buttons["Memory"].tap()
    error(app)
    capture("memory-load-error", app)
    app.buttons["Try again"].tap()
    XCTAssertTrue(
      app.staticTexts["Prefers concise summaries and clear next steps."].waitForExistence(
        timeout: 10))
    capture("memory", app)
    try await fail("DELETE /api/v0/bots/bot-research/memories")
    app.buttons["Clear all"].tap()
    app.buttons["Clear all memories"].tap()
    error(app)
    XCTAssertTrue(app.staticTexts["Prefers concise summaries and clear next steps."].exists)
    app.buttons["Clear all"].tap()
    app.buttons["Clear all memories"].tap()
    XCTAssertTrue(app.staticTexts["No saved memories"].waitForExistence(timeout: 10))
    capture("memory-empty", app)
    let memoryState = try await state()
    XCTAssertEqual((memoryState["memories"] as? [Any])?.count, 0)
    app.navigationBars.buttons["Details"].tap()
    for _ in 0..<4 where !app.textFields["profile-name"].exists {
      app.collectionViews.firstMatch.swipeDown()
    }
    XCTAssertEqual(app.textFields["profile-name"].value as? String, "Unsaved profile edit")
  }
  func testRoutineLostResponseRetriesOnceAndHistoryRecovers() async throws {
    let app = try await launch()
    details(app)
    find(app.buttons["Routines"], app)
    app.buttons["Routines"].tap()
    app.buttons["Add routine"].tap()
    app.textFields["routine-name"].tap()
    app.textFields["routine-name"].typeText("Delivery-safe routine")
    app.textViews["routine-prompt"].tap()
    app.textViews["routine-prompt"].typeText("Check the isolated QA fixture.")
    app.buttons["routine-save"].tap()
    XCTAssertTrue(
      app.buttons.containing(.staticText, identifier: "Delivery-safe routine").firstMatch
        .waitForExistence(timeout: 10))
    app.buttons.containing(.staticText, identifier: "Delivery-safe routine").firstMatch.tap()
    find(app.buttons["Run now"], app)
    try await fixture("/__qa/control", ["dropNextRoutineRun": true])
    app.buttons["Run now"].tap()
    error(app, "lost response")
    capture("routine-lost-response", app)
    let first = try await state()
    let id = try XCTUnwrap((first["routines"] as? [[String: Any]])?.first?["id"] as? String)
    try await fail("GET /api/v0/routines/" + id + "/executions")
    app.buttons["Try again"].tap()
    find(app.staticTexts["Completed"], app)
    let accepted = try await state()
    XCTAssertEqual((accepted["routineExecutions"] as? [Any])?.count, 1)
    XCTAssertTrue(app.buttons["Try again"].waitForExistence(timeout: 10))
    capture("routine-history-retry", app)
    app.buttons["Try again"].tap()
    let recovered = expectation(
      for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["Try again"])
    await fulfillment(of: [recovered], timeout: 10)
    XCTAssertTrue(app.staticTexts["Completed"].exists)
    capture("routine-recovered", app)
  }
  func testRoutineCreateFailureRevisionConflictAndRun() async throws {
    let app = try await launch()
    details(app)
    find(app.buttons["Routines"], app)
    app.buttons["Routines"].tap()
    app.buttons["Add routine"].tap()
    app.textFields["routine-name"].tap()
    app.textFields["routine-name"].typeText("Morning brief")
    app.textViews["routine-prompt"].tap()
    app.textViews["routine-prompt"].typeText("Summarize overnight changes.")
    try await fail("POST /api/v0/bots/bot-research/routines")
    app.buttons["routine-save"].tap()
    error(app)
    capture("routine-save-error", app)
    XCTAssertEqual(app.textFields["routine-name"].value as? String, "Morning brief")
    app.buttons["routine-save"].tap()
    let row = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Morning brief"))
      .firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 12))
    row.tap()
    let data = try await state()
    let routine = try XCTUnwrap((data["routines"] as? [[String: Any]])?.first)
    let id = try XCTUnwrap(routine["id"] as? String)
    replace(app.textFields["routine-name"], "Changed brief")
    try await fail("PATCH /api/v0/routines/" + id, code: 409)
    app.buttons["routine-save"].tap()
    error(app, "changed on another device")
    capture("routine-conflict", app)
    XCTAssertEqual(app.textFields["routine-name"].value as? String, "Changed brief")
    app.buttons["routine-save"].tap()
    XCTAssertTrue(
      app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Changed brief")).firstMatch
        .waitForExistence(timeout: 12))
    app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Changed brief")).firstMatch
      .tap()
    find(app.buttons["Run now"], app)
    app.buttons["Run now"].tap()
    capture("routine-history", app)
    let receipts = try await state()["requests"] as? [[String: Any]] ?? []
    XCTAssertTrue(receipts.contains { $0["path"] as? String == "/api/v0/routines/" + id + "/test" })
  }
  func testPluginsLoadInstallAndConnectionFailureRecovery() async throws {
    let app = try await launch()
    try await fail("GET /api/v0/plugins")
    plugins(app)
    error(app)
    capture("plugins-load-error", app)
    app.buttons["Retry"].tap()
    let plugin = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Fixture Notes"))
      .firstMatch
    XCTAssertTrue(plugin.waitForExistence(timeout: 12))
    plugin.tap()
    try await fail("POST /api/v0/plugins/install")
    app.buttons["Install plugin"].tap()
    error(app)
    capture("plugin-install-error", app)
    app.buttons["Install plugin"].tap()
    XCTAssertTrue(plugin.waitForExistence(timeout: 12))
    plugin.tap()
    XCTAssertTrue(app.buttons["Connection settings"].waitForExistence(timeout: 8))
    capture("plugin-installed", app)
    app.buttons["Connection settings"].tap()
    let alias = app.textFields["Account alias"]
    XCTAssertTrue(alias.waitForExistence(timeout: 10))
    replace(alias, "Work notes")
    try await fail("PATCH /api/v0/plugin-connections/fixture-connection/account")
    app.buttons["Rename account"].tap()
    error(app)
    XCTAssertEqual(alias.value as? String, "Work notes")
    app.buttons["Rename account"].tap()
    XCTAssertTrue(app.staticTexts["Account renamed."].waitForExistence(timeout: 8))
    capture("plugin-account", app)
    find(app.buttons["Save configuration"], app)
    app.buttons["Save configuration"].tap()
    let current = try await state()
    let installs = (current["pluginSettings"] as? [String: Any])?["installs"] as? [[String: Any]]
    XCTAssertEqual(
      ((installs?.first?["connections"] as? [[String: Any]])?.first)?["alias"] as? String,
      "Work notes")
    let receipts = current["requests"] as? [[String: Any]] ?? []
    XCTAssertTrue(
      receipts.contains {
        $0["path"] as? String == "/api/v0/plugin-connections/fixture-connection/configuration"
          && $0["method"] as? String == "PUT"
      })
  }
  func testPluginSourceValidationAndSaveRecovery() async throws {
    let app = try await launch()
    plugins(app)
    app.buttons["Plugin workspace"].tap()
    app.buttons["Add source"].tap()
    app.textFields["Name"].tap()
    app.textFields["Name"].typeText("Native source")
    app.textFields["https://…"].tap()
    app.textFields["https://…"].typeText("invalid")
    app.buttons["Save"].tap()
    error(app, "valid HTTP")
    capture("source-validation", app)
    replace(app.textFields["https://…"], "https://fixture.invalid/plugins")
    try await fail("POST /api/v0/plugin-sources")
    app.buttons["Save"].tap()
    error(app)
    XCTAssertEqual(app.textFields["Name"].value as? String, "Native source")
    app.buttons["Save"].tap()
    XCTAssertTrue(app.buttons["Add source"].waitForExistence(timeout: 12))
    capture("plugin-workspace", app)
    let sourceState = try await state()
    XCTAssertEqual(
      (sourceState["sources"] as? [[String: Any]])?.first?["name"] as? String, "Native source"
    )
  }
  func testInvalidServerChangeKeepsAccountAndSidebarSaveRetries() async throws {
    let app = try await launch()
    app.buttons["settings-button"].tap()
    app.buttons["account-settings"].tap()
    app.buttons["re-auth"].tap()
    app.buttons["clear-server"].tap()
    app.textFields["server-field"].typeText("http://127.0.0.1:1")
    app.buttons["connect-button"].tap()
    error(app, "Could not reach")
    capture("account-invalid-server", app)
    app.buttons["cancel-re-auth"].tap()
    XCTAssertTrue(app.buttons["re-auth"].waitForExistence(timeout: 5))
    XCTAssertEqual(
      app.descendants(matching: .any).matching(identifier: "account-connection-status").firstMatch
        .value as? String, "Connected")
    app.navigationBars.buttons.firstMatch.tap()
    find(app.buttons["More preferences"], app)
    app.buttons["More preferences"].tap()
    app.buttons["Organize conversations"].tap()
    app.textFields["section-name"].tap()
    app.textFields["section-name"].typeText("Daily work")
    app.buttons["section-add"].tap()
    try await fail("PATCH /api/v0/settings/sidebar")
    app.buttons["sidebar-save"].tap()
    error(app)
    capture("sidebar-save-error", app)
    XCTAssertTrue(app.buttons["Daily work"].exists)
    app.buttons["sidebar-save"].tap()
    XCTAssertTrue(app.buttons["Organize conversations"].waitForExistence(timeout: 12))
    let data = try await state()
    XCTAssertEqual(
      ((data["settings"] as? [String: Any])?["sections"] as? [[String: Any]])?.first?["name"]
        as? String, "Daily work")
  }
  func testGroupCreationRetriesAndPrivateSkillKeepsEdits() async throws {
    let app = try await launch()
    app.buttons["new-button"].tap()
    app.buttons["New Group Chat"].tap()
    XCTAssertFalse(app.buttons["Next"].isEnabled)
    app.buttons["Research"].tap()
    app.buttons["Ops"].tap()
    app.buttons["Next"].tap()
    app.textFields["new-name"].tap()
    app.textFields["new-name"].typeText("Native group")
    try await fail("POST /api/v0/channels")
    app.buttons["create-confirm"].tap()
    error(app)
    closeError(app)
    XCTAssertEqual(app.textFields["new-name"].value as? String, "Native group")
    app.buttons["create-confirm"].tap()
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 12))
    capture("group-created", app)
    let groupData = try await state()
    let group = try XCTUnwrap(
      (groupData["channels"] as? [[String: Any]])?.first { $0["name"] as? String == "Native group" }
    )
    XCTAssertEqual((group["members"] as? [Any])?.count, 2)
    app.buttons["chat-back"].tap()
    plugins(app)
    app.buttons["Plugin workspace"].tap()
    app.buttons["Create skill"].tap()
    app.textFields["Name"].tap()
    app.textFields["Name"].typeText("Native writing skill")
    app.textViews["skill-body"].tap()
    app.textViews["skill-body"].typeText("Use concise sentences. Retain important details.")
    try await fail("POST /api/v0/plugin-skills")
    app.buttons["Save"].tap()
    error(app)
    XCTAssertEqual(app.textFields["Name"].value as? String, "Native writing skill")
    capture("private-skill-error", app)
    app.buttons["Save"].tap()
    XCTAssertTrue(app.buttons["Create skill"].waitForExistence(timeout: 12))
    capture("private-skill-saved", app)
    let data = try await state()
    XCTAssertEqual(
      (data["skills"] as? [[String: Any]])?.first?["body"] as? String,
      "Use concise sentences. Retain important details.")
  }

}
