import XCTest

@MainActor final class RoutineScheduleUITests: XCTestCase {
  private let base = "http://127.0.0.1:20032"
  private var app: XCUIApplication!

  private func request(_ path: String, _ body: [String: Any]? = nil, method: String? = nil)
    async throws -> [String: Any]
  {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = method ?? (body == nil ? "GET" : "POST")
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
  private func reset() async throws {
    continueAfterFailure = true
    _ = try await request("/__qa/reset", [:])
  }
  private func seed(_ schedule: String, name: String = "Schedule QA", extra: [String: Any] = [:])
    async throws -> String
  {
    let item = try await request(
      "/api/v0/bots/bot-research/routines",
      [
        "name": name, "prompt": "Check only this isolated QA fixture.", "schedule": schedule,
        "enabled": true, "clientId": UUID().uuidString,
      ])
    let id = try XCTUnwrap(item["id"] as? String)
    if !extra.isEmpty {
      _ = try await request(
        "/api/v0/routines/" + id,
        extra.merging(["expectedRevision": 1]) { a, _ in a }, method: "PATCH")
    }
    return id
  }
  private func launch(_ appearance: String = "dark") {
    app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--server", base, "--appearance", appearance,
      "--haptic-audit", "--haptics", "on", "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
    ]
    app.launch()
    XCTAssertTrue(app.buttons["channel-channel-research"].waitForExistence(timeout: 15))
    app.buttons["channel-channel-research"].tap()
    app.buttons["conversation-details"].tap()
    reveal(app.buttons["Routines"])
    app.buttons["Routines"].tap()
    XCTAssertTrue(app.navigationBars["Routines"].waitForExistence(timeout: 5))
  }
  private func reveal(_ element: XCUIElement) {
    for _ in 0..<7 {
      if element.exists && element.isHittable { return }
      let origin = app.coordinate(withNormalizedOffset: .zero)
      let bottom =
        app.keyboards.firstMatch.exists
        ? app.keyboards.firstMatch.frame.minY - 25 : app.frame.height * 0.8
      origin.withOffset(CGVector(dx: app.frame.width * 0.9, dy: bottom)).press(
        forDuration: 0.05,
        thenDragTo: origin.withOffset(
          CGVector(dx: app.frame.width * 0.9, dy: app.frame.height * 0.22)),
        withVelocity: .slow, thenHoldForDuration: 0.1)
    }
    XCTAssertTrue(element.isHittable, element.debugDescription)
  }
  private func choose(_ id: String, _ label: String) {
    let picker = app.buttons[id]
    reveal(picker)
    picker.tap()
    let option = app.buttons.matching(
      NSPredicate(
        format: "label == %@ OR label == %@", label,
        label.replacingOccurrences(of: " AM", with: "\u{202f}AM").replacingOccurrences(
          of: " PM", with: "\u{202f}PM"))
    ).firstMatch
    // Long time menus scroll independently of the form.
    for _ in 0..<10 {
      if option.exists && option.isHittable { break }
      guard
        let menu = app.collectionViews.allElementsBoundByIndex.first(where: {
          $0.frame.width < app.frame.width * 0.85
        })
      else {
        XCTFail("Missing popup for \(label)")
        return
      }
      let scrollBar = menu.otherElements.matching(
        NSPredicate(format: "label BEGINSWITH 'Vertical scroll bar'")
      ).firstMatch
      guard scrollBar.exists else {
        XCTFail("Missing scrollable menu for \(label)")
        return
      }
      // UIKit reports the menu collection's content height, which extends beyond
      // its clipped popup. Keep the gesture inside the actual scrollbar viewport.
      let bounds = scrollBar.frame
      let origin = app.coordinate(withNormalizedOffset: .zero)
      origin.withOffset(CGVector(dx: menu.frame.midX, dy: bounds.maxY - 30)).press(
        forDuration: 0.05,
        thenDragTo: origin.withOffset(CGVector(dx: menu.frame.midX, dy: bounds.minY + 30)),
        withVelocity: .slow, thenHoldForDuration: 0.1)
    }
    XCTAssertTrue(option.waitForExistence(timeout: 3), label)
    option.tap()
  }
  private func row(_ name: String) -> XCUIElement {
    app.buttons.containing(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
  }
  private func edit(_ name: String = "Schedule QA") {
    XCTAssertTrue(row(name).waitForExistence(timeout: 8))
    row(name).tap()
    XCTAssertTrue(app.textFields["routine-name"].waitForExistence(timeout: 5))
  }
  private func saved(_ id: String) async throws -> [String: Any] {
    let state = try await request("/__qa/state")
    let items = try XCTUnwrap(state["routines"] as? [[String: Any]])
    return try XCTUnwrap(items.first { $0["id"] as? String == id })
  }
  private func capture(_ name: String) {
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = name
    screenshot.lifetime = .keepAlways
    add(screenshot)
  }
  override func tearDown() async throws {
    app?.terminate()
  }

  func testWeeklyDropdownCreatesRetriesAndReopensInDarkMode() async throws {
    try await reset()
    launch()
    app.buttons["Add routine"].tap()
    app.textFields["routine-name"].tap()
    app.textFields["routine-name"].typeText("Friday brief")
    app.textViews["routine-prompt"].tap()
    app.textViews["routine-prompt"].typeText("Summarize the week.")
    XCTAssertFalse(app.textFields["routine-schedule"].exists)
    reveal(app.buttons["routine-frequency"])
    app.buttons["routine-frequency"].tap()
    for label in ["Every hour", "Every day", "Weekdays", "Every week", "Every month", "Interval"] {
      XCTAssertTrue(app.buttons[label].exists, label)
    }
    capture("frequency-dropdown-dark")
    app.buttons["Every week"].tap()
    choose("routine-weekday", "Friday")
    choose("routine-time", "9:15 AM")
    reveal(app.staticTexts["routine-schedule-summary"])
    XCTAssertEqual(
      app.staticTexts["routine-schedule-summary"].label.replacingOccurrences(
        of: "\u{202f}", with: " "), "Every Friday at 9:15 AM")
    capture("weekly-summary-dark")
    _ = try await request(
      "/__qa/control", ["failures": ["POST /api/v0/bots/bot-research/routines": ["status": 503]]])
    app.buttons["routine-save"].tap()
    XCTAssertTrue(
      app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] 'try again shortly'"))
        .firstMatch.waitForExistence(timeout: 8))
    app.buttons["routine-save"].tap()
    XCTAssertTrue(row("Friday brief").waitForExistence(timeout: 8))
    let state = try await request("/__qa/state")
    let routines = try XCTUnwrap(state["routines"] as? [[String: Any]])
    XCTAssertEqual(routines.count, 1)
    XCTAssertTrue((routines[0]["schedule"] as? String)?.hasSuffix("15 9 * * 5") == true)
    XCTAssertTrue((routines[0]["schedule"] as? String)?.hasPrefix("CRON_TZ=") == true)
    edit("Friday brief")
    reveal(app.staticTexts["routine-schedule-summary"])
    XCTAssertEqual(
      app.staticTexts["routine-schedule-summary"].label.replacingOccurrences(
        of: "\u{202f}", with: " "), "Every Friday at 9:15 AM")
    capture("weekly-reopened-dark")
  }

