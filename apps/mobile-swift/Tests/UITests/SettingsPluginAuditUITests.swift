import XCTest

/// Optional reference audit. All services and browser handoffs use an inert loopback fixture.
@MainActor final class SettingsPluginAuditUITests: XCTestCase {
  let base = "http://127.0.0.1:20014"
  func post(_ body: [String: Any]) async throws { try await post("/__settings/control", body) }
  func post(_ path: String, _ body: [String: Any]) async throws {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }
  func state() async throws -> [String: Any] {
    let (data, _) = try await URLSession.shared.data(from: URL(string: base + "/__settings/state")!)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
  func launch(_ scene: String = "catalog", strict: Bool = true) async throws -> XCUIApplication {
    continueAfterFailure = false
    try await post("/__settings/reset", ["scene": scene, "strictAccess": strict])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "dark"]
    app.launch()
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 15))
    app.buttons["settings-button"].tap()
    XCTAssertTrue(app.buttons["account-settings"].waitForExistence(timeout: 8))
    return app
  }
  func capture(_ name: String, _ app: XCUIApplication) {
    let image = XCTAttachment(screenshot: app.screenshot())
    image.name = "settings-audit-" + name; image.lifetime = .keepAlways; add(image)
    let tree = XCTAttachment(string: app.debugDescription)
    tree.name = "settings-audit-" + name + "-accessibility"; tree.lifetime = .keepAlways; add(tree)
  }
  func recordState(_ name: String) async throws {
    let snapshot = try await state()
    let data = try JSONSerialization.data(withJSONObject: snapshot, options: [.prettyPrinted, .sortedKeys])
    let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
    attachment.name = "settings-audit-" + name + "-receipts"; attachment.lifetime = .keepAlways
    add(attachment)
  }
  func readyStatus(_ app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Ready' OR value == 'Ready' OR label == 'Status, Ready'")).firstMatch
  }
  func plugins(_ app: XCUIApplication) {
    app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Plugins")).firstMatch.tap()
    XCTAssertTrue(app.navigationBars["Plugins"].waitForExistence(timeout: 8))
  }
  func plugin(_ name: String, _ app: XCUIApplication) -> XCUIElement {
    app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
  }
  func find(_ element: XCUIElement, _ app: XCUIApplication) {
    for _ in 0..<6 where !element.isHittable {
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.80)).press(
        forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.28)))
    }
    XCTAssertTrue(element.isHittable, element.debugDescription)
  }
  func openCalendar(_ app: XCUIApplication) {
    plugins(app)
    XCTAssertTrue(plugin("Google Calendar", app).waitForExistence(timeout: 8))
    plugin("Google Calendar", app).tap()
    XCTAssertTrue(app.buttons["Connect"].waitForExistence(timeout: 8))
  }
  func backToPlugins(_ app: XCUIApplication) { app.navigationBars.buttons["Plugins"].tap() }
  func testReferenceSettingsAndPreferencePersistence() async throws {
    let app = try await launch()
    capture("09-settings-top", app)
    let haptics = app.switches["App haptics"]
    find(haptics, app)
    let initial = haptics.value as? String
    haptics.tap()
    XCTAssertNotEqual(haptics.value as? String, initial)
    let changed = haptics.value as? String
    find(app.buttons["sign-out"], app)
    capture("01-settings-bottom", app)
    app.buttons["More preferences"].tap()
    XCTAssertTrue(app.staticTexts["Managed on your computer"].waitForExistence(timeout: 8))
    capture("preferences", app)
    app.navigationBars.buttons.firstMatch.tap()
    find(haptics, app)
    XCTAssertEqual(haptics.value as? String, changed)
    haptics.tap()
    XCTAssertEqual(haptics.value as? String, initial)
    app.buttons["appearance-picker"].tap()
    XCTAssertTrue(app.buttons["Light"].waitForExistence(timeout: 5))
    app.buttons["Light"].tap()
    XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Day")).firstMatch.waitForExistence(timeout: 5))
    capture("appearance-light", app)
    app.buttons["appearance-picker"].tap(); app.buttons["Dark"].tap()
  }
  func testReferenceCatalogLoadingFailureRetryAndAuthorizationStates() async throws {
    var app = try await launch("loading")
    plugins(app)
    XCTAssertTrue(app.staticTexts["Loading plugins…"].waitForExistence(timeout: 8))
    capture("10-loading", app)
    try await post(["holdCatalog": false])
    XCTAssertTrue(plugin("Gmail", app).waitForExistence(timeout: 8))
    capture("08-catalog-authorize", app)
    app = try await launch("catalog-failed")
    plugins(app)
    XCTAssertTrue(plugin("Gmail", app).waitForExistence(timeout: 8))
    capture("02-catalog-retry", app)
    app = try await launch()
    try await post(["failures": ["GET /api/v0/plugins": 1]])
    plugins(app)
    XCTAssertTrue(app.buttons["Retry"].waitForExistence(timeout: 8))
    capture("catalog-error", app)
    app.buttons["Retry"].tap()
    XCTAssertTrue(plugin("Google Calendar", app).waitForExistence(timeout: 8))
  }
  func testReferenceUninstallCancellationFailureAndRecovery() async throws {
    let app = try await launch("failed")
    openCalendar(app)
    XCTAssertTrue(app.staticTexts["Didn't finish connecting. Try signing in again."].waitForExistence(timeout: 8))
    capture("06-failed-connection", app)
    let uninstall = app.buttons["Uninstall plugin"]
    find(uninstall, app)
    capture("05-uninstall-entry", app)
    uninstall.tap()
    XCTAssertTrue(app.buttons["Uninstall"].waitForExistence(timeout: 5))
    capture("04-uninstall-confirmation", app)
    if app.buttons["Cancel"].exists { app.buttons["Cancel"].tap() }
    else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.55)).tap() }
    var snapshot = try await state()
    XCTAssertEqual((snapshot["requests"] as? [[String: Any]] ?? []).filter { $0["method"] as? String == "DELETE" }.count, 0)
    try await post(["failures": ["DELETE /api/v0/plugins/qa-calendar": 1]])
    uninstall.tap(); app.buttons["Uninstall"].tap()
    XCTAssertTrue(app.alerts.buttons["OK"].waitForExistence(timeout: 8))
    capture("uninstall-error", app)
    app.alerts.buttons["OK"].tap()
    XCTAssertTrue(uninstall.exists)
    uninstall.tap(); app.buttons["Uninstall"].tap()
    XCTAssertTrue(app.navigationBars["Plugins"].waitForExistence(timeout: 8))
    capture("03-after-removal", app)
    snapshot = try await state()
    let installs = (snapshot["settings"] as? [String: Any])?["installs"] as? [[String: Any]] ?? []
    XCTAssertFalse(installs.contains { $0["pluginKey"] as? String == "qa-calendar" })
    try await recordState("uninstall-recovered")
  }
  func testInstallRetryAndRepeatedConnectDoesNotDuplicateRequest() async throws {
    let app = try await launch(strict: false)
    plugins(app)
    XCTAssertTrue(plugin("Google Calendar", app).waitForExistence(timeout: 8))
    plugin("Google Calendar", app).tap()
    try await post(["failures": ["POST /api/v0/plugins/install": 1]])
    app.buttons["Install plugin"].tap()
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", "try again shortly")).firstMatch.waitForExistence(timeout: 8))
    capture("install-error", app)
    app.buttons["Install plugin"].tap()
    XCTAssertTrue(app.navigationBars["Plugins"].waitForExistence(timeout: 8))
    plugin("Google Calendar", app).tap()
    XCTAssertTrue(app.buttons["Connect"].waitForExistence(timeout: 8))
    try await post(["holdConnect": true])
    app.buttons["Connect"].tap(); app.buttons["Connect"].tap()
    let snapshot = try await state()
    let connections = (snapshot["requests"] as? [[String: Any]] ?? []).filter { $0["path"] as? String == "/api/v0/plugin-connections/qa-calendar-connection/connect" }
    try await post(["holdConnect": false])
    XCTAssertEqual(connections.count, 1)
    XCTAssertTrue(readyStatus(app).waitForExistence(timeout: 8))
    capture("connected", app)
    try await recordState("connect-deduplication")
  }
  func testAuthorizationReturnRefreshesConnection() async throws {
    let app = try await launch("authorize", strict: false)
    openCalendar(app)
    app.buttons["Sign in"].tap()
    let backgrounded = expectation(for: NSPredicate(format: "state != %d", XCUIApplication.State.runningForeground.rawValue), evaluatedWith: app)
    await fulfillment(of: [backgrounded], timeout: 12)
    let browser = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
    if browser.state == .runningForeground { capture("external-authorization-browser", browser) }
    try await post(["status": "ready"])
    app.activate()
    XCTAssertTrue(app.buttons["Sign in"].waitForExistence(timeout: 8))
    capture("07-authorization-return", app)
    try await recordState("authorization-return")
    XCTAssertTrue(readyStatus(app).waitForExistence(timeout: 3), "QA-15: Returning from authorization leaves the plugin detail at its old status.")
  }
  func testAccessErrorClearsAfterSuccessfulReload() async throws {
    let app = try await launch("access")
    openCalendar(app)
    let failure = app.staticTexts["limit is outside the supported range"]
    XCTAssertTrue(failure.waitForExistence(timeout: 8))
    // Bypass the separately reproduced page-limit bug solely to exercise error recovery.
    try await post(["strictAccess": false])
    let search = app.textFields["Search bots"]
    find(search, app); search.tap(); search.typeText("Memory")
    XCTAssertTrue(app.switches["Memory Box 914"].waitForExistence(timeout: 8))
    // Form rows are virtualized; bring the prior error back into view before asserting absence.
    app.collectionViews.firstMatch.swipeDown()
    app.collectionViews.firstMatch.swipeDown()
    capture("stale-access-error", app)
    try await recordState("stale-access-error")
    XCTAssertFalse(failure.exists, "QA-20: A successful bot-access reload never clears the earlier error.")
  }
  func testNoMatchingPluginsHasAnEmptySearchExplanation() async throws {
    let app = try await launch()
    plugins(app)
    XCTAssertTrue(plugin("Gmail", app).waitForExistence(timeout: 8))
    let search = app.searchFields.firstMatch
    XCTAssertTrue(search.exists)
    search.tap(); search.typeText("NoSuchPluginForAudit")
    capture("search-no-results", app)
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] 'no results' OR label CONTAINS[c] 'no plugins' OR label CONTAINS[c] 'no matching'")).firstMatch.exists, "QA-21: Empty filtered results display no explanation or recovery guidance.")
  }
  func testUninstallReconcilesAfterLostSuccessResponse() async throws {
    let app = try await launch("failed", strict: false)
    openCalendar(app)
    let uninstall = app.buttons["Uninstall plugin"]
    find(uninstall, app)
    try await post(["loseDeleteResponse": true])
    uninstall.tap(); app.buttons["Uninstall"].tap()
    XCTAssertTrue(app.alerts.buttons["OK"].waitForExistence(timeout: 8))
    app.alerts.buttons["OK"].tap()
    let snapshot = try await state()
    let installs = (snapshot["settings"] as? [String: Any])?["installs"] as? [[String: Any]] ?? []
    XCTAssertFalse(installs.contains { $0["pluginKey"] as? String == "qa-calendar" })
    uninstall.tap(); app.buttons["Uninstall"].tap()
    XCTAssertTrue(app.alerts.buttons["OK"].waitForExistence(timeout: 8))
    capture("uninstall-lost-acknowledgment", app)
    try await recordState("uninstall-lost-acknowledgment")
    app.alerts.buttons["OK"].tap()
    XCTAssertTrue(app.navigationBars["Plugins"].waitForExistence(timeout: 3), "QA-22: A committed uninstall with a lost response leaves the detail stuck; retry returns 404 without reconciling removal.")
  }
}
