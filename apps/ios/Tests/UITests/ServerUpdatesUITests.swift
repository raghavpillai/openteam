import XCTest

@MainActor final class ServerUpdatesUITests: XCTestCase {
  private let base =
    ProcessInfo.processInfo.environment["SERVER_UPDATE_SERVER"] ?? "http://127.0.0.1:20093"

  func testServerLinksToUpdatesWithIdleConfirmationAndRestartRecovery() async throws {
    continueAfterFailure = false
    try await reset()
    let app = launch()
    try tap(app.buttons["server-settings"], app)
    XCTAssertTrue(app.navigationBars["Server"].waitForExistence(timeout: 5))
    let link = app.buttons["server-view-updates"]
    XCTAssertTrue(link.waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["server-update-start"].exists)
    XCTAssertTrue(app.buttons["server-manage-devices"].exists)
    try tap(link, app)
    XCTAssertTrue(app.navigationBars["Updates"].waitForExistence(timeout: 5))
    let start = app.buttons["server-update-start"]
    try wait { start.exists && start.isEnabled }
    XCTAssertEqual(start.label, "Update to 0.0.11")
    capture("ios-updates-ready", app)

    try tap(start, app)
    XCTAssertTrue(
      app.alerts.buttons["server-update-confirm"].firstMatch.waitForExistence(timeout: 3))
    var savedUpdates = try await updates()
    XCTAssertEqual(savedUpdates.count, 0)
    app.alerts.buttons["server-update-cancel"].firstMatch.tap()
    try await control(["busyBots": [["botId": "scout", "name": "Scout", "runIds": ["run"]]]])
    try wait { !start.isEnabled }
    XCTAssertTrue(
      app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Scout")).firstMatch
        .exists)
    try await control(["busyBots": []])
    try wait { start.isEnabled }
    try tap(start, app)
    // A new turn starts while confirmation is open: re-check before posting.
    try await control(["busyBots": [["botId": "scout", "name": "Scout", "runIds": ["new-run"]]]])
    app.alerts.buttons["server-update-confirm"].firstMatch.tap()
    try wait { !start.isEnabled }
    savedUpdates = try await updates()
    XCTAssertEqual(savedUpdates.count, 0)
    try await control(["busyBots": []])
    try wait { start.isEnabled }
    try tap(start, app)
    app.alerts.buttons["server-update-confirm"].firstMatch.tap()
    try wait { app.staticTexts["Pulling OpenTeam 0.0.11 container images"].exists }
    XCTAssertTrue(app.staticTexts["Step 2 of 5"].exists)
    XCTAssertTrue(app.staticTexts["Downloading update"].exists)
    let requests = try await updates()
    XCTAssertEqual(requests.count, 1)
    XCTAssertEqual(requests.first?["targetVersion"] as? String, "0.0.11")
    try await control([
      "serverUpdate": ["phase": "backing-up", "message": "Backing up your database…"]
    ])
    try wait { app.staticTexts["Protecting your data"].exists }
    XCTAssertTrue(app.staticTexts["Step 3 of 5"].exists)
    try tap(app.buttons["Update stages"], app)
    XCTAssertTrue(app.staticTexts["Back up"].exists)
    XCTAssertTrue(app.staticTexts["Done"].firstMatch.exists)
    capture("ios-updates-backup", app)
    try tap(app.buttons["Update stages"], app)
    try await control(["serverUpdate": ["phase": "restarting", "message": "Restarting services…"]])
    try wait { app.staticTexts["Restarting services"].exists }
    XCTAssertTrue(app.staticTexts["Step 4 of 5"].exists)
    try await control(["offline": true])
    try wait { app.staticTexts["Reconnecting to the server…"].exists }
    XCTAssertFalse(start.exists)
    try await control([
      "offline": false, "serverRelease": ["releaseVersion": "0.0.11"],
      "serverUpdate": [
        "status": "updated", "phase": "complete", "message": "Update complete",
        "safeToCloseDesktop": false,
      ],
    ])
    try wait { app.staticTexts["Your server matches iOS app 0.0.11."].exists }
    XCTAssertFalse(start.exists)
    capture("ios-updates-complete", app)
    app.terminate()
  }