  func testMonthlyHourlyAndIntervalChoicesPersistInLightMode() async throws {
    try await reset()
    let id = try await seed("0 8 * * 1-5")
    launch("light")
    edit()
    choose("routine-frequency", "Every day")
    XCTAssertTrue(app.buttons["routine-time"].exists)
    choose("routine-frequency", "Weekdays")
    choose("routine-frequency", "Every month")
    choose("routine-month-day", "31st")
    reveal(app.staticTexts["routine-schedule-summary"])
    XCTAssertEqual(
      app.staticTexts["routine-schedule-summary"].label.replacingOccurrences(
        of: "\u{202f}", with: " "), "Monthly on the 31st at 8:00 AM")
    capture("monthly-summary-light")
    app.buttons["routine-save"].tap()
    edit()
    var routine = try await saved(id)
    XCTAssertEqual(routine["schedule"] as? String, "0 8 31 * *")
    choose("routine-frequency", "Every hour")
    choose("routine-minute", ":30")
    app.buttons["routine-save"].tap()
    edit()
    routine = try await saved(id)
    XCTAssertEqual(routine["schedule"] as? String, "30 * * * *")
    choose("routine-frequency", "Interval")
    choose("routine-interval-unit", "hours")
    choose("routine-interval-amount", "2")
    reveal(app.staticTexts["routine-schedule-summary"])
    XCTAssertEqual(
      app.staticTexts["routine-schedule-summary"].label.replacingOccurrences(
        of: "\u{202f}", with: " "), "Every 2 hours")
    capture("interval-summary-light")
    app.buttons["routine-save"].tap()
    edit()
    routine = try await saved(id)
    XCTAssertEqual(routine["schedule"] as? String, "@every 2h")
    reveal(app.staticTexts["routine-schedule-summary"])
    XCTAssertEqual(
      app.staticTexts["routine-schedule-summary"].label.replacingOccurrences(
        of: "\u{202f}", with: " "), "Every 2 hours")
  }

