import XCTest

/// Optional suite: real UNUserNotificationCenter + simctl push, inert loopback server.
@MainActor final class NativePushUITests: XCTestCase {
  let base = ProcessInfo.processInfo.environment["NATIVE_PUSH_SERVER"] ?? "http://127.0.0.1:20016"
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
    if value["simulatorUnsupported"] as? Bool == true {
      throw XCTSkip("This simulator rejects silent notification pushes. Device APNs delivery requires a signed-device check.")
    }
    return value
  }
  func launch(failRegistration: Int = 0, coldSession: Bool = false,
    backgroundTask: Bool = false) async throws -> XCUIApplication
  {
    continueAfterFailure = false
    let app = XCUIApplication()
    app.terminate()
    _ = try await request("/__push/reset", [:])
    _ = try await request("/__push/control", ["failRegistration": failRegistration])
    if backgroundTask {
      let bootstrap = try await request("/api/v0/client-bootstrap")
      let bots = try XCTUnwrap(bootstrap["bots"] as? [[String: Any]])
      let bot = try XCTUnwrap(bots.first)
      _ = try await request("/__qa/control", ["subagents": [[
        "id": "current-server-task", "parentBotId": try XCTUnwrap(bot["id"] as? String),
        "parentChannelId": try XCTUnwrap(bot["dmChannelId"] as? String), "status": "running",
      ]]])
    }
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
  func waitPresence(_ active: Bool) async throws -> [String: Any] {
    for _ in 0..<30 {
      let value = try await request("/__push/state")
      if let last = (value["presence"] as? [[String: Any]])?.last,
        last["active"] as? Bool == active { return last }
      try await Task.sleep(for: .milliseconds(200))
    }
    XCTFail("Native presence did not become \(active)")
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
      let alert = springboard.buttons.matching(identifier: "ShortLook.Platter.Content.Seamless")
        .containing(.staticText, identifier: body).firstMatch
      XCTAssertTrue(alert.waitForExistence(timeout: 5))
      alert.tap()
      if app.wait(for: .runningForeground, timeout: 4) { return }
      print("Notification Center is still visible; resolving its selected alert again")
    }
    XCTFail("Selecting the notification did not activate OpenTeam. " + springboard.debugDescription)
  }
  func testSmartNotificationPresenceAndPreferenceFollowNativeLifecycle() async throws {
    let app = try await launch()
    _ = try await waitRegistered()
    let first = try await waitPresence(true)
    try background(app)
    let background = try await waitPresence(false)
    XCTAssertEqual(first["clientId"] as? String, background["clientId"] as? String)
    XCTAssertGreaterThan(background["sequence"] as? Int ?? 0, first["sequence"] as? Int ?? 0)
    app.activate()
    _ = try await waitPresence(true)
    app.buttons["settings-button"].tap()
    let smart = app.switches["smart-notifications-toggle"]
    if !smart.isHittable { app.swipeUp() }
    XCTAssertTrue(smart.waitForExistence(timeout: 5))
    (smart.switches.firstMatch.exists ? smart.switches.firstMatch : smart).tap()
    for _ in 0..<20 {
      if (try await request("/__push/state"))["smartEnabled"] as? Bool == false { break }
      try await Task.sleep(for: .milliseconds(200))
    }
    let state = try await request("/__push/state")
    XCTAssertEqual(state["smartEnabled"] as? Bool, false)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "smart-notification-settings"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    let notifications = app.switches["push-notifications-toggle"]
    if !notifications.isHittable { app.swipeUp() }
    (notifications.switches.firstMatch.exists ? notifications.switches.firstMatch : notifications).tap()
    _ = try await waitPresence(false)
  }
  func read(_ channel: String, _ message: String, _ activity: String) -> [String: Any] {
    ["channelId": channel, "lastReadSequence": message, "lastReadNotificationSequence": activity]
  }
  func observe(
    _ probe: String, expected: Set<String>, badge: Int? = nil, backgroundCapability: Bool = false,
    after observationCount: Int = 0
  ) async throws {
    for attempt in 0..<50 {
      if probe != "delivered", attempt % 6 == 0 {
        _ = try await request("/__push/probe", ["probe": probe])
      }
      let state = try await request("/__push/state")
      let observations = state["observations"] as? [[String: Any]] ?? []
      if let observation = observations.dropFirst(observationCount).last(where: {
        $0["probe"] as? String == probe || probe == "delivered"
      }),
        Set(observation["delivered"] as? [String] ?? []) == expected,
        badge == nil || observation["badge"] as? Int == badge
      {
        return
      }
      try await Task.sleep(for: .milliseconds(300))
    }
    let state = try await request("/__push/state")
    let evidence = try JSONSerialization.data(
      withJSONObject: state, options: [.prettyPrinted, .sortedKeys])
    let attachment = XCTAttachment(data: evidence, uniformTypeIdentifier: "public.json")
    attachment.name = "push-" + probe
    attachment.lifetime = .keepAlways
    add(attachment)
    if backgroundCapability {
      throw XCTSkip(
        "This simulator did not execute the background callback. A signed-device APNs test remains required; see attached delivery evidence."
      )
    }
    let lastObservation = (state["observations"] as? [[String: Any]])?.last
    XCTFail(
      "Real notification center did not reach \(expected), badge \(String(describing: badge)) for \(probe). "
        + "Last observation \(String(describing: lastObservation)), reads \(String(describing: state["reads"]))"
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
    try background(app)
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
    try background(app)
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
    try background(app)
    app.activate()
    try await observe(
      "delivered", expected: ["new-message", "new-reaction", "other-chat"], badge: 3)
    _ = try await request(
      "/__push/read",
      [
        "readStates": [read(c1, "11", "102"), read(c2, "50", "200")], "badgeCount": 0,
        "notify": false,
      ])
    try background(app)
    app.activate()
    try await observe("delivered", expected: [], badge: 0)
    let evidence = try JSONSerialization.data(
      withJSONObject: try await request("/__push/state"), options: [.prettyPrinted, .sortedKeys])
    let attachment = XCTAttachment(data: evidence, uniformTypeIdentifier: "public.json")
    attachment.name = "selective-native-notification-removal"
    attachment.lifetime = .keepAlways
    add(attachment)
  }
  func testOpeningBotClearsItsNotificationsAndPreservesOtherChats() async throws {
    let (app, channel, sequence) = try await notifiedBot()
    app.buttons["channel-" + channel].tap()
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 10))
    try await observe("delivered", expected: ["other-chat"], badge: 1)
    let receipts = try await request("/__push/state")["receipts"] as? [[String: Any]] ?? []
    XCTAssertTrue(receipts.contains {
      $0["path"] as? String == "/api/v0/channels/" + channel + "/read"
        && $0["throughSequence"] as? String == sequence
        && $0["throughNotificationSequence"] as? String == "123"
    })
  }
  private func notifiedBot(backgroundTask: Bool = false) async throws -> (XCUIApplication, String, String) {
    let app = try await launch(backgroundTask: backgroundTask)
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
    try await observe("delivered", expected: ["bot-message", "bot-reaction", "other-chat"], badge: 3)
    let conversation = app.buttons["channel-" + channel]
    XCTAssertTrue(conversation.waitForExistence(timeout: 10))
    return (app, channel, sequence)
  }
  func testReadFailuresRecoverWithoutLeavingTheBot() async throws {
    let (app, channel, _) = try await notifiedBot()
    _ = try await request("/__push/control", ["readFailures": 3])
    app.buttons["channel-" + channel].tap()
    try await observe("delivered", expected: ["other-chat"], badge: 1)
    let receipts = try await request("/__push/state")["receipts"] as? [[String: Any]] ?? []
    XCTAssertGreaterThanOrEqual(receipts.filter { $0["path"] as? String == "/api/v0/channels/" + channel + "/read" }.count, 4)
  }
  func testCurrentServerTasksDoNotBlockNotificationReadRecovery() async throws {
    let (app, channel, _) = try await notifiedBot(backgroundTask: true)
    _ = try await request("/__push/control", ["readFailures": 1])
    app.buttons["channel-" + channel].tap()
    try await observe("delivered", expected: ["other-chat"], badge: 1)
  }
  func testLostReadAcknowledgementRecoversWithoutLeavingTheBot() async throws {
    let (app, channel, _) = try await notifiedBot()
    _ = try await request("/__push/control", ["lostReadResponses": 1])
    app.buttons["channel-" + channel].tap()
    try await observe("delivered", expected: ["other-chat"], badge: 1)
  }
  func testReturningToAlreadyOpenBotAcknowledgesNewReaction() async throws {
    let (app, channel, sequence) = try await notifiedBot()
    app.buttons["channel-" + channel].tap()
    try await observe("delivered", expected: ["other-chat"], badge: 1)
    try background(app)
    _ = try await request("/__push/deliver", [
      "qaID": "new-reaction", "kind": "reaction", "channelId": channel,
      "messageSequence": sequence, "notificationSequence": "500",
    ])
    let observations = try await request("/__push/state")["observations"] as? [[String: Any]] ?? []
    app.activate()
    try await observe("delivered", expected: ["other-chat"], badge: 1, after: observations.count)
    let state = try await request("/__push/state")
    XCTAssertEqual((state["reads"] as? [String: [String: Any]])?[channel]?["lastReadNotificationSequence"] as? String, "500")
  }
  func testForegroundReactionIsReadWithoutScrolling() async throws {
    let (app, channel, sequence) = try await notifiedBot()
    app.buttons["channel-" + channel].tap()
    try await observe("delivered", expected: ["other-chat"], badge: 1)
    let observations = try await request("/__push/state")["observations"] as? [[String: Any]] ?? []
    _ = try await request("/__push/deliver", [
      "qaID": "foreground-reaction", "kind": "reaction", "channelId": channel,
      "messageSequence": sequence, "notificationSequence": "500",
    ])
    try await observe("delivered", expected: ["other-chat"], badge: 1, after: observations.count)
    let state = try await request("/__push/state")
    XCTAssertEqual((state["reads"] as? [String: [String: Any]])?[channel]?["lastReadNotificationSequence"] as? String, "500")
  }
  func testKnownReadNotificationsClearDuringAnOfflineResume() async throws {
    let (app, channel, sequence) = try await notifiedBot()
    app.buttons["channel-" + channel].tap()
    try await observe("delivered", expected: ["other-chat"], badge: 1)
    try background(app)
    _ = try await request("/__push/deliver", [
      "qaID": "late-read-message", "kind": "message", "channelId": channel,
      "messageSequence": sequence, "notificationSequence": "100",
    ])
    _ = try await request("/__push/control", ["offline": true])
    let observations = try await request("/__push/state")["observations"] as? [[String: Any]] ?? []
    app.activate()
    // A read marker already saved on this device must retire a late alert even
    // when the notification snapshot and chat bootstrap are unreachable.
    try await observe("delivered", expected: ["other-chat"], after: observations.count)
  }
  func testReadCleanupSurvivesNotificationSnapshotFailure() async throws {
    let (app, channel, _) = try await notifiedBot()
    _ = try await request("/__push/control", ["unavailable": true])
    app.buttons["channel-" + channel].tap()
    try await observe("delivered", expected: ["other-chat"])
    _ = try await request("/__push/control", ["unavailable": false])
    try background(app)
    let observations = try await request("/__push/state")["observations"] as? [[String: Any]] ?? []
    app.activate()
    try await observe("delivered", expected: ["other-chat"], badge: 1, after: observations.count)
  }
  func testDelayedReadAndSnapshotResponsesRecover() async throws {
    let (app, channel, _) = try await notifiedBot()
    _ = try await request("/__push/control", ["readDelayMs": 1500, "snapshotDelayMs": 2000])
    app.buttons["channel-" + channel].tap()
    try await observe("delivered", expected: ["other-chat"], badge: 1)
  }
  func testOfflineConnectionRecoveryClearsTheOpenBotsAlerts() async throws {
    let (app, channel, sequence) = try await notifiedBot()
    app.buttons["channel-" + channel].tap()
    try await observe("delivered", expected: ["other-chat"], badge: 1)
    try background(app)
    _ = try await request("/__push/control", ["offline": true])
    _ = try await request("/__push/deliver", [
      "qaID": "offline-reaction", "kind": "reaction", "channelId": channel,
      "messageSequence": sequence, "notificationSequence": "500",
    ])
    let observations = try await request("/__push/state")["observations"] as? [[String: Any]] ?? []
    app.activate()
    try await observe("delivered", expected: ["other-chat", "offline-reaction"], after: observations.count)
    _ = try await request("/__push/control", ["offline": false])
    try await observe("delivered", expected: ["other-chat"], badge: 1)
  }
  func testSwitchingBotsStopsRetriesAndPreservesUnreadAlerts() async throws {
    let (app, channel, _) = try await notifiedBot()
    let bootstrap = try await request("/api/v0/client-bootstrap")
    let channels = try XCTUnwrap(bootstrap["channels"] as? [[String: Any]])
    let other = try XCTUnwrap(channels.first { $0["id"] as? String != channel }?["id"] as? String)
    _ = try await request("/__push/control", ["readFailures": 100])
    app.buttons["channel-" + channel].tap()
    let back = app.buttons["chat-back"]
    if back.exists { back.tap() }
    let otherBot = app.buttons["channel-" + other]
    if !otherBot.isHittable { app.buttons["chat-sidebar"].tap() }
    otherBot.tap()
    let before = try await request("/__push/state")["receipts"] as? [[String: Any]] ?? []
    _ = try await request("/__push/control", ["readFailures": 0])
    try await Task.sleep(for: .seconds(3))
    let after = try await request("/__push/state")["receipts"] as? [[String: Any]] ?? []
    let readPath = "/api/v0/channels/" + channel + "/read"
    XCTAssertEqual(before.filter { $0["path"] as? String == readPath }.count,
      after.filter { $0["path"] as? String == readPath }.count,
      "Leaving a bot must cancel its read retries")
    if back.exists { back.tap() }
    let original = app.buttons["channel-" + channel]
    if !original.isHittable { app.buttons["chat-sidebar"].tap() }
    original.tap()
    // Both conversations have now actually been opened and read.
    try await observe("delivered", expected: [], badge: 0)
  }
  func testReadLedgerSurvivesRelaunchAndLateDuplicate() async throws {
    let (app, channel, sequence) = try await notifiedBot()
    app.buttons["channel-" + channel].tap()
    try await observe("delivered", expected: ["other-chat"], badge: 1)
    app.terminate()
    _ = try await request("/__push/deliver", [
      "qaID": "late-duplicate", "kind": "message", "channelId": channel,
      "messageSequence": sequence, "notificationSequence": "100", "badgeOverride": 9,
    ])
    let observations = try await request("/__push/state")["observations"] as? [[String: Any]] ?? []
    app.launchArguments.removeAll { $0 == "--qa-push-reset" }
    app.launch()
    try await observe("delivered", expected: ["other-chat"], badge: 1, after: observations.count)
  }
  func testRepeatedResumeRecoversFromChangingFailuresAndDuplicateDelivery() async throws {
    let (app, channel, sequence) = try await notifiedBot()
    app.buttons["channel-" + channel].tap()
    try await observe("delivered", expected: ["other-chat"], badge: 1)
    for cycle in 0..<4 {
      try background(app)
      _ = try await request("/__push/control", [
        "readFailures": cycle % 3, "readDelayMs": cycle * 150,
        "lostReadResponses": cycle % 2,
      ])
      _ = try await request("/__push/deliver", [
        "qaID": "reaction-\(cycle)", "kind": "reaction", "channelId": channel,
        "messageSequence": sequence, "notificationSequence": String(500 + cycle),
      ])
      _ = try await request("/__push/deliver", [
        "qaID": "duplicate-\(cycle)", "kind": "message", "channelId": channel,
        "messageSequence": sequence, "notificationSequence": "100",
      ])
      let observations = try await request("/__push/state")["observations"] as? [[String: Any]] ?? []
      app.activate()
      try await observe("delivered", expected: ["other-chat"], badge: 1, after: observations.count)
    }
  }
  func testNewReactionDuringDelayedReadRemainsUnreadAfterLeavingTheBot() async throws {
    let (app, channel, sequence) = try await notifiedBot()
    let bootstrap = try await request("/api/v0/client-bootstrap")
    let channels = try XCTUnwrap(bootstrap["channels"] as? [[String: Any]])
    let third = try XCTUnwrap(channels.last?["id"] as? String)
    _ = try await request("/__push/control", ["readDelayMs": 5000])
    app.buttons["channel-" + channel].tap()
    let readPath = "/api/v0/channels/" + channel + "/read"
    var requested = false
    for _ in 0..<40 {
      let receipts = try await request("/__push/state")["receipts"] as? [[String: Any]] ?? []
      requested = receipts.contains { $0["path"] as? String == readPath }
      if requested { break }
      try await Task.sleep(for: .milliseconds(100))
    }
    XCTAssertTrue(requested)
    let back = app.buttons["chat-back"]
    if back.exists { back.tap() }
    let thirdBot = app.buttons["channel-" + third]
    if !thirdBot.isHittable { app.buttons["chat-sidebar"].tap() }
    thirdBot.tap()
    _ = try await request("/__push/deliver", [
      "qaID": "newer-reaction", "kind": "reaction", "channelId": channel,
      "messageSequence": sequence, "notificationSequence": "500",
    ])
    var acknowledged: String?
    for _ in 0..<100 {
      let state = try await request("/__push/state")
      acknowledged = (state["reads"] as? [String: [String: Any]])?[channel]?["lastReadNotificationSequence"] as? String
      if acknowledged != nil { break }
      try await Task.sleep(for: .milliseconds(100))
    }
    XCTAssertEqual(acknowledged, "123")
    // The read event reconciles the old acknowledgement while another bot is
    // selected, preserving the newer reaction in the bot we already left.
    try await observe("delivered", expected: ["other-chat", "newer-reaction"], badge: 2)
  }
  func testMissedBackgroundReadReconcilesOnForeground() async throws {
    let app = try await launch()
    _ = try await waitRegistered()
    let bootstrap = try await request("/api/v0/client-bootstrap")
    let channels = try XCTUnwrap(bootstrap["channels"] as? [[String: Any]])
    let channel = try XCTUnwrap(channels.first?["id"] as? String)
    try background(app)
    _ = try await request(
      "/__push/deliver",
      [
        "qaID": "offline-message", "kind": "message", "channelId": channel, "messageSequence": "10",
        "notificationSequence": "100",
      ])
    app.activate()
    try await observe("delivered", expected: ["offline-message"], badge: 1)
    try background(app)
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
    try background(app)
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
    openNotification(notification, in: app)
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 12))
    // Chat chrome appears before the transcript finishes positioning and marks itself read.
    var receipts: [[String: Any]] = []
    for _ in 0..<40 {
      let state = try await request("/__push/state")
      receipts = state["receipts"] as? [[String: Any]] ?? []
      if receipts.contains(where: {
        $0["path"] as? String == "/api/v0/channels/" + channel + "/read"
          && $0["throughNotificationSequence"] as? String == "123"
      }) { break }
      try await Task.sleep(for: .milliseconds(100))
    }
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
  func testNotificationTapOpensTheThreadReply() async throws {
    let app = try await launch()
    _ = try await waitRegistered()
    let bootstrap = try await request("/api/v0/client-bootstrap")
    let channels = try XCTUnwrap(bootstrap["channels"] as? [[String: Any]])
    let channel = try XCTUnwrap(channels.first?["id"] as? String)
    let posted = try await request(
      "/api/v0/channels/" + channel + "/messages",
      ["clientId": UUID().uuidString, "content": "Thread root for push QA"])
    let rootID = try XCTUnwrap((posted["message"] as? [String: Any])?["id"] as? String)
    let threaded = try await request(
      "/api/v0/channels/" + channel + "/messages",
      [
        "clientId": UUID().uuidString, "content": "Threaded push reply",
        "replyToMessageId": rootID, "isFork": true,
      ])
    let reply = try XCTUnwrap(threaded["message"] as? [String: Any])
    try background(app)
    _ = try await request(
      "/__push/deliver",
      [
        "qaID": "Tap to open the thread reply", "kind": "message", "channelId": channel,
        "messageSequence": try XCTUnwrap(reply["sequence"] as? String),
        "notificationSequence": "100", "threadMessageId": try XCTUnwrap(reply["id"] as? String),
      ])
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.01)).press(
      forDuration: 0.1,
      thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.8)))
    let notification = springboard.staticTexts["Tap to open the thread reply"]
    XCTAssertTrue(notification.waitForExistence(timeout: 8))
    openNotification(notification, in: app)
    XCTAssertTrue(app.buttons["thread-back"].waitForExistence(timeout: 12), app.debugDescription)
    XCTAssertTrue(app.staticTexts["Threaded push reply"].waitForExistence(timeout: 5))
    let opened = XCTAttachment(screenshot: app.screenshot())
    opened.name = "native-notification-opened-thread"
    opened.lifetime = .keepAlways
    add(opened)
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
    (toggle.switches.firstMatch.exists ? toggle.switches.firstMatch : toggle).tap()
    XCTAssertEqual(toggle.value as? String, "0")
    for _ in 0..<30 {
      if (try await request("/__push/state"))["registration"] is NSNull { break }
      try await Task.sleep(for: .milliseconds(200))
    }
    let retiredState1 = try await request("/__push/state")
    XCTAssertTrue(retiredState1["registration"] is NSNull)
    (toggle.switches.firstMatch.exists ? toggle.switches.firstMatch : toggle).tap()
    XCTAssertEqual(toggle.value as? String, "1")
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
  func testReauthenticationClearsLocallyWhenPushRetirementFails() async throws {
    let app = try await launch()
    let previous = try await waitRegistered()
    _ = try await request("/__push/control", ["failUnregister": 1])
    app.buttons["settings-button"].tap()
    app.buttons["account-settings"].tap()
    app.buttons["re-auth"].tap()
    XCTAssertTrue(app.textFields["server-field"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["cancel-re-auth"].exists)
    XCTAssertFalse(app.buttons["clear-server"].exists)
    app.textFields["server-field"].tap()
    app.textFields["server-field"].typeText(base)
    app.buttons["connect-button"].tap()
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 12))
    var replacement: [String: Any] = [:]
    for _ in 0..<40 {
      replacement = try await waitRegistered()
      if replacement["installationId"] as? String != previous["installationId"] as? String { break }
      try await Task.sleep(for: .milliseconds(250))
    }
    XCTAssertNotEqual(replacement["installationId"] as? String, previous["installationId"] as? String)
    XCTAssertEqual(replacement["provider"] as? String, "apns")
  }
}
