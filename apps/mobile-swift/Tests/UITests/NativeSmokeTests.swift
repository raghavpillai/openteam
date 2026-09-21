import XCTest

@MainActor
final class NativeSmokeTests: XCTestCase {
  let base = URL(string: "http://127.0.0.1:19997")!
  func control(_ path: String, body: [String: Bool] = [:]) async throws {
    var request = URLRequest(url: base.appendingPathComponent(path))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }
  func launch() async throws -> XCUIApplication {
    continueAfterFailure = false
    try await control("__qa/reset")
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--server", base.absoluteString, "--appearance", "light",
    ]
    app.launch()
    XCTAssertTrue(app.buttons["channel-channel-research"].waitForExistence(timeout: 15))
    return app
  }
  func capture(_ name: String, _ app: XCUIApplication) {
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = name
    screenshot.lifetime = .keepAlways
    add(screenshot)
  }
  func input(_ app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
  }
  func testThreadKeepsQueuedAndSuccessiveRepliesInItsOwnContext() async throws {
    let app = try await launch()
    app.buttons["channel-channel-research"].tap()
    let root = app.staticTexts[
      "On it. I’m separating verified behavior from assumptions before writing the mobile shell."]
    XCTAssertTrue(root.waitForExistence(timeout: 10))
    root.press(forDuration: 1)
    app.buttons["Start a thread"].tap()
    XCTAssertTrue(app.buttons["thread-back"].waitForExistence(timeout: 5))
    try await control("__qa/control", body: ["offline": true])
    app.textFields["thread-message-input"].tap()
    app.textFields["thread-message-input"].typeText("First isolated reply")
    XCTAssertEqual(app.textFields["thread-message-input"].value as? String, "First isolated reply")
    app.buttons["thread-send-button"].tap()
    XCTAssertTrue(app.staticTexts["Waiting for connection"].waitForExistence(timeout: 10))
    capture("native-thread-offline", app)
    app.buttons["thread-back"].tap()
    XCTAssertFalse(app.staticTexts["First isolated reply"].exists)
    root.press(forDuration: 1)
    app.buttons["Start a thread"].tap()
    XCTAssertTrue(app.staticTexts["First isolated reply"].waitForExistence(timeout: 5))
    try await control("__qa/control", body: ["offline": false])
    let reconciled = expectation(
      for: NSPredicate(format: "exists == false"),
      evaluatedWith: app.staticTexts["Waiting for connection"])
    await fulfillment(of: [reconciled], timeout: 20)
    app.textFields["thread-message-input"].tap()
    app.textFields["thread-message-input"].typeText("Second isolated reply")
    XCTAssertEqual(app.textFields["thread-message-input"].value as? String, "Second isolated reply")
    app.buttons["thread-send-button"].tap()
    var replies: [[String: Any]] = []
    for _ in 0..<30 {
      let (data, _) = try await URLSession.shared.data(
        from: base.appendingPathComponent("__qa/state"))
      let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
      replies = (state["messages"] as? [[String: Any]] ?? []).filter {
        ($0["content"] as? String)?.contains("isolated reply") == true
      }
      if replies.count == 2 { break }
      try await Task.sleep(for: .milliseconds(300))
    }
    XCTAssertEqual(replies.count, 2)
    for reply in replies {
      let metadata = try XCTUnwrap(reply["metadata"] as? [String: Any])
      XCTAssertEqual(metadata["branched"] as? Bool, true)
      XCTAssertEqual(metadata["replyTo"] as? String, "message-3")
    }
    capture("native-thread-reconciled", app)
    app.buttons["thread-back"].tap()
    XCTAssertFalse(app.staticTexts["First isolated reply"].exists)
    XCTAssertFalse(app.staticTexts["Second isolated reply"].exists)
  }
  func testChatKeyboardSendAndLostAcknowledgment() async throws {
    let app = try await launch()
    capture("native-home-light", app)
    app.buttons["channel-channel-research"].tap()
    XCTAssertTrue(input(app).waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["conversation-details"].exists)
    capture("native-chat-light", app)
    input(app).tap()
    input(app).typeText("Native keyboard parity")
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    XCTAssertLessThanOrEqual(input(app).frame.maxY, app.keyboards.firstMatch.frame.minY + 1)
    capture("native-keyboard-short", app)
    input(app).typeText(
      "\nSecond line\nThird line\nFourth line\nFifth line\nSixth line\nSeventh line")
    XCTAssertLessThanOrEqual(
      app.buttons["send-button"].frame.maxY, app.keyboards.firstMatch.frame.minY + 1)
    capture("native-keyboard-multiline", app)
    try await control("__qa/control", body: ["dropNextSend": true])
    app.buttons["send-button"].tap()
    let empty = NSPredicate(format: "value == %@ OR value == %@", "", "Ask Research")
    let emptied = expectation(for: empty, evaluatedWith: input(app))
    await fulfillment(of: [emptied], timeout: 10)
    let (data, _) = try await URLSession.shared.data(
      from: base.appendingPathComponent("__qa/state"))
    let state = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    let messages = state["messages"] as! [[String: Any]]
    XCTAssertEqual(
      messages.filter { ($0["content"] as? String)?.hasPrefix("Native keyboard parity") == true }
        .count, 1)
    capture("native-message-accepted", app)
  }
  func testSettingsAppearanceSearchAndCreate() async throws {
    let app = try await launch()
    app.buttons["settings-button"].tap()
    XCTAssertTrue(app.buttons["appearance-picker"].waitForExistence(timeout: 5))
    capture("native-settings-light", app)
    app.buttons["appearance-picker"].tap()
    app.buttons["Dark"].tap()
    capture("native-settings-dark", app)
    app.buttons["sheet-close"].tap()
    app.buttons["channel-channel-research"].tap()
    XCTAssertTrue(input(app).waitForExistence(timeout: 10))
    capture("native-chat-dark", app)
    app.buttons["chat-back"].tap()
    app.buttons["settings-button"].tap()
    app.buttons["appearance-picker"].tap()
    app.buttons["Light"].tap()
    app.buttons["sheet-close"].tap()
    app.buttons["search-button"].tap()
    XCTAssertTrue(app.textFields["search-input"].waitForExistence(timeout: 5))
    app.textFields["search-input"].tap()
    app.textFields["search-input"].typeText("concise")
    let result = app.buttons.matching(
      NSPredicate(format: "label BEGINSWITH %@", "Research, Message, I pulled")
    ).firstMatch
    XCTAssertTrue(result.waitForExistence(timeout: 10))
    capture("native-search", app)
    result.tap()
    XCTAssertTrue(input(app).waitForExistence(timeout: 10))
    app.buttons["chat-back"].tap()
    app.buttons["new-button"].tap()
    app.buttons["New Bot"].tap()
    XCTAssertTrue(app.textFields["new-name"].waitForExistence(timeout: 5))
    app.textFields["new-name"].tap()
    app.textFields["new-name"].typeText("Native QA bot")
    capture("native-create-bot", app)
    app.buttons["create-confirm"].tap()
    XCTAssertTrue(input(app).waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["conversation-details"].exists)
  }
  func testOfflineMessageReconcilesAfterReconnect() async throws {
    let app = try await launch()
    app.buttons["channel-channel-research"].tap()
    XCTAssertTrue(input(app).waitForExistence(timeout: 10))
    try await control("__qa/control", body: ["offline": true])
    input(app).tap()
    input(app).typeText("Offline native recovery")
    app.buttons["send-button"].tap()
    XCTAssertTrue(app.staticTexts["Waiting for connection"].waitForExistence(timeout: 10))
    capture("native-offline-queued", app)
    try await control("__qa/control", body: ["offline": false])
    var accepted = false
    for _ in 0..<30 {
      let (data, _) = try await URLSession.shared.data(
        from: base.appendingPathComponent("__qa/state"))
      let state = try JSONSerialization.jsonObject(with: data) as! [String: Any]
      let messages = state["messages"] as! [[String: Any]]
      let count = messages.filter { $0["content"] as? String == "Offline native recovery" }.count
      XCTAssertLessThanOrEqual(count, 1)
      if count == 1 {
        accepted = true
        break
      }
      try await Task.sleep(for: .milliseconds(300))
    }
    XCTAssertTrue(accepted)
    let reconciled = expectation(
      for: NSPredicate(format: "exists == false"),
      evaluatedWith: app.staticTexts["Waiting for connection"])
    await fulfillment(of: [reconciled], timeout: 10)
    capture("native-offline-recovered", app)
  }

  func testApprovalResolvesOnServer() async throws {
    let app = try await launch()
    app.buttons["channel-channel-research"].tap()
    let approve = app.buttons["approve-approval-1"]
    XCTAssertTrue(approve.waitForExistence(timeout: 10))
    if !approve.isHittable { app.swipeUp() }
    capture("native-approval", app)
    approve.tap()
    let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: approve)
    await fulfillment(of: [gone], timeout: 10)
    let (data, _) = try await URLSession.shared.data(
      from: base.appendingPathComponent("__qa/state"))
    let state = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    XCTAssertEqual((state["approvals"] as! [[String: Any]])[0]["status"] as? String, "accepted")
  }
}