  func testSavedCustomAndGroupedSchedulesSurviveNameEdits() async throws {
    try await reset()
    let custom = "CRON_TZ=Europe/Rome */15 9-17 * * 1-5"
    let presentation: [String: Any] = [
      "version": 2, "kind": "bot-time-routines", "schedules": [["preset": "advanced"]],
    ]
    let customID = try await seed(
      custom, name: "Custom QA", extra: ["triggerPresentation": presentation])
    let groupID = try await seed(
      "0 8 * * *", name: "Group QA",
      extra: [
        "schedules": ["0 8 * * *", "0 17 * * *"],
        "trigger": [
          "type": "group",
          "listeners": [
            ["type": "cron", "schedule": "0 8 * * *"], ["type": "cron", "schedule": "0 17 * * *"],
          ],
        ],
      ])
    launch()
    edit("Custom QA")
    app.textFields["routine-name"].tap()
    app.textFields["routine-name"].typeText(" renamed")
    reveal(app.buttons["routine-frequency"])
    XCTAssertFalse(app.textFields["routine-schedule"].exists)
    capture("custom-schedule-preserved")
    app.buttons["routine-save"].tap()
    XCTAssertTrue(row("Custom QA renamed").waitForExistence(timeout: 8))
    var routine = try await saved(customID)
    XCTAssertEqual(routine["schedule"] as? String, custom)
    XCTAssertEqual(
      (routine["presentation"] as? [String: Any])?["version"] as? Int, 2,
      "Metadata-only saves must send back the desktop editor presentation unchanged")
    XCTAssertTrue(
      NSDictionary(dictionary: try XCTUnwrap(routine["presentation"] as? [String: Any])).isEqual(
        to: presentation))
    edit("Group QA")
    app.textFields["routine-name"].tap()
    app.textFields["routine-name"].typeText(" renamed")
    XCTAssertFalse(app.buttons["routine-frequency"].exists)
    app.buttons["routine-save"].tap()
    XCTAssertTrue(row("Group QA renamed").waitForExistence(timeout: 8))
    routine = try await saved(groupID)
    XCTAssertEqual(routine["schedules"] as? [String], ["0 8 * * *", "0 17 * * *"])
    XCTAssertEqual((routine["trigger"] as? [String: Any])?["type"] as? String, "group")
  }

  func testPinnedZoneAndNonstandardTimeSurviveWeekdayChange() async throws {
    try await reset()
    let id = try await seed("CRON_TZ=Europe/Rome 17 9 * * 7")
    launch()
    edit()
    choose("routine-weekday", "Friday")
    reveal(app.staticTexts["routine-schedule-summary"])
    XCTAssertEqual(
      app.staticTexts["routine-schedule-summary"].label.replacingOccurrences(
        of: "\u{202f}", with: " "), "Every Friday at 9:17 AM")
    XCTAssertTrue(app.staticTexts["Time zone: Europe/Rome"].exists)
    app.buttons["routine-save"].tap()
    XCTAssertTrue(row("Schedule QA").waitForExistence(timeout: 8))
    let routine = try await saved(id)
    XCTAssertEqual(routine["schedule"] as? String, "CRON_TZ=Europe/Rome 17 9 * * 5")
  }
}