  func testReopeningDuringServerRestartRestoresProgressAndReconcilesCompletion() async throws {
    continueAfterFailure = false
    try await reset()
    // The job was started elsewhere; opening Updates must only observe it.
    try await control([
      "serverUpdate": [
        "status": "updating", "phase": "restarting", "jobId": "other-device-job",
        "targetVersion": "0.0.11", "message": "Restarting services…", "safeToCloseDesktop": true,
      ]
    ])
    var app = launch()
    try tap(app.buttons["updates-settings"], app)
    try wait { app.staticTexts["Restarting services"].exists }
    app.terminate()
    // Keep sign-in/bootstrap reachable in this fixture while maintenance endpoints restart.
    try await control([
      "failures": [
        "GET /api/v0/system/version": ["status": 503, "message": "Restarting", "count": 99],
        "GET /api/v0/system/update": ["status": 503, "message": "Restarting", "count": 99],
      ]
    ])
    app = launch()
    try tap(app.buttons["updates-settings"], app)
    try wait { app.staticTexts["Reconnecting to the server…"].exists }
    XCTAssertTrue(app.staticTexts["Last seen: Restarting services"].exists)
    XCTAssertTrue(app.staticTexts["Step 4 of 5"].exists)
    XCTAssertFalse(app.buttons["server-update-start"].exists)
    capture("ios-updates-reopened-offline", app)
    try await control([
      "failures": [:], "serverUpdate": ["phase": "verifying", "message": "Checking all services…"],
    ])
    try wait { app.staticTexts["Checking server health"].exists }
    app.terminate()
    try await control([
      "serverRelease": ["releaseVersion": "0.0.11"],
      "serverUpdate": ["status": "updated", "phase": "complete", "message": "Update complete"],
    ])
    app = launch()
    try tap(app.buttons["updates-settings"], app)
    try wait { app.staticTexts["You're up to date"].exists }
    let requests = try await updates()
    XCTAssertEqual(requests.count, 0)
    capture("ios-updates-reopened-complete", app)
    app.terminate()
  }

  func testNativeReadyLayoutKeepsActionsVisibleInBothAppearances() async throws {
    continueAfterFailure = false
    for appearance in ["light", "dark"] {
      try await reset()
      let app = launch(appearance: appearance)
      try tap(app.buttons["updates-settings"], app)
      let start = app.buttons["server-update-start"]
      try wait { start.exists && start.isEnabled }
      XCTAssertTrue(start.isHittable)
      XCTAssertTrue(app.buttons["server-update-check"].isHittable)
      XCTAssertTrue(
        app.descendants(matching: .any).matching(identifier: "ios-app-update").firstMatch.isHittable
      )
      capture("ios-native-ready-" + appearance, app)
      app.terminate()
    }
  }

  func testDirectUpdatesHandlesUnavailableUpdaterErrorsAndUnknownVersions() async throws {
    continueAfterFailure = false
    try await reset()
    try await control(["serverUpdate": ["updaterAvailable": false]])
    let app = launch(appearance: "light")
    try tap(app.buttons["updates-settings"], app)
    XCTAssertTrue(app.staticTexts["openteam update --version 0.0.11"].waitForExistence(timeout: 8))
    XCTAssertFalse(app.buttons["server-update-start"].exists)
    try await control([
      "serverUpdate": ["updaterAvailable": true],
      "failures": [
        "POST /api/v0/system/update": [
          "status": 503, "message": "Signed update unavailable.", "count": 1,
        ]
      ],
    ])
    let start = app.buttons["server-update-start"]
    try wait { start.exists && start.isEnabled }
    try tap(start, app)
    app.alerts.buttons["server-update-confirm"].firstMatch.tap()
    try wait { app.staticTexts["Signed update unavailable."].exists }
    let savedUpdates = try await updates()
    XCTAssertEqual(savedUpdates.count, 0)
    capture("ios-updates-error", app)
    try await control(["serverRelease": ["releaseVersion": "unreported"]])
    try wait {
      app.staticTexts["Could not verify the server version. Check for updates again."].exists
    }
    XCTAssertFalse(start.exists)
    try await control(["serverRelease": ["releaseVersion": "0.0.12"]])
    try tap(app.buttons["server-update-check"], app)
    try wait { app.staticTexts["This server is newer than the installed iOS app."].exists }
    XCTAssertFalse(start.exists)
    app.terminate()
  }

