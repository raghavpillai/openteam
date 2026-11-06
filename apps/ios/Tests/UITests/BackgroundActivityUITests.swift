import XCTest

@MainActor final class BackgroundActivityUITests: XCTestCase {
  private var base: URL {
    URL(string: ProcessInfo.processInfo.environment["BACKGROUND_ACTIVITY_SERVER"] ?? "http://127.0.0.1:20070")!
  }
  private func control(_ path: String, _ body: [String: Any]) async throws {
    var request = URLRequest(url: base.appendingPathComponent(path))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }
  private func task(_ status: String, bot: String = "bot-visual-chat", channel: String = "visual-chat") -> [String: Any] {
    ["id": "background-attempt", "subagentId": "background-session", "parentBotId": bot,
      "parentRunId": "parent-run", "parentChannelId": channel, "parentToolCallId": "task-call",
      "currentRunId": "background-run", "description": "Check the shipping receipt",
      "subagentType": "executor", "status": status,
      "summary": NSNull(), "errorMessage": NSNull(), "startedAt": NSNull(),
      "completedAt": NSNull(), "stoppedAt": NSNull(),
      "createdAt": "2026-10-29T12:00:00Z", "updatedAt": "2026-10-29T12:00:00Z"]
  }
  private func waitForActivity(_ activity: XCUIElement, visible: Bool) async {
    // The footer keeps its hosting row while the robot and label collapse.
    let predicate = NSPredicate(format: "hittable == %@", NSNumber(value: visible))
    await fulfillment(of: [expectation(for: predicate, evaluatedWith: activity)], timeout: 10)
  }
  func testBackgroundTaskAppearsTransitionsAndClearsWithoutForegroundRun() async throws {
    try await checkBackgroundTaskLifecycle(appearance: "light")
  }
  func testBackgroundTaskLifecycleInDarkMode() async throws {
    try await checkBackgroundTaskLifecycle(appearance: "dark")
  }
  func testPullToRefreshWithTasksPreservesAuthenticatedSessionAndDraft() async throws {
    continueAfterFailure = false
    try await control("__qa/scene", ["scene": "background-activity"])
    try await control("__qa/control", ["authRequired": true])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--show-login", "--server", base.absoluteString]
    app.launch()
    defer { app.terminate() }
    addUIInterruptionMonitor(withDescription: "Password autofill") { alert in
      guard alert.buttons["Not Now"].exists else { return false }
      alert.buttons["Not Now"].tap()
      return true
    }
    XCTAssertTrue(app.buttons["get-started"].waitForExistence(timeout: 10))
    app.buttons["get-started"].tap()
    let endpoint = app.textFields["server-field"]
    await fulfillment(of: [expectation(for: NSPredicate(format: "hittable == true"),
      evaluatedWith: endpoint)], timeout: 10)
    app.buttons["connect-button"].tap()
    let username = app.textFields["username-field"]
    XCTAssertTrue(username.waitForExistence(timeout: 10))
    await fulfillment(of: [expectation(for: NSPredicate(format: "hittable == true"),
      evaluatedWith: username)], timeout: 10)
    username.tap()
    username.typeText("fixture\n")
    let password = app.secureTextFields["password-field"]
    await fulfillment(of: [expectation(for: NSPredicate { element, _ in
      (element as? XCUIElement)?.value(forKey: "hasKeyboardFocus") as? Bool == true
    }, evaluatedWith: password)], timeout: 10)
    password.typeText("fixture-only\n")
    let conversation = app.buttons["channel-visual-chat"]
    XCTAssertTrue(conversation.waitForExistence(timeout: 15))
    let passwordPrompt = app.buttons["Not Now"]
    if passwordPrompt.waitForExistence(timeout: 2) {
      passwordPrompt.tap()
      XCTAssertTrue(passwordPrompt.waitForNonExistence(timeout: 5))
    }
    await fulfillment(of: [expectation(for: NSPredicate(format: "hittable == true"),
      evaluatedWith: conversation)], timeout: 10)
    // The password sheet can disappear before its dismissal animation finishes.
    try await Task.sleep(for: .milliseconds(500))
    conversation.tap()
    let composer = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    XCTAssertTrue(composer.waitForExistence(timeout: 10))
    let draft = "Draft survives refresh with background tasks"
    composer.tap()
    composer.typeText(draft)
    app.buttons["chat-back"].tap()
    try await control("__qa/control", ["subagents": [task("running")]])

    // Confirm reconciliation has consumed the task before measuring each swipe.
    conversation.tap()
    let activity = app.descendants(matching: .any).matching(identifier: "bot-activity").firstMatch
    await waitForActivity(activity, visible: true)
    XCTAssertEqual(activity.label, "Working in the background")
    app.buttons["chat-back"].tap()
    await fulfillment(of: [expectation(for: NSPredicate(format: "hittable == true"),
      evaluatedWith: conversation)], timeout: 10)
    try await Task.sleep(for: .milliseconds(500))
    for _ in 0..<3 {
      let before = try await settingsReadCount()
      let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: 0.25))
      let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: 0.8))
      start.press(forDuration: 0.1, thenDragTo: end)
      var after = before
      for _ in 0..<30 {
        after = try await settingsReadCount()
        if after > before || app.alerts.firstMatch.exists { break }
        try await Task.sleep(for: .milliseconds(100))
      }
      if after == before {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.lifetime = .keepAlways
        add(screenshot)
      }
      XCTAssertGreaterThan(after, before, "A swipe must finish bootstrap decoding and fetch settings")
      XCTAssertFalse(app.alerts.firstMatch.exists, "Refreshing current task data must not present an error")
      XCTAssertTrue(conversation.exists)
      XCTAssertFalse(app.textFields["username-field"].exists)
    }
    conversation.tap()
    XCTAssertTrue(composer.waitForExistence(timeout: 10))
    XCTAssertEqual(composer.value as? String, draft)
    app.buttons["send-button"].tap()
    var delivered = false
    for _ in 0..<30 {
      let state = try await fixtureState()
      delivered = (state["messages"] as? [[String: Any]])?.contains {
        $0["content"] as? String == draft && $0["sender"] as? String == "user"
      } == true
      if delivered { break }
      try await Task.sleep(for: .milliseconds(100))
    }
    XCTAssertTrue(delivered, "The same authenticated session must still send after refreshing")
    try await control("__qa/control", ["authExpired": true])
    XCTAssertTrue(app.textFields["username-field"].waitForExistence(timeout: 12),
      "A genuinely expired session must still require sign-in")
  }
  private func fixtureState() async throws -> [String: Any] {
    let (data, response) = try await URLSession.shared.data(from: base.appendingPathComponent("__qa/state"))
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
  private func settingsReadCount() async throws -> Int {
    let state = try await fixtureState()
    return (state["requests"] as? [[String: Any]])?.filter {
      $0["method"] as? String == "GET" && $0["path"] as? String == "/api/v0/settings"
    }.count ?? 0
  }
  func testParkedRequestsAndChildrenHaveNoIndicatorUntilActualWake() async throws {
    continueAfterFailure = false
    try await control("__qa/scene", ["scene": "background-activity"])
    let old: [String: Any] = ["id": "old-follow-up", "botId": "bot-visual-chat",
      "channelId": "visual-chat", "status": "completed", "requestState": "waiting",
      "requestNextCheckAt": "2099-11-04T08:00:00Z"]
    let latest: [String: Any] = ["id": "latest-result", "botId": "bot-visual-chat",
      "channelId": "visual-chat", "status": "completed", "requestState": "complete"]
    let parked = (0..<8).map { index -> [String: Any] in
      var child = task("waiting")
      child["id"] = "parked-\(index)"
      child["subagentId"] = "parked-\(index)"
      return child
    }
    try await control("__qa/control", ["runs": [old, latest], "subagents": parked])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base.absoluteString,
      "--open-channel", "visual-chat"]
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(app.staticTexts["I’m checking the receipt. I’ll send you the tracking number when it’s ready."].waitForExistence(timeout: 15))
    let activity = app.descendants(matching: .any).matching(identifier: "bot-activity").firstMatch
    await waitForActivity(activity, visible: false)
    for status in ["queued", "running"] {
      var wake = old
      wake["id"] = "wake"
      wake["status"] = status
      try await control("__qa/control", ["runs": [old, latest, wake]])
      await waitForActivity(activity, visible: true)
      XCTAssertEqual(activity.label, "New Bot is working")
      try await control("__qa/control", ["runs": [old, latest]])
      await waitForActivity(activity, visible: false)
    }
    try await control("__qa/control", ["subagents": parked + [task("running")]])
    await waitForActivity(activity, visible: true)
    XCTAssertEqual(activity.label, "Working in the background")
    try await control("__qa/control", ["subagents": parked])
    await waitForActivity(activity, visible: false)
    XCTAssertFalse(app.staticTexts["Waiting for a result"].exists)
    XCTAssertFalse(app.staticTexts["Follow-up scheduled"].exists)
  }
  private func checkBackgroundTaskLifecycle(appearance: String) async throws {
    continueAfterFailure = false
    try await control("__qa/scene", ["scene": "background-activity"])
    try await control("__qa/control", ["subagents": [task("queued")]])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base.absoluteString,
      "--appearance", appearance, "--open-channel", "visual-chat"]
    app.launch()
    defer { app.terminate() }
    let activity = app.descendants(matching: .any).matching(identifier: "bot-activity").firstMatch
    // The bootstrap alone must reveal a queued task with no active parent run.
    XCTAssertTrue(activity.waitForExistence(timeout: 15))
    XCTAssertEqual(activity.label, "Working in the background")
    await waitForActivity(activity, visible: true)

    try await control("__qa/motion", ["active": true])
    let foreground = NSPredicate(format: "label == %@", "New Bot is working")
    await fulfillment(of: [expectation(for: foreground, evaluatedWith: activity)], timeout: 10)
    try await control("__qa/motion", ["active": false])
    let backgroundLabel = NSPredicate(format: "label == %@", "Working in the background")
    await fulfillment(of: [expectation(for: backgroundLabel, evaluatedWith: activity)], timeout: 10)

    for status in ["completed", "failed", "stopped"] {
      try await control("__qa/control", ["subagents": [task(status)]])
      await waitForActivity(activity, visible: false)
      try await control("__qa/control", ["subagents": [task("running")]])
      await waitForActivity(activity, visible: true)
      XCTAssertEqual(activity.label, "Working in the background")
    }
    for unrelated in [task("running", bot: "other-bot"), task("running", channel: "other-chat")] {
      try await control("__qa/control", ["subagents": [unrelated]])
      await waitForActivity(activity, visible: false)
    }
    try await control("__qa/control", ["subagents": [task("provisioning")]])
    await waitForActivity(activity, visible: true)
    try await control("__qa/control", ["subagents": []])
    await waitForActivity(activity, visible: false)
  }
}
