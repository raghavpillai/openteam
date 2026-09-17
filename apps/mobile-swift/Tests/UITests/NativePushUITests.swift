import XCTest

/// Optional suite: real UNUserNotificationCenter + simctl push, inert loopback server.
@MainActor final class NativePushUITests: XCTestCase {
  let base = "http://127.0.0.1:20016"
  func request(_ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
    var request = URLRequest(url: URL(string: base + path)!)
    if let body {
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
  func launch(failRegistration: Int = 0, coldSession: Bool = false) async throws -> XCUIApplication
  {
    continueAfterFailure = false
    _ = try await request("/__push/reset", [:])
    _ = try await request("/__push/control", ["failRegistration": failRegistration])
    let app = XCUIApplication()
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
  func read(_ channel: String, _ message: String, _ activity: String) -> [String: Any] {
    ["channelId": channel, "lastReadSequence": message, "lastReadNotificationSequence": activity]
  }
  func observe(
    _ probe: String, expected: Set<String>, badge: Int? = nil, backgroundCapability: Bool = false
  ) async throws {
    for attempt in 0..<24 {
      if attempt % 6 == 0 { _ = try await request("/__push/probe", ["probe": probe]) }
      let state = try await request("/__push/state")
      let observations = state["observations"] as? [[String: Any]] ?? []
      if let observation = observations.last(where: {
        $0["probe"] as? String == probe || probe == "delivered"
      }),
        Set(observation["delivered"] as? [String] ?? []) == expected,
        badge == nil || observation["badge"] as? Int == badge
      {
        return
      }
      try await Task.sleep(for: .milliseconds(300))
    }
    let evidence = try JSONSerialization.data(
      withJSONObject: try await request("/__push/state"), options: [.prettyPrinted, .sortedKeys])
    let attachment = XCTAttachment(data: evidence, uniformTypeIdentifier: "public.json")
    attachment.name = "push-" + probe
    attachment.lifetime = .keepAlways
    add(attachment)
    if backgroundCapability {
      throw XCTSkip(
        "This simulator did not execute the background callback. A signed-device APNs test remains required; see attached delivery evidence."
      )
    }
    XCTFail(
      "Real notification center did not reach \(expected), badge \(String(describing: badge)) for \(probe)"
    )
  }
  func testDesktopReadsClearOnlyAcknowledgedNotificationsInBackground() async throws {
    let app = try await launch()
    let registration = try await waitRegistered()
    XCTAssertEqual(registration["provider"] as? String, "apns")
    XCTAssertEqual(registration["apnsEnvironment"] as? String, "development")
    XCTAssertEqual(registration["apnsTopic"] as? String, "dev.openteam.mobile.swift")
    let bootstrap = try await request("/api/v0/client-bootstrap")
    let channels = try XCTUnwrap(bootstrap["channels"] as? [[String: Any]])
    let c1 = try XCTUnwrap(channels.first?["id"] as? String)
    let c2 = try XCTUnwrap(channels.last?["id"] as? String)
    XCTAssertNotEqual(c1, c2)
    XCUIDevice.shared.press(.home)
    for (id, kind, channel, message, activity) in [
      ("old-message", "message", c1, "10", "100"), ("new-message", "message", c1, "11", "101"),
      ("new-reaction", "reaction", c1, "1", "102"), ("other-chat", "message", c2, "50", "200"),
    ] {
      _ = try await request(
        "/__push/deliver",
        [
          "qaID": id, "kind": kind, "channelId": channel, "messageSequence": message,
          "notificationSequence": activity,
        ])
    }
    try await observe(
      "delivered", expected: ["old-message", "new-message", "new-reaction", "other-chat"], badge: 4,
      backgroundCapability: true)
    _ = try await request(
      "/__push/read", ["readStates": [read(c1, "10", "100")], "badgeCount": 3, "probe": "partial"])
    try await observe(
      "partial", expected: ["new-message", "new-reaction", "other-chat"], badge: 3,
      backgroundCapability: true)
    _ = try await request("/__push/probe", ["probe": "stale", "readState": read(c1, "1", "0")])
    try await observe(
      "stale", expected: ["new-message", "new-reaction", "other-chat"], badge: 3,
      backgroundCapability: true)
    // APNs may coalesce two read events into one. Only c2 is in the wake payload;
    // the production snapshot endpoint supplies both channels' latest cursors.
    _ = try await request(
      "/__push/read",
      [
        "readStates": [read(c1, "11", "102"), read(c2, "50", "200")], "badgeCount": 0,
        "probe": "all-read",
      ])
    try await observe("all-read", expected: [], badge: 0, backgroundCapability: true)
    app.activate()
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "push-after-desktop-read"
    attachment.lifetime = .keepAlways
    add(attachment)
  }
  func testSelectiveReadCleanupInTheRealNotificationCenter() async throws {
    let app = try await launch()
    _ = try await waitRegistered()
    let bootstrap = try await request("/api/v0/client-bootstrap")
    let channels = try XCTUnwrap(bootstrap["channels"] as? [[String: Any]])
    let c1 = try XCTUnwrap(channels.first?["id"] as? String)
    let c2 = try XCTUnwrap(channels.last?["id"] as? String)
    XCUIDevice.shared.press(.home)
    for (id, kind, channel, message, activity) in [
      ("old-message", "message", c1, "10", "100"), ("new-message", "message", c1, "11", "101"),
      ("new-reaction", "reaction", c1, "1", "102"), ("other-chat", "message", c2, "50", "200"),
    ] {
      _ = try await request(
        "/__push/deliver",
        [
          "qaID": id, "kind": kind, "channelId": channel, "messageSequence": message,
          "notificationSequence": activity,
        ])
    }
    app.activate()
    try await observe(
      "delivered", expected: ["old-message", "new-message", "new-reaction", "other-chat"], badge: 4)
    _ = try await request(
      "/__push/read", ["readStates": [read(c1, "10", "100")], "badgeCount": 3, "notify": false])
    XCUIDevice.shared.press(.home)
    app.activate()
    try await observe(
      "delivered", expected: ["new-message", "new-reaction", "other-chat"], badge: 3)
    _ = try await request(
      "/__push/read",
      [
        "readStates": [read(c1, "11", "102"), read(c2, "50", "200")], "badgeCount": 0,
        "notify": false,
      ])
    XCUIDevice.shared.press(.home)
    app.activate()
    try await observe("delivered", expected: [], badge: 0)
    let evidence = try JSONSerialization.data(
      withJSONObject: try await request("/__push/state"), options: [.prettyPrinted, .sortedKeys])
    let attachment = XCTAttachment(data: evidence, uniformTypeIdentifier: "public.json")
    attachment.name = "selective-native-notification-removal"
    attachment.lifetime = .keepAlways
    add(attachment)
  }
  func testMissedBackgroundReadReconcilesOnForeground() async throws {
    let app = try await launch()
    _ = try await waitRegistered()
    let bootstrap = try await request("/api/v0/client-bootstrap")
    let channels = try XCTUnwrap(bootstrap["channels"] as? [[String: Any]])
    let channel = try XCTUnwrap(channels.first?["id"] as? String)
    XCUIDevice.shared.press(.home)
    _ = try await request(
      "/__push/deliver",
      [
        "qaID": "offline-message", "kind": "message", "channelId": channel, "messageSequence": "10",
        "notificationSequence": "100",
      ])
    app.activate()
    try await observe("delivered", expected: ["offline-message"], badge: 1)
    XCUIDevice.shared.press(.home)
    _ = try await request(
      "/__push/read",
      ["readStates": [read(channel, "10", "100")], "badgeCount": 0, "notify": false])
    let previous = (try await request("/__push/state"))["observations"] as? [[String: Any]] ?? []
    app.activate()
    for _ in 0..<30 {
      let reports = (try await request("/__push/state"))["observations"] as? [[String: Any]] ?? []
      if reports.dropFirst(previous.count).contains(where: {
        $0["probe"] as? String == "foreground" && ($0["delivered"] as? [String]) == []
          && $0["badge"] as? Int == 0
      }) {
        return
      }
      try await Task.sleep(for: .milliseconds(250))
    }
    XCTFail("Foreground catch-up did not clear delivered notifications without a wake")
  }
  func testNotificationTapColdLaunchesTheCorrectConversation() async throws {
    let app = try await launch(coldSession: true)
    _ = try await waitRegistered()
    let bootstrap = try await request("/api/v0/client-bootstrap")
    let channels = try XCTUnwrap(bootstrap["channels"] as? [[String: Any]])
    let channel = try XCTUnwrap(channels.first?["id"] as? String)
    XCUIDevice.shared.press(.home)
    _ = try await request(
      "/__push/deliver",
      [
        "qaID": "Tap to open this conversation", "kind": "message", "channelId": channel,
        "messageSequence": "99", "notificationSequence": "100",
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
    notification.tap()
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 12))
    let state = try await request("/__push/state")
    let receipts = state["receipts"] as? [[String: Any]] ?? []
    XCTAssertTrue(
      receipts.contains {
        ($0["path"] as? String) == "/api/v0/channels/" + channel + "/read"
          && $0["throughNotificationSequence"] as? String == "123"
      })
    let after = XCTAttachment(screenshot: app.screenshot())
    after.name = "native-notification-opened-chat"
    after.lifetime = .keepAlways
    add(after)
  }
  func testOpenConversationSuppressesItsForegroundBanner() async throws {
    let app = try await launch()
    _ = try await waitRegistered()
    let bootstrap = try await request("/api/v0/client-bootstrap")
    let channels = try XCTUnwrap(bootstrap["channels"] as? [[String: Any]])
    let channel = try XCTUnwrap(channels.first?["id"] as? String)
    app.buttons["channel-" + channel].tap()
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 8))
    _ = try await request(
      "/__push/deliver",
      [
        "qaID": "active-channel", "kind": "message", "channelId": channel, "messageSequence": "99",
        "notificationSequence": "100",
      ])
    for _ in 0..<30 {
      let reports = (try await request("/__push/state"))["observations"] as? [[String: Any]] ?? []
      if let report = reports.last(where: { $0["trigger"] as? String == "active-channel" }) {
        XCTAssertFalse((report["delivered"] as? [String] ?? []).contains("active-channel"))
        return
      }
      try await Task.sleep(for: .milliseconds(250))
    }
    XCTFail("No foreground notification delegate receipt")
  }
  func testRegistrationFailureRetryAndDisconnectRetirement() async throws {
    let app = try await launch(failRegistration: 10)
    app.buttons["settings-button"].tap()
    let retry = app.buttons["push-notifications-retry"]
    for _ in 0..<4 where !retry.isHittable { app.swipeUp() }
    XCTAssertTrue(retry.waitForExistence(timeout: 4))
    _ = try await request("/__push/control", ["failRegistration": 0])
    retry.tap()
    _ = try await waitRegistered()
    let toggle = app.switches["push-notifications-toggle"]
    XCTAssertTrue(toggle.isHittable)
    toggle.tap()
    for _ in 0..<30 {
      if (try await request("/__push/state"))["registration"] is NSNull { break }
      try await Task.sleep(for: .milliseconds(200))
    }
    let retiredState1 = try await request("/__push/state")
    XCTAssertTrue(retiredState1["registration"] is NSNull)
    toggle.tap()
    _ = try await waitRegistered()
    let signout = app.buttons["sign-out"]
    for _ in 0..<5 where !signout.isHittable { app.swipeUp() }
    signout.tap()
    app.buttons["Sign out"].tap()
    for _ in 0..<30 {
      if (try await request("/__push/state"))["registration"] is NSNull { break }
      try await Task.sleep(for: .milliseconds(200))
    }
    let retiredState2 = try await request("/__push/state")
    XCTAssertTrue(retiredState2["registration"] is NSNull)
  }
}