  func testProgressRecoveryNeverPretendsAnUnknownPhaseIsComplete() async throws {
    continueAfterFailure = false
    try await reset()
    try await control([
      "serverUpdate": [
        "status": "updating", "phase": "verifying", "targetVersion": "0.0.11",
        "message": "Checking all services…", "safeToCloseDesktop": true,
      ]
    ])
    let app = launch(appearance: "light")
    try tap(app.buttons["updates-settings"], app)
    try wait { app.staticTexts["Checking server health"].exists }
    XCTAssertTrue(app.staticTexts["Step 5 of 5"].exists)
    capture("ios-updates-verify-light", app)
    try await control([
      "serverUpdate": ["phase": "rolling-back", "message": "Restoring your previous version…"]
    ])
    try wait { app.staticTexts["Restoring the previous version"].exists }
    XCTAssertTrue(app.staticTexts["Recovering safely"].exists)
    XCTAssertFalse(app.staticTexts["You're up to date"].exists)
    capture("ios-updates-recovery-light", app)
    try await control(["serverUpdate": ["phase": "future-phase"]])
    try wait { app.staticTexts["Live progress"].exists }
    XCTAssertFalse(app.staticTexts["Step 5 of 5"].exists)
    try await control([
      "serverUpdate": ["status": "updated", "phase": "complete"],
      "serverRelease": ["releaseVersion": "0.0.11"],
      "failures": [
        "GET /api/v0/system/version": ["status": 503, "message": "Restarting", "count": 4]
      ],
    ])
    try wait { app.staticTexts["Reconnecting to the server…"].exists }
    XCTAssertFalse(app.staticTexts["You're up to date"].exists)
    try await control(["failures": [:]])
    try wait { app.staticTexts["You're up to date"].exists }
    app.terminate()
  }

  private func launch(appearance: String = "dark") -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", appearance]
    app.launch()
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 15))
    app.buttons["settings-button"].tap()
    return app
  }
  private func reset() async throws {
    _ = try await request("/__qa/reset", [:])
    try await control([
      "serverRelease": [
        "releaseVersion": "0.0.10", "apiProtocolVersion": 2,
        "minimumClientVersion": "0.0.0", "maximumClientVersionExclusive": "0.1.0",
      ]
    ])
  }
  private func control(_ body: [String: Any]) async throws {
    _ = try await request("/__qa/control", body)
  }
  private func updates() async throws -> [[String: Any]] {
    try await request("/__qa/state")["serverUpdateRequests"] as? [[String: Any]] ?? []
  }
  private func request(_ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
    var request = URLRequest(url: URL(string: base + path)!)
    if let body {
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
  }
  private func tap(_ element: XCUIElement, _ app: XCUIApplication) throws {
    for _ in 0..<6 where !element.isHittable { app.swipeUp() }
    XCTAssertTrue(element.waitForExistence(timeout: 5))
    element.tap()
  }
  private func wait(_ condition: @escaping () -> Bool) throws {
    let predicate = NSPredicate { _, _ in condition() }
    XCTAssertEqual(
      XCTWaiter.wait(
        for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: 12),
      .completed)
  }
  private func capture(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
