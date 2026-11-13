import XCTest

/// Optional suite: real UNUserNotificationCenter + simctl push, inert loopback server.
@MainActor final class NativePushUITests: XCTestCase {
  let base = ProcessInfo.processInfo.environment["NATIVE_PUSH_SERVER"] ?? "http://127.0.0.1:20016"
  override func tearDown() async throws {
    if (testRun?.failureCount ?? 0) > 0, let state = try? await request("/__push/state"),
      let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]) {
      let evidence = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
      evidence.name = "native-push-failure-state"
      evidence.lifetime = .keepAlways
      add(evidence)
      let actions = (state["observations"] as? [[String: Any]] ?? []).filter {
        $0["stage"] as? String != "snapshot"
      }
      print("NOTIFICATION_FAILURE_ACTIONS \(actions)")
    }
  }
  func request(_ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
    var request = URLRequest(url: URL(string: base + path)!)
    if let body {
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    let value = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    return value
  }
  func launch(coldSession: Bool = false) async throws -> XCUIApplication {
    continueAfterFailure = false
    let app = XCUIApplication()
    app.terminate()
    _ = try await request("/__push/reset", [:])
    app.launchArguments = [
      "--ui-testing", "--server", base, "--appearance", "dark", "--qa-native-push",
      "--qa-push-reset", "--qa-push-token", String(repeating: "ab", count: 32),
    ]
    if coldSession { app.launchArguments.append("--qa-push-cold-launch") }
    app.launch()
    let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow"]
    if allow.waitForExistence(timeout: 3) { allow.tap() }
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 12))
    return app
  }
  func waitRegistered() async throws -> [String: Any] {
    for _ in 0..<40 {
      let value = try await request("/__push/state")
      if let registration = value["registration"] as? [String: Any] { return registration }
      try await Task.sleep(for: .milliseconds(250))
    }
    XCTFail("Native token was not registered")
    return [:]
  }
  private func background(_ app: XCUIApplication) throws {
    XCUIDevice.shared.press(.home)
    guard app.wait(for: .runningBackground, timeout: 4) || app.state == .runningBackgroundSuspended else {
      throw XCTSkip("This simulator keeps OpenTeam active after Home. Background lifecycle coverage requires a runtime that actually backgrounds the app.")
    }
  }
  private func openNotification(_ notification: XCUIElement, in app: XCUIApplication) {
    let body = notification.label
    // A collapsed Notification Center group expands on its first tap. Confirm
    // activation before asserting routing, resolving the alert again after
    // each group expansion instead of retaining a stale accessibility element.
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    for _ in 0..<3 {
      let alert = springboard.staticTexts[body]
      XCTAssertTrue(alert.waitForExistence(timeout: 5), springboard.debugDescription)
      alert.tap()
      if app.wait(for: .runningForeground, timeout: 4) { return }
      print("Notification Center is still visible; resolving its selected alert again")
    }
    XCTFail("Selecting the notification did not activate OpenTeam. " + springboard.debugDescription)
  }
  func observe(expected: Set<String>, badge: Int) async throws {
    for _ in 0..<50 {
      let state = try await request("/__push/state")
      if let observation = (state["observations"] as? [[String: Any]])?.last,
        Set(observation["delivered"] as? [String] ?? []) == expected,
        observation["badge"] as? Int == badge
      {
        return
      }
      try await Task.sleep(for: .milliseconds(300))
    }
    let state = try await request("/__push/state")
    let evidence = try JSONSerialization.data(
      withJSONObject: state, options: [.prettyPrinted, .sortedKeys])
    let attachment = XCTAttachment(data: evidence, uniformTypeIdentifier: "public.json")
    attachment.name = "push-delivered"
    attachment.lifetime = .keepAlways
    add(attachment)
    XCTFail(
      "Real notification center did not reach \(expected), badge \(badge). "
        + "Last observation \(String(describing: (state["observations"] as? [[String: Any]])?.last))"
    )
  }
  func testOpeningBotClearsItsNotificationsAndPreservesOtherChats() async throws {
    let (app, channel, sequence) = try await notifiedBot()
    app.buttons["channel-" + channel].tap()
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 10))
    try await observe(expected: ["other-chat"], badge: 1)
    let receipts = try await request("/__push/state")["receipts"] as? [[String: Any]] ?? []
    XCTAssertTrue(receipts.contains {
      $0["path"] as? String == "/api/v0/channels/" + channel + "/read"
        && $0["throughSequence"] as? String == sequence
        && $0["throughNotificationSequence"] as? String == "123"
    })
  }
  private func notifiedBot() async throws -> (XCUIApplication, String, String) {
    let app = try await launch()
    _ = try await waitRegistered()
    let bootstrap = try await request("/api/v0/client-bootstrap")
    let channels = try XCTUnwrap(bootstrap["channels"] as? [[String: Any]])
    let bot = try XCTUnwrap(channels.first { $0["kind"] as? String == "bot_dm" })
    let channel = try XCTUnwrap(bot["id"] as? String)
    let other = try XCTUnwrap(channels.first { $0["id"] as? String != channel }?["id"] as? String)
    let messages = try XCTUnwrap(bootstrap["latestMessages"] as? [[String: Any]])
    let message = try XCTUnwrap(messages.last { $0["channelId"] as? String == channel })
    let sequence = try XCTUnwrap(message["sequence"] as? String)
    let otherSequence = try XCTUnwrap(messages.last { $0["channelId"] as? String == other }?["sequence"] as? String)
    XCUIDevice.shared.press(.home)
    for (id, kind, target, messageSequence, activity) in [
      ("bot-message", "message", channel, sequence, "100"),
      ("bot-reaction", "reaction", channel, sequence, "102"),
      ("other-chat", "message", other, otherSequence, "200"),
    ] {
      _ = try await request("/__push/deliver", [
        "qaID": id, "kind": kind, "channelId": target,
        "messageSequence": messageSequence, "notificationSequence": activity,
      ])
    }
    app.activate()
    try await observe(expected: ["bot-message", "bot-reaction", "other-chat"], badge: 3)
    let conversation = app.buttons["channel-" + channel]
    XCTAssertTrue(conversation.waitForExistence(timeout: 10))
    return (app, channel, sequence)
  }
  func testNotificationTapColdLaunchesTheCorrectConversation() async throws {
    let app = try await launch(coldSession: true)
    _ = try await waitRegistered()
    let bootstrap = try await request("/api/v0/client-bootstrap")
    let channels = try XCTUnwrap(bootstrap["channels"] as? [[String: Any]])
    let channel = try XCTUnwrap(channels.first?["id"] as? String)
    try background(app)
    let created = try await request("/api/v0/channels/" + channel + "/messages", [
      "clientId": UUID().uuidString, "content": "Cold-launched notification reply",
    ])
    let message = try XCTUnwrap(created["message"] as? [String: Any])
    _ = try await request(
      "/__push/deliver",
      [
        "qaID": "Tap to open this conversation", "kind": "message", "channelId": channel,
        "messageSequence": try XCTUnwrap(message["sequence"] as? String), "notificationSequence": "100",
        "messageId": try XCTUnwrap(message["id"] as? String),
      ])
    app.terminate()
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.01)).press(
      forDuration: 0.1,
      thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.8)))
    let notification = springboard.staticTexts["Tap to open this conversation"]
    XCTAssertTrue(notification.waitForExistence(timeout: 8))
    let before = XCTAttachment(screenshot: springboard.screenshot())
    before.name = "native-notification-before-tap"
    before.lifetime = .keepAlways
    add(before)
    let selected = Date()
    openNotification(notification, in: app)
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 12))
    let target = app.tables["chat-history"].staticTexts["Cold-launched notification reply"]
    XCTAssertTrue(target.waitForExistence(timeout: 12))
    XCTAssertTrue(target.isHittable)
    print("NOTIFICATION_MESSAGE_VISIBLE cold-launch \(Date().timeIntervalSince(selected))")
    // Chat chrome appears before the transcript finishes positioning and marks itself read.
    var marked = false
    for _ in 0..<40 where !marked {
      let receipts = try await request("/__push/state")["receipts"] as? [[String: Any]] ?? []
      marked = receipts.contains {
        $0["path"] as? String == "/api/v0/channels/" + channel + "/read"
          && $0["throughNotificationSequence"] as? String == "123"
      }
      if !marked { try await Task.sleep(for: .milliseconds(100)) }
    }
    XCTAssertTrue(marked, "Opening the chat must acknowledge its notifications")
    let after = XCTAttachment(screenshot: app.screenshot())
    after.name = "native-notification-opened-chat"
    after.lifetime = .keepAlways
    add(after)
  }
}
