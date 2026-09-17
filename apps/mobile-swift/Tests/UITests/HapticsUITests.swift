import XCTest

@MainActor final class HapticsUITests: XCTestCase {
  let base = "http://127.0.0.1:20030"
  enum HapticAuditFailure: Error { case missing(String) }
  struct Event: Decodable {
    let effect: String, source: String
    let enabled: Bool, active: Bool, emitted: Bool
  }
  func request(_ path: String, method: String = "POST", body: [String: Any] = [:]) async throws
    -> Data
  {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = method
    if method == "POST" {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    return data
  }
  func clear() async throws { _ = try await request("/__qa/haptics", method: "DELETE") }
  func events() async throws -> [Event] {
    try JSONDecoder().decode([Event].self, from: await request("/__qa/haptics", method: "GET"))
  }
  func expect(_ source: String, _ effect: String, emitted: Bool = true, count: Int = 1) async throws
  {
    var matches: [Event] = []
    for _ in 0..<30 {
      matches = try await events().filter { $0.source == source }
      if matches.count >= count { break }
      try await Task.sleep(for: .milliseconds(100))
    }
    guard matches.count == count else {
      XCTFail("Expected \(count) \(source) events, got \(matches.count)")
      throw HapticAuditFailure.missing(source)
    }
    XCTAssertTrue(matches.allSatisfy { $0.effect == effect && $0.emitted == emitted }, source)
    if emitted { XCTAssertTrue(matches.allSatisfy { $0.active && $0.enabled }, source) }
  }
  func launch(
    home: Bool = false, haptics: String? = "on", login: Bool = false, visual: Bool = true,
    content: String? = nil
  )
    async throws -> XCUIApplication
  {
    continueAfterFailure = true
    _ = try await request(
      "/__qa/scene", body: ["scene": home || login ? "home" : "dark-chat-seven"])
    if !visual { _ = try await request("/__qa/reset") }
    if let content { _ = try await request("/__qa/content", body: ["scene": content]) }
    if login { _ = try await request("/__qa/control", body: ["authRequired": true]) }
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--server", base, "--appearance", "dark", "--haptic-audit",
    ]
    if let haptics { app.launchArguments += ["--haptics", haptics] }
    if login {
      app.launchArguments += ["--show-login"]
    } else if !home {
      app.launchArguments += ["--open-channel", "visual-chat"]
    }
    app.launch()
    XCTAssertTrue(
      app.buttons[login ? "get-started" : home ? "settings-button" : "chat-back"].waitForExistence(
        timeout: 15))
    if !home && !login {
      XCTAssertTrue(app.staticTexts["Got it — here."].waitForExistence(timeout: 8))
    }
    try await clear()
    return app
  }
  func field(_ app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
  }
  func hold(_ app: XCUIApplication) {
    app.staticTexts["Got it — here."].press(forDuration: 0.7)
    XCTAssertTrue(app.buttons["Reply"].waitForExistence(timeout: 5))
  }
  func testMessageHoldCopyReactionReplyAndSendHaveExactlyOneCueEach() async throws {
    let app = try await launch()
    hold(app)
    try await expect("message.long-press", "medium")
    app.buttons["Copy"].tap()
    try await expect("message.copy", "light")
    try await clear()
    hold(app)
    app.buttons["👍"].tap()
    try await expect("message.reaction", "selection")
    try await clear()
    hold(app)
    app.buttons["Reply"].tap()
    XCTAssertTrue(app.buttons["Cancel reply"].waitForExistence(timeout: 5))
    try await expect("message.reply-action", "light")
    field(app).typeText("Haptic send check")
    try await clear()
    app.buttons["send-button"].tap()
    try await expect("message.send", "light")
    XCTAssertTrue(app.staticTexts["Haptic send check"].waitForExistence(timeout: 8))
    let log = try await events()
    XCTAssertEqual(
      log.filter(\.emitted).count, 1, "Send must not pulse on its acknowledgement or layout")
  }
  func testSwipeThresholdIs52PointsWithNoDuplicateReleasePulse() async throws {
    let app = try await launch()
    let target = app.staticTexts["Got it — here."]
    let start = target.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.5))
    start.press(
      forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 30, dy: 0)), withVelocity: .slow,
      thenHoldForDuration: 0.3)
    XCTAssertFalse(app.buttons["Cancel reply"].exists)
    let belowThreshold = try await events()
    XCTAssertTrue(belowThreshold.isEmpty)
    start.press(
      forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 80, dy: 0)), withVelocity: .slow,
      thenHoldForDuration: 0.3)
    XCTAssertTrue(app.buttons["Cancel reply"].waitForExistence(timeout: 5))
    try await expect("message.reply-swipe", "light")
    let swipeEvents = try await events()
    XCTAssertEqual(swipeEvents.filter(\.emitted).count, 1)
  }
  func testPickerNoOpCreateErrorAndSuccess() async throws {
    let app = try await launch(home: true)
    app.buttons["new-button"].tap()
    app.buttons["New Bot"].tap()
    XCTAssertTrue(app.textFields["new-name"].waitForExistence(timeout: 5))
    app.buttons["owl"].tap()
    try await expect("bot.shape", "selection")
    app.buttons["owl"].tap()
    try await expect("bot.shape", "selection")
    app.textFields["new-name"].tap()
    app.textFields["new-name"].typeText("Haptic QA")
    _ = try await request(
      "/__qa/control", body: ["failures": ["POST /api/v0/bots": ["status": 503]]])
    try await clear()
    app.buttons["create-confirm"].tap()
    try await expect("conversation.create", "error")
    if app.alerts.firstMatch.exists { app.alerts.buttons["OK"].tap() }
    try await clear()
    app.buttons["create-confirm"].tap()
    try await expect("conversation.create", "success")
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 8))
  }
  func testOffSettingPersistsAndSuppressesEveryMessageCue() async throws {
    var app = try await launch(home: true)
    app.buttons["settings-button"].tap()
    let toggle = app.switches["App haptics"]
    if !toggle.isHittable { app.swipeUp() }
    XCTAssertTrue(toggle.waitForExistence(timeout: 5))
    (toggle.switches.firstMatch.exists ? toggle.switches.firstMatch : toggle).tap()
    XCTAssertEqual(toggle.value as? String, "0")
    app.terminate()
    app = try await launch(haptics: nil)
    hold(app)
    try await expect("message.long-press", "medium", emitted: false)
    app.buttons["Reply"].tap()
    try await expect("message.reply-action", "light", emitted: false)
    field(app).typeText("Silent send")
    app.buttons["send-button"].tap()
    try await expect("message.send", "light", emitted: false)
    let log = try await events()
    XCTAssertTrue(log.allSatisfy { !$0.enabled && !$0.emitted })
  }
  func testAuthSubmitFailureSuccessAndCancellation() async throws {
    let app = try await launch(login: true)
    app.buttons["get-started"].tap()
    try await expect("auth.get-started", "light")
    app.buttons["connect-button"].tap()
    XCTAssertTrue(app.textFields["username-field"].waitForExistence(timeout: 10))
    try await expect("auth.submit", "light")
    try await expect("auth.result", "success")
    app.textFields["username-field"].tap()
    app.textFields["username-field"].typeText("fixture")
    app.secureTextFields["password-field"].tap()
    app.secureTextFields["password-field"].typeText("fixture-only")
    _ = try await request(
      "/__qa/control", body: ["failures": ["POST /api/auth/login": ["status": 401]]])
    try await clear()
    app.buttons["sign-in-button"].tap()
    try await expect("auth.submit", "light")
    try await expect("auth.result", "error")
    _ = try await request(
      "/__qa/control", body: ["failures": ["POST /api/auth/login": ["delayMs": 3000]]])
    try await clear()
    app.buttons["sign-in-button"].tap()
    XCTAssertTrue(app.buttons["Cancel sign-in"].waitForExistence(timeout: 3))
    app.buttons["Cancel sign-in"].tap()
    try await Task.sleep(for: .seconds(3.2))
    let cancelledEvents = try await events()
    XCTAssertEqual(cancelledEvents.filter { $0.source == "auth.result" }.count, 0)
    try await clear()
    app.buttons["sign-in-button"].tap()
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 12))
    try await expect("auth.result", "success")
  }
  func testAttachmentMenuAndConversationHold() async throws {
    let app = try await launch()
    app.buttons["attach-button"].tap()
    XCTAssertTrue(app.buttons["Files"].waitForExistence(timeout: 5))
    try await expect("composer.attach", "light")
    app.buttons["Photo library"].tap()
    XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 8))
    app.buttons["Cancel"].tap()
    try await expect("composer.attach", "light")
    app.terminate()
    let home = try await launch(home: true, visual: false)
    let row = home.buttons["channel-channel-research"]
    XCTAssertTrue(row.waitForExistence(timeout: 5))
    row.press(forDuration: 0.7)
    XCTAssertTrue(home.buttons["Mark unread"].waitForExistence(timeout: 5))
    try await expect("conversation.long-press", "medium")
  }
  func testBackgroundCompletionDoesNotEmitFeedback() async throws {
    let app = try await launch(home: true)
    app.buttons["new-button"].tap()
    app.buttons["New Bot"].tap()
    let name = app.textFields["new-name"]
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    name.tap()
    name.typeText("Background haptic check")
    _ = try await request(
      "/__qa/control", body: ["failures": ["POST /api/v0/bots": ["delayMs": 1800]]])
    try await clear()
    app.buttons["create-confirm"].tap()
    XCUIDevice.shared.press(.home)
    try await expect("conversation.create", "success", emitted: false)
    let log = try await events()
    XCTAssertTrue(log.allSatisfy { !$0.active && !$0.emitted })
    app.activate()
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 8))
  }
  func testPluginLoadingIsSilentAndInstallHasOneOutcomeCue() async throws {
    let app = try await launch(home: true, visual: false)
    app.buttons["settings-button"].tap()
    app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Plugins")).firstMatch.tap()
    let plugin = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Fixture Notes"))
      .firstMatch
    XCTAssertTrue(plugin.waitForExistence(timeout: 8))
    plugin.tap()
    XCTAssertTrue(app.buttons["Install plugin"].waitForExistence(timeout: 8))
    let passive = try await events()
    XCTAssertTrue(passive.isEmpty)
    _ = try await request(
      "/__qa/control", body: ["failures": ["POST /api/v0/plugins/install": ["status": 503]]])
    app.buttons["Install plugin"].tap()
    try await expect("form.result", "error")
    try await clear()
    app.buttons["Install plugin"].tap()
    XCTAssertTrue(plugin.waitForExistence(timeout: 8))
    try await expect("form.result", "success")
    plugin.tap()
    app.buttons["Connection settings"].tap()
    XCTAssertTrue(app.textFields["Account alias"].waitForExistence(timeout: 8))
    let final = try await events()
    XCTAssertEqual(final.count, 1, "Connection loading must stay quiet")
  }
  func scrollTo(_ element: XCUIElement, _ app: XCUIApplication) {
    for _ in 0..<7 {
      if element.exists && element.isHittable { return }
      let origin = app.coordinate(withNormalizedOffset: .zero)
      let bottom =
        app.keyboards.firstMatch.exists
        ? app.keyboards.firstMatch.frame.minY - 25 : app.frame.height * 0.8
      origin.withOffset(CGVector(dx: app.frame.width * 0.85, dy: bottom)).press(
        forDuration: 0.05,
        thenDragTo: origin.withOffset(
          CGVector(dx: app.frame.width * 0.85, dy: app.frame.height * 0.2)),
        withVelocity: .slow, thenHoldForDuration: 0.1)
    }
    XCTAssertTrue(element.isHittable)
  }
  func testRoutineSaveFailureSuccessAndAcceptedRunFeedback() async throws {
    let app = try await launch(home: true, visual: false)
    app.buttons["channel-channel-research"].tap()
    app.buttons["conversation-details"].tap()
    scrollTo(app.buttons["Routines"], app)
    app.buttons["Routines"].tap()
    app.buttons["Add routine"].tap()
    let name = app.textFields["routine-name"]
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    name.tap()
    name.typeText("Haptic routine")
    app.textViews["routine-prompt"].tap()
    app.textViews["routine-prompt"].typeText("Return a short test result.")
    try await clear()
    _ = try await request(
      "/__qa/control",
      body: ["failures": ["POST /api/v0/bots/bot-research/routines": ["status": 503]]])
    app.buttons["routine-save"].tap()
    try await expect("routine.save", "error")
    try await clear()
    app.buttons["routine-save"].tap()
    let row = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Haptic routine"))
      .firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    try await expect("routine.save", "success")
    row.tap()
    scrollTo(app.buttons["Run now"], app)
    try await clear()
    app.buttons["Run now"].tap()
    try await expect("routine.run", "light")
    try await Task.sleep(for: .seconds(1.5))
    let runEvents = try await events()
    XCTAssertEqual(runEvents.count, 1, "Run polling must not add outcome pulses")
  }
  func testInboxSwipeActionsAndPinnedHoldPreserveFeedback() async throws {
    let app = try await launch(home: true, visual: false)
    let row = app.buttons["channel-channel-research"]
    let start = row.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5))
    start.press(
      forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 100, dy: 0)),
      withVelocity: .slow, thenHoldForDuration: 0.2)
    let pin = app.buttons["conversation-swipe-pin"].firstMatch
    XCTAssertTrue(pin.waitForExistence(timeout: 5))
    pin.tap()
    try await expect("conversation.swipe-action", "light")
    let pinned = app.buttons["pinned-channel-research"]
    XCTAssertTrue(pinned.waitForExistence(timeout: 8))
    try await clear()
    pinned.press(forDuration: 0.7)
    XCTAssertTrue(app.buttons["Unpin"].waitForExistence(timeout: 5))
    try await expect("conversation.long-press", "medium")
    app.buttons["Unpin"].tap()
    XCTAssertTrue(row.waitForExistence(timeout: 5))
    try await clear()
    let left = row.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5))
    left.press(
      forDuration: 0.05, thenDragTo: left.withOffset(CGVector(dx: -100, dy: 0)),
      withVelocity: .slow, thenHoldForDuration: 0.2)
    let hide = app.buttons["conversation-swipe-hide"].firstMatch
    XCTAssertTrue(hide.waitForExistence(timeout: 5))
    hide.tap()
    try await expect("conversation.swipe-action", "light")
    let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: row)
    await fulfillment(of: [gone], timeout: 8)
  }
  func testLatestButtonAndScrollDoNotDoubleSignal() async throws {
    let app = try await launch()
    let scroll = app.scrollViews.firstMatch
    scroll.swipeDown()
    let latest = app.buttons["Latest messages"]
    XCTAssertTrue(latest.waitForExistence(timeout: 5))
    try await clear()
    latest.tap()
    try await expect("chat.latest-button", "selection")
    let buttonEvents = try await events()
    XCTAssertEqual(buttonEvents.count, 1)
    scroll.swipeDown()
    XCTAssertTrue(latest.waitForExistence(timeout: 5))
    try await clear()
    scroll.swipeUp()
    try await expect("chat.latest-scroll", "selection")
    let scrollEvents = try await events()
    XCTAssertEqual(scrollEvents.count, 1)
  }
  func testAttachmentShareAndCancel() async throws {
    let app = try await launch(home: true, visual: false, content: "attachment")
    app.buttons["channel-channel-research"].tap()
    let attachment = app.buttons["Open Fixture image.png"]
    XCTAssertTrue(attachment.waitForExistence(timeout: 8))
    attachment.tap()
    let share = app.buttons["Share"].firstMatch
    XCTAssertTrue(share.waitForExistence(timeout: 8))
    try await clear()
    share.tap()
    try await expect("attachment.share", "light")
    let close = app.buttons["Close"].firstMatch
    if close.waitForExistence(timeout: 3) { close.tap() }
    let log = try await events()
    XCTAssertEqual(log.count, 1, "Cancelling sharing must not emit an error or success")
  }
  func testPluginCategoryOnlySignalsWhenChanged() async throws {
    let app = try await launch(home: true, visual: false)
    app.buttons["settings-button"].tap()
    app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Plugins")).firstMatch.tap()
    let filter = app.buttons["plugin-category"]
    XCTAssertTrue(filter.waitForExistence(timeout: 8))
    filter.tap()
    app.buttons["Featured"].tap()
    try await expect("plugin.category", "selection")
    filter.tap()
    app.buttons["Featured"].tap()
    try await expect("plugin.category", "selection")
  }
  func testComputerHandoffOnlySignalsAcceptedTransitions() async throws {
    let app = try await launch(home: true, visual: false, content: "handoff")
    app.buttons["channel-channel-research"].tap()
    XCTAssertTrue(app.buttons["Take over"].waitForExistence(timeout: 8))
    let path = "POST /api/v0/channel-messages/content-fixture/computer-handoff"
    _ = try await request("/__qa/control", body: ["failures": [path: ["status": 503]]])
    try await clear()
    app.buttons["Take over"].tap()
    try await expect("rich-action.result", "error")
    try await clear()
    app.buttons["Take over"].tap()
    XCTAssertTrue(app.buttons["Computer options"].waitForExistence(timeout: 8))
    try await expect("computer.handoff-start", "light")
    _ = try await request("/__qa/control", body: ["failures": [path: ["status": 503]]])
    try await clear()
    app.buttons["Done"].tap()
    try await expect("computer.handoff-finish", "error")
    try await clear()
    app.buttons["Done"].tap()
    try await expect("computer.handoff-finish", "success")
    let returned = expectation(
      for: NSPredicate(format: "isHittable == true"),
      evaluatedWith: app.buttons["conversation-details"])
    await fulfillment(of: [returned], timeout: 8)
  }
  func testPluginSignInKeepsConfigurationAndAuthorizationErrorsAudible() async throws {
    let app = try await launch(home: true, visual: false)
    _ = try await request("/__qa/control", body: ["pluginCanAuthenticate": true])
    app.buttons["settings-button"].tap()
    app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Plugins")).firstMatch.tap()
    let plugin = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Fixture Notes"))
      .firstMatch
    XCTAssertTrue(plugin.waitForExistence(timeout: 8))
    plugin.tap()
    app.buttons["Install plugin"].tap()
    XCTAssertTrue(plugin.waitForExistence(timeout: 8))
    plugin.tap()
    app.buttons["Connection settings"].tap()
    XCTAssertTrue(app.textFields["Account alias"].waitForExistence(timeout: 8))
    scrollTo(app.buttons["Sign in"], app)
    _ = try await request(
      "/__qa/control",
      body: [
        "failures": [
          "PUT /api/v0/plugin-connections/fixture-connection/configuration": ["status": 503]
        ]
      ])
    try await clear()
    app.buttons["Sign in"].tap()
    try await expect("form.result", "error")
    let initialLog = try await events()
    XCTAssertEqual(initialLog.count, 1)
    _ = try await request(
      "/__qa/control",
      body: [
        "failures": [
          "POST /api/v0/plugin-connections/fixture-connection/authenticate": ["status": 503]
        ]
      ])
    scrollTo(app.buttons["Sign in"], app)
    try await clear()
    app.buttons["Sign in"].tap()
    try await expect("form.result", "error")
    let authorizationLog = try await events()
    XCTAssertEqual(
      authorizationLog.count, 1, "Saving configuration before sign-in must not signal success")
  }
  override func tearDown() async throws {
    let data = try await request("/__qa/haptics", method: "GET")
    let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
    attachment.name = "native-haptic-dispatch"
    attachment.lifetime = .keepAlways
    add(attachment)
    XCUIApplication().terminate()
  }
}
