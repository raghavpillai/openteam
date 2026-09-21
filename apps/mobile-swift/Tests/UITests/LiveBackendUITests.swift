import XCTest

/// Optional production server/worker/database check; model responses are deterministic.
@MainActor final class LiveBackendUITests: XCTestCase {
  let base = "http://127.0.0.1:20007"
  func control(_ body: [String: Any]) async throws {
    var request = URLRequest(url: URL(string: base + "/__qa/control")!)
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
  func capture(_ name: String, _ app: XCUIApplication) {
    let item = XCTAttachment(screenshot: app.screenshot())
    item.name = "live-backend-" + name
    item.lifetime = .keepAlways
    add(item)
  }
  func find(_ target: XCUIElement, _ app: XCUIApplication) {
    for _ in 0..<8 {
      if target.isHittable { return }
      app.swipeUp()
    }
    XCTAssertTrue(target.isHittable)
  }
  func testProductionTextMessagesSupportHeldInlineReplyAndSwipe() async throws {
    continueAfterFailure = false
    try await control(["offline": false, "dropSend": false])
    let suffix = String(UUID().uuidString.prefix(8))
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "light"]
    app.launch()
    XCTAssertTrue(app.buttons["new-button"].waitForExistence(timeout: 20))
    app.buttons["new-button"].tap()
    app.buttons["New Bot"].tap()
    app.textFields["new-name"].tap()
    app.textFields["new-name"].typeText("Reply QA " + suffix)
    app.buttons["create-confirm"].tap()
    let greeting = app.staticTexts.matching(identifier: "Your QA bot is ready").firstMatch
    XCTAssertTrue(greeting.waitForExistence(timeout: 45))
    let snapshot = try await state()
    let bot = try XCTUnwrap(
      (snapshot["bots"] as? [[String: Any]])?.first {
        $0["name"] as? String == "Reply QA " + suffix
      })
    let botID = try XCTUnwrap(bot["id"] as? String)
    let turn = try XCTUnwrap(
      (snapshot["turns"] as? [[String: Any]])?.first { $0["botId"] as? String == botID })
    let original = try XCTUnwrap(
      (snapshot["messages"] as? [[String: Any]])?.first {
        $0["clientId"] as? String == "tool:native-qa:" + (turn["runId"] as? String ?? "")
      })
    XCTAssertEqual((original["metadata"] as? [String: Any])?["type"] as? String, "text")
    greeting.press(forDuration: 0.8)
    XCTAssertTrue(app.buttons["Reply"].waitForExistence(timeout: 5))
    capture("production-message-actions", app)
    app.buttons["Reply"].tap()
    XCTAssertTrue(app.buttons["thread-back"].waitForExistence(timeout: 5))
    let input = app.descendants(matching: .any).matching(identifier: "thread-message-input").firstMatch
    input.tap()
    let replyText = "Held inline reply " + suffix
    input.typeText(replyText)
    app.buttons["thread-send-button"].tap()
    var replies: [[String: Any]] = []
    for _ in 0..<45 {
      replies = (try await state()["messages"] as? [[String: Any]] ?? []).filter {
        $0["content"] as? String == replyText
      }
      if !replies.isEmpty { break }
      try await Task.sleep(for: .seconds(1))
    }
    XCTAssertEqual(replies.count, 1)
    let reply = try XCTUnwrap(replies.first)
    let metadata = try XCTUnwrap(reply["metadata"] as? [String: Any])
    XCTAssertEqual(metadata["replyTo"] as? String, original["id"] as? String)
    XCTAssertEqual(metadata["branched"] as? Bool, true)
    XCTAssertEqual(reply["channelId"] as? String, original["channelId"] as? String)
    app.buttons["thread-back"].tap()
    let quote = app.buttons["thread-" + (try XCTUnwrap(original["id"] as? String))]
    XCTAssertTrue(quote.waitForExistence(timeout: 15))
    capture("production-inline-reply", app)
    let from = greeting.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.5))
    from.press(
      forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 125, dy: 0)), withVelocity: .slow,
      thenHoldForDuration: 0.3)
    XCTAssertTrue(app.buttons["thread-back"].waitForExistence(timeout: 5))
    capture("production-swipe-reply", app)
  }
  func testProductionDeliveryAndScheduledExecutionWithAppClosed() async throws {
    continueAfterFailure = false
    executionTimeAllowance = 480
    try await control(["offline": false, "dropSend": false])
    let suffix = String(UUID().uuidString.prefix(8))
    let botName = "Swift QA " + suffix
    let routineName = "Scheduled QA " + suffix
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "light"]
    app.launch()
    XCTAssertTrue(app.buttons["new-button"].waitForExistence(timeout: 20))
    app.buttons["new-button"].tap()
    app.buttons["New Bot"].tap()
    app.textFields["new-name"].tap()
    app.textFields["new-name"].typeText(botName)
    app.buttons["create-confirm"].tap()
    let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    XCTAssertTrue(input.waitForExistence(timeout: 20))
    input.tap()
    let message = "Native QA delivery " + suffix
    input.typeText(message)
    try await control(["offline": true])
    app.buttons["send-button"].tap()
    XCTAssertTrue(app.staticTexts["Waiting for connection"].waitForExistence(timeout: 10))
    capture("offline-queued", app)
    try await control(["offline": false, "dropSend": true])
    XCTAssertTrue(app.staticTexts["Native QA reply received"].waitForExistence(timeout: 45))
    let settled = expectation(
      for: NSPredicate(format: "exists == false"),
      evaluatedWith: app.staticTexts["Waiting for connection"])
    await fulfillment(of: [settled], timeout: 30)
    let delivered = try await state()
    XCTAssertEqual(
      (delivered["messages"] as? [[String: Any]] ?? []).filter {
        $0["content"] as? String == message
      }.count, 1)
    capture("worker-reply", app)
    app.buttons["conversation-details"].tap()
    find(app.buttons["Routines"], app)
    app.buttons["Routines"].tap()
    app.buttons["Add routine"].tap()
    app.textFields["routine-name"].tap()
    app.textFields["routine-name"].typeText(routineName)
    app.textViews["routine-prompt"].tap()
    app.textViews["routine-prompt"].typeText(
      "SWIFT_SCHEDULE_CANARY: Confirm the scheduled task ran.")
    let schedule = app.textFields["routine-schedule"]
    find(schedule, app)
    schedule.tap()
    let prior = schedule.value as? String ?? ""
    schedule.typeText(
      String(repeating: XCUIKeyboardKey.delete.rawValue, count: prior.count) + "@every 5m")
    XCTAssertEqual(schedule.value as? String, "@every 5m")
    app.buttons["routine-save"].tap()
    XCTAssertTrue(app.staticTexts[routineName].waitForExistence(timeout: 15))
    capture("schedule-created", app)
    let created = try await state()
    let routine = try XCTUnwrap(
      (created["routines"] as? [[String: Any]])?.first { $0["name"] as? String == routineName })
    let routineID = try XCTUnwrap(routine["id"] as? String)
    XCTAssertNotNil(routine["nextRunAt"] as? String)
    app.terminate()
    // Wait for the real five-minute interval. Do not advance the database clock or dispatch manually.
    var executions: [[String: Any]] = []
    for _ in 0..<180 {
      let current = try await state()
      executions = (current["executions"] as? [[String: Any]] ?? []).filter {
        $0["routineId"] as? String == routineID
      }
      if executions.contains(where: {
        $0["kind"] as? String == "scheduled" && $0["status"] as? String == "completed"
      }) {
        break
      }
      try await Task.sleep(for: .seconds(2))
    }
    XCTAssertEqual(
      executions.filter {
        $0["kind"] as? String == "scheduled" && $0["status"] as? String == "completed"
      }.count, 1)
    // Pause the disposable routine after observing its scheduled result.
    let final = try await state()
    let latest = try XCTUnwrap(
      (final["routines"] as? [[String: Any]])?.first { $0["id"] as? String == routineID })
    var pause = URLRequest(url: URL(string: base + "/api/v0/routines/" + routineID + "/pause")!)
    pause.httpMethod = "POST"
    pause.setValue("application/json", forHTTPHeaderField: "Content-Type")
    pause.httpBody = try JSONSerialization.data(withJSONObject: [
      "clientId": UUID().uuidString, "expectedRevision": latest["revision"]!,
    ])
    let (_, response) = try await URLSession.shared.data(for: pause)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    app.launch()
    XCTAssertTrue(app.staticTexts[botName].waitForExistence(timeout: 20))
    app.staticTexts[botName].tap()
    XCTAssertTrue(app.staticTexts["Scheduled QA completed"].waitForExistence(timeout: 20))
    capture("scheduled-result-after-relaunch", app)
  }
}
