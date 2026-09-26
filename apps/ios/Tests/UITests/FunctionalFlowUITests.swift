import XCTest

@MainActor
final class FunctionalFlowUITests: XCTestCase {
  let base = ProcessInfo.processInfo.environment["FUNCTIONAL_FLOW_SERVER"] ?? "http://127.0.0.1:19992"
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
    waitForArrival(field)
    field.tap()
    field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
    let value = field.value as? String ?? ""
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count) + text)
  }
  func waitForArrival(_ element: XCUIElement) {
    let ready = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "hittable == true"), object: element)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed)
    // The restored sign-in panels move into their final frames before accepting input.
    Thread.sleep(forTimeInterval: 0.5)
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
  func testSearchWhitespaceAndUnavailableResultRecovery() async throws {
    let app = try await launch()
    app.buttons["search-button"].tap()
    let field = app.textFields["search-input"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.tap()
    field.typeText("   ")
    XCTAssertTrue(app.staticTexts["Research"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["No Results"].exists)
    try await fixture("/__qa/control", ["searchResults": [
      ["id": "missing-result", "kind": "message", "title": "Unavailable conversation",
       "subtitle": "A stale search hit"]]])
    replace(field, "lost")
    let missing = app.buttons.containing(.staticText, identifier: "Unavailable conversation").firstMatch
    XCTAssertTrue(missing.waitForExistence(timeout: 5))
    missing.tap()
    XCTAssertTrue(app.staticTexts["This result is no longer available. Search again to refresh the results."]
      .waitForExistence(timeout: 5))
    capture("search-unavailable-result", app)
    try await fixture("/__qa/control", ["searchResults": [
      ["id": "recovered-result", "kind": "bot", "title": "Recovered result",
       "subtitle": "Open Research", "botId": "bot-research"]]])
    app.buttons["Try again"].tap()
    let recovered = app.buttons.containing(.staticText, identifier: "Recovered result").firstMatch
    XCTAssertTrue(recovered.waitForExistence(timeout: 5))
    recovered.tap()
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 8))
  }

  func testProfileExitKeepsDiscardsAndSavesEditsInBothThemes() async throws {
    continueAfterFailure = false
    for theme in ["dark", "light"] {
      try await fixture("/__qa/reset")
      let app = XCUIApplication()
      app.launchArguments = ["--ui-testing", "--server", base, "--appearance", theme]
      app.launch()
      XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 15))
      details(app)
      replace(app.textFields["profile-name"], "Keep this edit")
      app.buttons["profile-back"].tap()
      XCTAssertTrue(app.buttons["Keep editing"].waitForExistence(timeout: 5))
      capture("profile-unsaved-" + theme, app)
      app.buttons["Keep editing"].tap()
      XCTAssertEqual(app.textFields["profile-name"].value as? String, "Keep this edit")
      let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.001, dy: 0.45))
      edge.press(forDuration: 0.05,
        thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.45)),
        withVelocity: .slow, thenHoldForDuration: 0.2)
      XCTAssertTrue(app.buttons["Save changes"].waitForExistence(timeout: 5))
      if theme == "dark" {
        try await fail("PATCH /api/v0/bots/bot-research")
        app.buttons["Save changes"].tap()
        error(app)
        closeError(app)
        XCTAssertEqual(app.textFields["profile-name"].value as? String, "Keep this edit")
        XCTAssertTrue(app.textFields["profile-name"].isEnabled)
        app.buttons["profile-back"].tap()
        XCTAssertTrue(app.buttons["Save changes"].waitForExistence(timeout: 5))
      }
      app.buttons["Save changes"].tap()
      XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 12))
      app.buttons["conversation-details"].tap()
      XCTAssertEqual(app.textFields["profile-name"].value as? String, "Keep this edit")
      replace(app.textFields["profile-name"], "Discard this edit")
      app.buttons["profile-back"].tap()
      app.buttons["Discard changes"].tap()
      XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 5))
      app.buttons["conversation-details"].tap()
      XCTAssertEqual(app.textFields["profile-name"].value as? String, "Keep this edit")
      app.buttons["profile-back"].tap()
      XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 5))
      XCTAssertFalse(app.buttons["Save changes"].exists, "Unchanged profiles leave immediately")
      app.terminate()
    }
  }

  func testSlowProfileSavePreventsLaterEditsAndExit() async throws {
    let app = try await launch()
    details(app)
    replace(app.textFields["profile-name"], "Slow profile")
    try await fixture("/__qa/control", ["failures": [
      "PATCH /api/v0/bots/bot-research": ["delayMs": 10000]]])
    app.buttons["profile-save"].tap()
    XCTAssertFalse(app.textFields["profile-name"].isEnabled)
    XCTAssertFalse(app.buttons["profile-back"].isEnabled)
    XCTAssertFalse(app.buttons["profile-options"].isEnabled)
    capture("profile-saving", app)
    let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.001, dy: 0.45))
    edge.press(forDuration: 0.05,
      thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.45)),
      withVelocity: .slow, thenHoldForDuration: 0.1)
    XCTAssertTrue(app.textFields["profile-name"].exists)
    XCTAssertFalse(app.buttons["Discard changes"].exists)
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 15))
    app.buttons["conversation-details"].tap()
    XCTAssertEqual(app.textFields["profile-name"].value as? String, "Slow profile")
  }

  func testSlowCreateAndRoutineSaveKeepSubmittedFormStable() async throws {
    let app = try await launch()
    app.buttons["new-button"].tap()
    app.buttons["New Bot"].tap()
    let name = app.textFields["new-name"]
    XCTAssertTrue(name.waitForExistence(timeout: 8))
    name.tap()
    name.typeText("Slow creation")
    try await fixture("/__qa/control", ["failures": ["POST /api/v0/bots": ["delayMs": 10000]]])
    app.buttons["create-confirm"].tap()
    XCTAssertFalse(name.isEnabled)
    XCTAssertFalse(app.buttons["sheet-close"].isEnabled)
    capture("create-saving", app)
    let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.13))
    top.press(forDuration: 0.05,
      thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.65)),
      withVelocity: .fast, thenHoldForDuration: 0.1)
    XCTAssertTrue(name.exists, "An accepted creation must not lose its destination to sheet dismissal")
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 15))
    app.buttons["conversation-details"].tap()
    let data = try await state()
    let bot = try XCTUnwrap((data["bots"] as? [[String: Any]])?.first { $0["name"] as? String == "Slow creation" })
    let id = try XCTUnwrap(bot["id"] as? String)
    find(app.buttons["Routines"], app)
    app.buttons["Routines"].tap()
    app.buttons["Add routine"].tap()
    app.textFields["routine-name"].tap()
    app.textFields["routine-name"].typeText("Slow routine")
    app.textViews["routine-prompt"].tap()
    app.textViews["routine-prompt"].typeText("Check the fixture")
    try await fixture("/__qa/control", ["failures": [
      "POST /api/v0/bots/" + id + "/routines": ["delayMs": 10000]]])
    app.buttons["routine-save"].tap()
    XCTAssertFalse(app.textFields["routine-name"].isEnabled)
    XCTAssertFalse(app.textViews["routine-prompt"].isEnabled)
    XCTAssertFalse(app.buttons["Cancel"].isEnabled)
    capture("routine-saving", app)
    top.press(forDuration: 0.05,
      thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.65)),
      withVelocity: .fast, thenHoldForDuration: 0.1)
    XCTAssertTrue(app.textFields["routine-name"].exists)
    XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Slow routine"))
      .firstMatch.waitForExistence(timeout: 15))
    let after = try await state()
    XCTAssertEqual((after["routines"] as? [[String: Any]])?.first?["name"] as? String, "Slow routine")
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
    XCTAssertTrue(app.buttons["Connection settings"].waitForExistence(timeout: 12))
    capture("plugin-installed", app)
    app.buttons["Connection settings"].tap()
    XCTAssertTrue(app.buttons["Manage accounts"].waitForExistence(timeout: 10))
    app.buttons["Manage accounts"].tap()
    let alias = app.textFields["Account name, e.g. Personal"]
    XCTAssertTrue(alias.waitForExistence(timeout: 10))
    replace(alias, "Work notes")
    try await fail("PATCH /api/v0/plugin-connections/fixture-connection/account")
    app.buttons["Rename account"].tap()
    error(app)
    XCTAssertEqual(alias.value as? String, "Work notes")
    app.buttons["Rename account"].tap()
    // Native Form virtualizes rows above the account controls. Bring the
    // receipt back into view rather than treating an offscreen row as absent.
    for _ in 0..<4 where !app.staticTexts["Account renamed."].exists {
      app.collectionViews.firstMatch.swipeDown()
    }
    guard app.staticTexts["Account renamed."].waitForExistence(timeout: 8) else {
      capture("plugin-account-rename-failure", app)
      let hierarchy = XCTAttachment(string: app.debugDescription)
      hierarchy.name = "plugin-account-rename-hierarchy"
      hierarchy.lifetime = .keepAlways
      add(hierarchy)
      XCTFail("Renaming must keep account settings open and show its receipt.")
      return
    }
    capture("plugin-account", app)
    app.buttons["Manage accounts"].tap()
    app.buttons["Connection setup"].tap()
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
  func testAdvancedConfigurationPreservesThenExplicitlyClearsSavedMaps() async throws {
    let app = try await launch()
    try await fixture("/__qa/control", ["configuration": [
      "headers": ["X-Tenant": "synthetic"], "env": ["QA_REGION": "test"],
      "headerNames": ["X-Tenant"], "environmentNames": ["QA_REGION"]]])
    plugins(app)
    app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Fixture Notes")).firstMatch.tap()
    app.buttons["Install plugin"].tap()
    XCTAssertTrue(app.buttons["Connection settings"].waitForExistence(timeout: 12))
    app.buttons["Connection settings"].tap()
    XCTAssertTrue(app.buttons["Connection setup"].waitForExistence(timeout: 8))
    app.buttons["Connection setup"].tap()
    find(app.buttons["Save configuration"], app)
    app.buttons["Save configuration"].tap()
    var snapshot = try await state()
    var config = try XCTUnwrap(snapshot["configuration"] as? [String: Any])
    XCTAssertEqual((config["headers"] as? [String: String])?["X-Tenant"], "synthetic")
    app.buttons["Advanced connection settings"].tap()
    let headers = app.switches["connection-clear-headers"]
    find(headers, app)
    (headers.switches.firstMatch.exists ? headers.switches.firstMatch : headers).tap()
    XCTAssertEqual(headers.value as? String, "1")
    let environment = app.switches["connection-clear-environment"]
    find(environment, app)
    (environment.switches.firstMatch.exists ? environment.switches.firstMatch : environment).tap()
    XCTAssertEqual(environment.value as? String, "1")
    find(app.buttons["Save configuration"], app)
    app.buttons["Save configuration"].tap()
    snapshot = try await state()
    config = try XCTUnwrap(snapshot["configuration"] as? [String: Any])
    XCTAssertEqual((config["headers"] as? [String: String])?.count, 0)
    XCTAssertEqual((config["env"] as? [String: String])?.count, 0)
  }
  func testProvidersCheckSelectAndTurnSearchOff() async throws {
    let app = try await launch()
    app.buttons["settings-button"].tap()
    app.buttons["providers-settings"].tap()
    func element(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }
    func wait(_ element: XCUIElement, _ format: String, _ value: String) {
      let match = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: format, value), object: element)
      XCTAssertEqual(XCTWaiter.wait(for: [match], timeout: 15), .completed, element.debugDescription)
    }
    func back(to element: XCUIElement) {
      app.navigationBars.buttons.firstMatch.tap()
      XCTAssertTrue(element.waitForExistence(timeout: 8))
    }
    let search = app.buttons["providers-search"]
    XCTAssertTrue(search.waitForExistence(timeout: 12))
    XCTAssertEqual(search.value as? String, "Off")
    XCTAssertEqual(app.buttons["providers-fetch"].value as? String, "Built-in")
    let searchOff = app.staticTexts["Search is off. Bots can't search the web."]
    XCTAssertTrue(searchOff.exists)
    XCTAssertTrue(app.staticTexts["Built-in fetch reads basic pages only."].exists)
    capture("providers-overview-default", app)
    search.tap()
    let off = app.buttons["providers-search-off"], exa = app.buttons["providers-search-exa"]
    XCTAssertTrue(exa.waitForExistence(timeout: 8))
    XCTAssertEqual(off.value as? String, "In use")
    XCTAssertEqual(exa.value as? String, "Add API key")
    // Without its key, tapping Exa opens it rather than choosing it.
    exa.tap()
    let key = app.secureTextFields["provider-field-apiKey"]
    XCTAssertTrue(key.waitForExistence(timeout: 8))
    XCTAssertFalse(app.buttons["provider-use"].isEnabled, "Exa needs its API key first")
    key.tap()
    key.typeText("good-fixture\n")
    // The check saves the typed key first, then runs against it.
    app.buttons["provider-check"].tap()
    let result = element("provider-check-result")
    XCTAssertTrue(result.waitForExistence(timeout: 15))
    XCTAssertEqual(result.value as? String, "Passed")
    XCTAssertEqual(key.placeholderValue, "Replace key", "Typed secrets clear once saved")
    capture("provider-exa-passed", app)
    app.buttons["provider-use"].tap()
    wait(element("provider-use"), "label BEGINSWITH %@", "In use")
    back(to: exa)
    XCTAssertEqual(exa.value as? String, "In use, Checked")
    back(to: search)
    wait(search, "value == %@", "Exa")
    XCTAssertFalse(searchOff.exists)
    capture("providers-overview-exa", app)
    // A ready provider is chosen with one tap, like a Wi-Fi network; Off turns search off.
    search.tap()
    XCTAssertTrue(off.waitForExistence(timeout: 8))
    off.tap()
    wait(off, "value == %@", "In use")
    exa.tap()
    wait(exa, "value == %@", "In use, Checked")
    off.tap()
    wait(off, "value == %@", "In use")
    back(to: search)
    wait(search, "value == %@", "Off")
    XCTAssertTrue(searchOff.exists)
    let providers = try await state()["webProviders"] as? [String: Any]
    XCTAssertTrue((providers?["search"] as? [String: Any])?["selected"] is NSNull)
    XCTAssertEqual(
      providers?["patches"] as? [NSDictionary],
      [
        ["search": ["providers": ["exa": ["apiKey": "good-fixture"]]]],
        ["search": ["selected": "exa"]],
        ["search": ["selected": NSNull()]],
        ["search": ["selected": "exa"]],
        ["search": ["selected": NSNull()]],
      ] as [NSDictionary])
  }

  func testGroupProfileEditPreservesMemberOrder() async throws {
    let app = try await launch()
    try await fixture("/api/v0/channels", ["name": "Ordered QA group", "botIds": ["bot-research", "bot-ops"], "clientId": UUID().uuidString])
    let before = try await state()
    let group = try XCTUnwrap((before["channels"] as? [[String: Any]])?.first { $0["kind"] as? String == "group" })
    let id = try XCTUnwrap(group["id"] as? String)
    let members = try XCTUnwrap(group["members"] as? [[String: Any]])
    XCTAssertTrue(app.buttons["channel-" + id].waitForExistence(timeout: 10))
    app.buttons["channel-" + id].tap()
    app.buttons["conversation-details"].tap()
    XCTAssertTrue(app.textFields["profile-name"].waitForExistence(timeout: 8))
    replace(app.textFields["profile-name"], "Renamed without reordering")
    app.buttons["profile-save"].tap()
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 8))
    let after = try await state()
    let saved = try XCTUnwrap((after["channels"] as? [[String: Any]])?.first { $0["id"] as? String == id })
    XCTAssertEqual((saved["members"] as? [[String: Any]])?.compactMap { $0["botId"] as? String }, members.compactMap { $0["botId"] as? String })
    XCTAssertFalse((after["requests"] as? [[String: Any]] ?? []).contains { $0["path"] as? String == "/api/v0/channels/\(id)/members" && $0["method"] as? String == "PUT" })
  }

  func testCustomBotAndGroupAvatarsRefreshAndReset() async throws {
    let app = try await launch()
    try await fixture("/api/v0/channels", ["name": "Custom photo QA group", "botIds": ["bot-research", "bot-ops"], "clientId": UUID().uuidString])
    try await fixture("/__qa/control", ["customAvatarRevision": "2026-09-18T00:00:00.000Z"])
    let photo = app.images["channel-photo-channel-research"].firstMatch
    XCTAssertTrue(photo.waitForExistence(timeout: 12))
    let snapshot = try await state()
    let group = try XCTUnwrap((snapshot["channels"] as? [[String: Any]])?.first { $0["kind"] as? String == "group" })
    XCTAssertTrue(app.images["channel-photo-" + (group["id"] as! String)].waitForExistence(timeout: 10))
    let count = (snapshot["requests"] as? [[String: Any]] ?? []).filter { $0["path"] as? String == "/api/v0/bots/bot-research/avatar" }.count
    try await fixture("/__qa/control", ["customAvatarRevision": "2026-09-18T00:01:00.000Z"])
    let refreshed = expectation(description: "Refetch changed avatar revision")
    Task {
      for _ in 0..<30 {
        let requests = try await state()["requests"] as? [[String: Any]] ?? []
        if requests.filter({ $0["path"] as? String == "/api/v0/bots/bot-research/avatar" }).count > count { refreshed.fulfill(); return }
        try await Task.sleep(for: .milliseconds(300))
      }
    }
    await fulfillment(of: [refreshed], timeout: 12)
    details(app)
    XCTAssertTrue(photo.waitForExistence(timeout: 5))
    find(app.buttons["Reset to default"], app)
    app.buttons["Reset to default"].tap()
    XCTAssertTrue(app.buttons["profile-save"].isEnabled)
    app.buttons["profile-save"].tap()
    let bots = try await state()["bots"] as? [[String: Any]] ?? []
    XCTAssertEqual(bots.first { $0["id"] as? String == "bot-research" }?["hasAvatar"] as? Bool, false)
  }
  func testReauthenticationInvalidServerRetryAndSidebarSaveRetries() async throws {
    let app = try await launch()
    app.buttons["settings-button"].tap()
    app.buttons["account-settings"].tap()
    app.buttons["re-auth"].tap()
    waitForArrival(app.textFields["server-field"])
    app.textFields["server-field"].tap()
    app.textFields["server-field"].typeText("http://127.0.0.1:1")
    app.buttons["connect-button"].tap()
    error(app, "Could not reach")
    capture("account-invalid-server", app)
    XCTAssertFalse(app.buttons["settings-button"].exists)
    app.buttons["clear-server"].tap()
    app.textFields["server-field"].typeText(base)
    app.buttons["connect-button"].tap()
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 12))
    app.buttons["settings-button"].tap()
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
    XCTAssertTrue(app.buttons["Research"].isSelected)
    app.buttons["Ops"].tap()
    XCTAssertTrue(app.buttons["Research"].isSelected)
    XCTAssertTrue(app.buttons["Ops"].isSelected)
    capture("group-members-selected", app)
    app.buttons["Next"].tap()
    XCTAssertTrue(app.staticTexts["2 bots selected"].exists)
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
