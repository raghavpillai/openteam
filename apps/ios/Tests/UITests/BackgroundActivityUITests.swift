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
