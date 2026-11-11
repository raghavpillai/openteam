import XCTest

@MainActor final class InboxActivityUITests: XCTestCase {
  private let base = ProcessInfo.processInfo.environment["UI_FIXTURE_SERVER"] ?? "http://127.0.0.1:20055"

  private func request(_ path: String, _ body: [String: Any] = [:]) async throws {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }

  private func launch() async throws -> XCUIApplication {
    continueAfterFailure = false
    try await request("/__qa/scene", ["scene": "inbox-activity"])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "dark"]
    app.launch()
    XCTAssertTrue(app.buttons["channel-activity-0"].waitForExistence(timeout: 20))
    return app
  }

  private func capture(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "inbox-activity-" + name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func bootstrapRequestCount(waitForEventLoop: Bool = false) async throws -> Int {
    for _ in 0..<75 {
      let (data, _) = try await URLSession.shared.data(from: URL(string: base + "/__qa/state")!)
      let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
      let requests = try XCTUnwrap(state["requests"] as? [[String: Any]])
      // Initial connection refreshes state before the event loop begins. Exclude
      // that required startup sync from requests caused by the pull gesture.
      if !waitForEventLoop || requests.contains(where: { ($0["path"] as? String) == "/api/v0/events/poll" }) {
        return requests.filter { ($0["path"] as? String) == "/api/v0/client-bootstrap" }.count
      }
      try await Task.sleep(for: .milliseconds(200))
    }
    XCTFail("Initial event loop did not start")
    return -1
  }

  func testBackgroundWorkQuestionPriorityAndLatestUserOrBotPreview() async throws {
    let app = try await launch()
    defer { app.terminate() }
    let background = app.buttons["channel-activity-0"]
    XCTAssertTrue(background.label.contains("??"))
    XCTAssertTrue(background.label.contains("Working"), "A bot-scoped background run needs a green badge")
    let question = app.buttons["channel-activity-1"]
    XCTAssertTrue(question.label.contains("Waiting for your answer"))
    XCTAssertFalse(question.label.contains("Working"), "Waiting takes priority over a running task")
    for (id, preview) in [(2, "Latest user message stays visible."), (3, "Latest bot reply stays visible.")] {
      let row = app.buttons["channel-activity-\(id)"]
      XCTAssertTrue(row.label.contains(preview))
      XCTAssertTrue(row.label.contains("Working"))
    }
    let idle = app.buttons["channel-activity-4"]
    XCTAssertTrue(idle.label.contains("Idle preview stays visible."))
    XCTAssertFalse(idle.label.contains("Working"), "Other bots' work must not leak into an idle row")
    XCTAssertFalse(idle.label.contains("Waiting for your answer"))
    capture("working-question-idle", app)
  }

  func testLiveQuestionResolutionAndFinishedWorkClearOnlyStatusBadges() async throws {
    let app = try await launch()
    defer { app.terminate() }
    let question = app.buttons["channel-activity-1"]
    XCTAssertTrue(question.label.contains("Waiting for your answer"))
    try await request("/__qa/update-message", ["id": "visual-message-activity-1-2",
      "metadata": ["respondedValue": "on-track"]])
    let answered = XCTNSPredicateExpectation(predicate: NSPredicate(format:
      "NOT (label CONTAINS %@) AND label CONTAINS %@", "Waiting for your answer", "Working"), object: question)
    await fulfillment(of: [answered], timeout: 12)
    capture("question-answered-working", app)
    try await request("/api/v0/runs/activity-run-0/cancel")
    for id in 0..<5 {
      let row = app.buttons["channel-activity-\(id)"]
      let idle = XCTNSPredicateExpectation(predicate: NSPredicate(format:
        "NOT (label CONTAINS %@) AND NOT (label CONTAINS %@)", "Working", "Waiting for your answer"), object: row)
      await fulfillment(of: [idle], timeout: 12)
    }
    XCTAssertTrue(app.buttons["channel-activity-2"].label.contains("Latest user message stays visible."))
    XCTAssertTrue(app.buttons["channel-activity-3"].label.contains("Latest bot reply stays visible."))
    capture("work-finished-previews-retained", app)
  }

  func testPullingInboxDoesNotTriggerRefresh() async throws {
    let app = try await launch()
    defer { app.terminate() }
    capture("before-downward-pull", app)
    let before = try await bootstrapRequestCount(waitForEventLoop: true)
    app.scrollViews["inbox-scroll"].swipeDown(velocity: .slow)
    app.scrollViews["inbox-scroll"].swipeDown(velocity: .slow)
    XCTAssertTrue(app.buttons["channel-activity-0"].isHittable)
    let after = try await bootstrapRequestCount()
    XCTAssertEqual(after, before, "Pulling down must not request a fresh bootstrap")
    capture("after-downward-pull-no-refresh", app)
  }
}
