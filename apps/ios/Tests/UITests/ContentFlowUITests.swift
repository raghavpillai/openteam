import XCTest

@MainActor final class ContentFlowUITests: XCTestCase {
  let base = "http://127.0.0.1:19992"
  func control(_ path: String = "/__qa/control", _ body: [String: Any] = [:]) async throws {
    var request = URLRequest(url: URL(string: base + path)!)
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
  func launch(_ scene: String, required: Bool = false, dark: Bool = false, haptics: Bool = false,
    slowFavicons: Bool = false, largeText: Bool = false, reducedMotion: Bool = false) async throws
    -> XCUIApplication
  {
    continueAfterFailure = false
    addUIInterruptionMonitor(withDescription: "Password autofill") { alert in
      guard alert.buttons["Not Now"].exists else { return false }
      alert.buttons["Not Now"].tap()
      return true
    }
    try await control("/__qa/reset")
    try await control("/__qa/content", ["scene": scene])
    try await control("/__qa/control", ["authRequired": required])
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--server", base, "--appearance", dark ? "dark" : "light",
    ]
    if required { app.launchArguments.append("--show-login") }
    if haptics { app.launchArguments.append("--haptic-audit") }
    if reducedMotion { app.launchArguments.append("--qa-reduce-motion") }
    if slowFavicons { app.launchArguments.append("--slow-favicons") }
    if largeText { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] }
    app.launch()
    if required {
      waitForArrival(app.buttons["get-started"])
      app.buttons["get-started"].tap()
      waitForArrival(app.buttons["connect-button"])
      app.buttons["connect-button"].tap()
      XCTAssertTrue(app.textFields["username-field"].waitForExistence(timeout: 12))
      waitForArrival(app.textFields["username-field"])
      app.textFields["username-field"].tap()
      app.textFields["username-field"].typeText("fixture\n")
      app.secureTextFields["password-field"].typeText("fixture-only\n")
    }
    XCTAssertTrue(app.buttons["channel-channel-research"].waitForExistence(timeout: 15))
    if required {
      let prompt = app.buttons["Not Now"]
      for _ in 0..<3 {
        guard prompt.waitForExistence(timeout: 2) else { break }
        prompt.tap()
        if prompt.waitForNonExistence(timeout: 3) { break }
      }
      XCTAssertFalse(prompt.exists, "iOS password prompt did not dismiss")
    }
    // The list can still be settling when its rows first exist (iPhone Duo):
    // wait until the row is tappable, then retry until the conversation opens.
    let row = app.buttons["channel-channel-research"]
    let opened = app.buttons.matching(
      NSPredicate(format: "identifier == 'conversation-details' AND label == 'Research'")).firstMatch
    waitForArrival(row)
    for _ in 0..<3 {
      if row.isHittable { row.tap() }
      if opened.waitForExistence(timeout: 5) { break }
    }
    XCTAssertTrue(opened.exists, "The Research conversation did not open")
    return app
  }
  private func waitForArrival(_ element: XCUIElement) {
    let ready = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "hittable == true"), object: element)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed)
    // Navigation reports destination frames before the push finishes.
    Thread.sleep(forTimeInterval: 0.5)
  }
  func capture(_ name: String, _ app: XCUIApplication) {
    let a = XCTAttachment(screenshot: app.screenshot())
    a.name = "parity-" + name
    a.lifetime = .keepAlways
    add(a)
  }
  func testOfflineRichMarkdownTablesMathAndDiagram() async throws {
    let app = try await launch("markdown")
    XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 12))
    XCTAssertTrue(app.webViews.staticTexts["Tables"].waitForExistence(timeout: 12))
    XCTAssertTrue(app.webViews.staticTexts["Draft"].waitForExistence(timeout: 12))
    XCTAssertFalse(app.staticTexts["Unsafe script executed"].exists)
    capture("rich-markdown-light", app)
  }
  /// Chat links open in an in-app browser over the conversation, not in Safari.
  /// Holding a link opens link actions; holding the rest of the message, message actions.
  func testPlainMessageLinkOpensInAppBrowser() async throws {
    let app = try await launch("plain-link", haptics: true)
    let link = app.links["Wikipedia's random article page"]
    XCTAssertTrue(link.waitForExistence(timeout: 12))
    try await Task.sleep(for: .seconds(2))
    capture("link-plain-chat", app)
    // The text's last line starts with plain words at every width: the link
    // ends on the first or second line ("Here's one: Wikipedia's random article page.").
    // Scoped to the message: on iPad the sidebar's preview starts with the same words.
    let text = app.descendants(matching: .any)["message-content-fixture"].staticTexts
      .matching(NSPredicate(format: "label BEGINSWITH %@", "Here's one")).firstMatch
    XCTAssertTrue(text.exists)
    try await assertLongPressShowsMessageActions(
      app, text.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 1)).withOffset(CGVector(dx: 12, dy: -10)))
    try await assertLongPressShowsLinkActions(
      app, link, url: "https://en.wikipedia.org/wiki/Special:Random", name: "link-plain")
    link.tap()
    assertInAppBrowser(app, link, name: "link-plain-browser")
  }
  /// The dark-mode chat link and its link actions, for comparison with the reference design.
  func testDarkLinkAppearance() async throws {
    let app = try await launch("link-chat", dark: true)
    let link = app.links["Wikipedia's random article page"]
    XCTAssertTrue(link.waitForExistence(timeout: 12))
    try await Task.sleep(for: .seconds(4))
    capture("link-dark-chat", app)
    link.press(forDuration: 1.2)
    try await Task.sleep(for: .seconds(2))
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "link-actions-url").firstMatch.exists)
    capture("link-dark-actions", app)
  }
  /// Native links use a local fallback without delaying link interaction.
  func testLinkFaviconUsesLocalFallback() async throws {
    for scene in ["plain-link", "markdown"] {
      let app = try await launch(scene)
      let link = scene == "markdown" ? app.webViews.links["safe link"] : app.links["Wikipedia's random article page"]
      XCTAssertTrue(link.waitForExistence(timeout: 12))
      XCTAssertTrue(link.isHittable)
      capture("favicon-\(scene)-local-fallback", app)
      app.terminate()
    }
  }
  func testRichMarkdownLinkOpensInAppBrowser() async throws {
    let app = try await launch("markdown", haptics: true)
    let link = app.webViews.links["safe link"]
    XCTAssertTrue(link.waitForExistence(timeout: 12))
    try await assertLongPressShowsMessageActions(
      app, app.webViews.staticTexts["Native document"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)))
    try await assertLongPressShowsLinkActions(app, link, url: "https://example.com/", name: "link-rich")
    link.tap()
    assertInAppBrowser(app, link, name: "link-rich-browser")
  }
  private func clearHaptics() async throws {
    var request = URLRequest(url: URL(string: base + "/__qa/haptics")!)
    request.httpMethod = "DELETE"
    _ = try await URLSession.shared.data(for: request)
  }
  /// Opening a menu taps the phone: the audit records each haptic the app emits.
  private func assertHaptic(_ source: String) async throws {
    let (data, _) = try await URLSession.shared.data(from: URL(string: base + "/__qa/haptics")!)
    let events = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
    XCTAssertTrue(events.contains { ($0["source"] as? String) == source && ($0["emitted"] as? Bool) == true },
      "No \(source) haptic: \(events.compactMap { $0["source"] as? String })")
  }
  private func dismissSheet(_ app: XCUIApplication, until element: XCUIElement) {
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
    XCTAssertTrue(element.waitForNonExistence(timeout: 5))
  }
  private func assertLongPressShowsMessageActions(_ app: XCUIApplication, _ point: XCUICoordinate) async throws {
    try await clearHaptics()
    point.press(forDuration: 1.2)
    try await Task.sleep(for: .seconds(1.5))
    try await assertHaptic("message.long-press")
    XCTAssertTrue(app.buttons["Start a thread"].exists, "Holding message text did not open the message actions")
    XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "link-actions-url").firstMatch.exists)
    dismissSheet(app, until: app.buttons["Start a thread"])
  }
  /// Holding a link opens link actions only: not the message actions, not
  /// WebKit's link menu, and lifting the finger does not also follow the link.
  /// Open from those actions shows the link in the in-app browser.
  private func assertLongPressShowsLinkActions(
    _ app: XCUIApplication, _ link: XCUIElement, url: String, name: String
  ) async throws {
    try await clearHaptics()
    link.press(forDuration: 1.2)
    try await Task.sleep(for: .seconds(2))
    try await assertHaptic("link.long-press")
    capture(name + "-long-press", app)
    let address = app.descendants(matching: .any).matching(identifier: "link-actions-url").firstMatch
    XCTAssertTrue(address.exists, "Holding a link did not open the link actions")
    XCTAssertEqual(address.label, url)
    for action in ["Open", "Copy Link", "Share"] { XCTAssertTrue(app.buttons[action].exists, action) }
    XCTAssertFalse(app.buttons["Start a thread"].exists, "Holding a link opened the message actions")
    XCTAssertFalse(app.buttons["Open Link"].exists, "WebKit's link menu appeared")
    XCTAssertFalse(browserDone(app).exists, "Holding a link also followed it")
    app.buttons["Open"].tap()
    assertInAppBrowser(app, link, name: name + "-open")
  }
  /// SFSafariViewController's dismiss button: Done ("Close") on iPhone and iPad,
  /// Cancel in iPhone Duo's side rail.
  private func browserDone(_ app: XCUIApplication) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "identifier IN {'Close', 'CancelBarItemButton'}")).firstMatch
  }
  private func assertInAppBrowser(_ app: XCUIApplication, _ link: XCUIElement, name: String) {
    let done = browserDone(app)
    XCTAssertTrue(done.waitForExistence(timeout: 10), "Link did not open the in-app browser")
    XCTAssertTrue(app.buttons["OpenInSafariButton"].exists)
    XCTAssertEqual(app.state, .runningForeground, "Link left the app")
    Thread.sleep(forTimeInterval: 3)
    capture(name, app)
    done.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    Thread.sleep(forTimeInterval: 1.5)
    capture(name + "-closed", app)
    XCTAssertTrue(done.waitForNonExistence(timeout: 5), "Closing the in-app browser did not dismiss it")
    XCTAssertTrue(link.waitForExistence(timeout: 5), "Closing the browser did not return to the chat")
  }
  /// The card closes with an animation (and, when a chat message closed it, only once the
  /// transcript is still), so its settled height is waited for rather than read at once.
  private func waitForCard(_ card: XCUIElement, shorterThan limit: CGFloat, _ message: String) {
    let closed = XCTNSPredicateExpectation(
      predicate: NSPredicate { _, _ in card.frame.height < limit }, object: nil)
    XCTAssertEqual(XCTWaiter.wait(for: [closed], timeout: 8), .completed, message)
  }
  func testNormalComposerMovesPastQuestionWithoutSubmittingCardDraft() async throws {
    let app = try await launch("widget-pending", dark: true)
    defer { app.terminate() }
    XCTAssertTrue(app.buttons["Alpha"].waitForExistence(timeout: 10))
    let card = app.otherElements["widget-card-content-fixture"]
    let expandedHeight = card.frame.height
    app.buttons["Alpha"].tap()
    let custom = app.descendants(matching: .any).matching(identifier: "widget-custom-content-fixture").firstMatch
    XCTAssertTrue(custom.exists)
    custom.tap()
    custom.typeText("Unsubmitted Gamma")
    let composer = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    composer.tap()
    composer.typeText("New topic")
    app.buttons["send-button"].tap()
    let dismissed = app.staticTexts["widget-dismissed-content-fixture"]
    XCTAssertTrue(dismissed.waitForExistence(timeout: 10))
    XCTAssertEqual(dismissed.label, "Continued in chat")
    // The card's controls melt away and are removed once it has closed.
    XCTAssertTrue(app.buttons["widget-submit-content-fixture"].waitForNonExistence(timeout: 8))
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "widget-custom-content-fixture").firstMatch
      .waitForNonExistence(timeout: 8))
    let snapshot = try await state()
    let requests = try XCTUnwrap(snapshot["requests"] as? [[String: Any]])
    XCTAssertFalse(requests.contains { (($0["path"] as? String) ?? "").contains("widget-response") })
    XCTAssertFalse(requests.contains { (($0["path"] as? String) ?? "").contains("widget-dismiss") })
    waitForCard(card, shorterThan: expandedHeight - 50, "Moving on in chat must minimize the card")
    capture("question-moved-on", app)
  }
  func testStaleQuestionHistoryDoesNotReopenDismissedCard() async throws {
    let app = try await launch("widget-pending", dark: true)
    defer { app.terminate() }
    let done = app.buttons["widget-dismiss-content-fixture"]
    XCTAssertTrue(done.waitForExistence(timeout: 10))
    done.tap()
    let dismissed = app.staticTexts["widget-dismissed-content-fixture"]
    XCTAssertTrue(dismissed.waitForExistence(timeout: 10))
    let before = try await state()["requests"] as? [[String: Any]] ?? []
    let beforeHistory = before.filter { (($0["path"] as? String) ?? "").hasSuffix("/history") }.count
    // The fixture now returns the pre-dismissal card, like a delayed replica/page.
    try await control("/__qa/content", ["scene": "widget-pending-stale"])
    let back = app.buttons["chat-back"]
    if back.exists { back.tap() } else { app.buttons["chat-sidebar"].tap() }
    let row = app.buttons["channel-channel-research"]
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    waitForArrival(row); row.tap()
    var refreshed = false
    for _ in 0..<50 {
      let requests = try await state()["requests"] as? [[String: Any]] ?? []
      if requests.filter({ (($0["path"] as? String) ?? "").hasSuffix("/history") }).count > beforeHistory {
        refreshed = true; break
      }
      try await Task.sleep(for: .milliseconds(200))
    }
    XCTAssertTrue(refreshed, "The stale history response was not requested")
    XCTAssertTrue(app.staticTexts["Stale history replay"].waitForExistence(timeout: 10))
    XCTAssertTrue(dismissed.waitForExistence(timeout: 10))
    XCTAssertFalse(done.exists)
    XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "widget-custom-content-fixture").firstMatch.exists)
  }
  private func verifyQuestionSkip(reducedMotion: Bool) async throws {
    let app = try await launch("widget-pending", dark: true, reducedMotion: reducedMotion)
    defer { app.terminate() }
    let send = app.buttons["widget-submit-content-fixture"]
    let skip = app.buttons["widget-dismiss-content-fixture"]
    XCTAssertTrue(skip.waitForExistence(timeout: 10))
    let card = app.otherElements["widget-card-content-fixture"]
    XCTAssertTrue(card.exists)
    let expandedHeight = card.frame.height
    XCTAssertEqual(skip.label, "Skip question")
    XCTAssertEqual(send.label, "Send answer")
    XCTAssertFalse(send.isEnabled, "An empty card must not send an answer")
    app.buttons["Alpha"].tap()
    XCTAssertEqual(app.buttons["Alpha"].value as? String, "Selected")
    XCTAssertTrue(send.isEnabled)
    app.buttons["Alpha"].tap()
    XCTAssertFalse(send.isEnabled)
    XCTAssertTrue(skip.isEnabled)
    skip.tap()
    XCTAssertTrue(app.staticTexts["widget-dismissed-content-fixture"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.staticTexts["widget-dismissed-content-fixture"].label, "Skipped")
    // The card's controls melt away and are removed once it has closed.
    XCTAssertTrue(skip.waitForNonExistence(timeout: 8))
    XCTAssertTrue(app.buttons["Alpha"].waitForNonExistence(timeout: 8))
    waitForCard(card, shorterThan: expandedHeight - 50, "Skipping must minimize the card")
    capture(reducedMotion ? "question-skipped-reduced-motion" : "question-skipped-collapsed", app)
    let snapshot = try await state()
    let requests = try XCTUnwrap(snapshot["requests"] as? [[String: Any]])
    XCTAssertTrue(requests.contains { (($0["path"] as? String) ?? "").contains("widget-dismiss") })
    XCTAssertFalse(requests.contains { (($0["path"] as? String) ?? "").contains("widget-response") })
  }

  func testEmptyQuestionActionClearlySkipsWithoutAnAnswer() async throws {
    try await verifyQuestionSkip(reducedMotion: false)
  }
  func testQuestionCollapseWithReducedMotion() async throws {
    try await verifyQuestionSkip(reducedMotion: true)
  }
  func testQuestionAnswerCollapsesToReceipt() async throws {
    let app = try await launch("widget-pending", dark: true)
    defer { app.terminate() }
    let card = app.otherElements["widget-card-content-fixture"]
    XCTAssertTrue(card.waitForExistence(timeout: 10))
    let expandedHeight = card.frame.height
    app.buttons["Alpha"].tap()
    let send = app.buttons["widget-submit-content-fixture"]
    XCTAssertEqual(send.label, "Send answer")
    send.tap()
    XCTAssertTrue(app.descendants(matching: .any)["widget-answer-content-fixture-0"].waitForExistence(timeout: 10))
    // The chosen tile is the receipt row now; the other controls melt away and are removed.
    XCTAssertTrue(send.waitForNonExistence(timeout: 8))
    XCTAssertTrue(app.buttons["Alpha"].waitForNonExistence(timeout: 8))
    waitForCard(card, shorterThan: expandedHeight - 50, "Answering must minimize to the receipt")
    capture("question-answer-collapsed", app)
  }

  func testCompletedWidgetKeepsLabeledCheckedRowsInBothThemes() async throws {
    for dark in [true, false] {
      let app = try await launch("widget-completed", dark: dark)
      defer { app.terminate() }
      XCTAssertTrue(app.staticTexts["Choose a route"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-loading")
        .firstMatch.waitForNonExistence(timeout: 15))
      var previous: CGRect?
      for (index, label) in ["Alpha", "Beta", "Gamma"].enumerated() {
        let row = app.descendants(matching: .any)
          .matching(identifier: "widget-answer-content-fixture-\(index)").firstMatch
        XCTAssertTrue(row.exists)
        XCTAssertEqual(row.label, label)
        XCTAssertEqual(row.value as? String, "Selected")
        // AX may expose the text bounds rather than the padded row. Measure
        // the distance between rows, which also catches a collapsed option list.
        if let previous { XCTAssertGreaterThanOrEqual(row.frame.midY - previous.midY, 24) }
        previous = row.frame
      }
      XCTAssertFalse(app.buttons["Submit"].exists)
      XCTAssertFalse(app.buttons["Dismiss"].exists)
      capture("widget-completed-" + (dark ? "dark" : "light"), app)
    }
  }
  func testPlainMessageLineBoxTracksAccessibilityTextSize() async throws {
    var heights: [CGFloat] = []
    for category in ["UICTContentSizeCategoryL", "UICTContentSizeCategoryAccessibilityXXXL"] {
      try await control("/__qa/reset")
      try await control("/__qa/content", ["scene": "type-size"])
      let app = XCUIApplication()
      app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "dark",
        "--open-channel", "channel-research", "-UIPreferredContentSizeCategoryName", category]
      app.launch()
      defer { app.terminate() }
      let text = app.staticTexts["Hello"]
      XCTAssertTrue(text.waitForExistence(timeout: 15))
      XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-loading")
        .firstMatch.waitForNonExistence(timeout: 15))
      let row = app.otherElements["message-content-fixture"]
      XCTAssertTrue(row.exists)
      XCTAssertTrue(text.isHittable)
      XCTAssertGreaterThanOrEqual(row.frame.height, text.frame.height)
      heights.append(row.frame.height)
      capture("message-type-size-" + category, app)
    }
    XCTAssertEqual(heights[0], 40, accuracy: 0.5)
    XCTAssertGreaterThan(heights[1], heights[0] * 1.8)
    XCTAssertLessThan(heights[1], heights[0] * 3, "A single line must not gain a second empty line box")
  }
  func testUserFormPrefillValidationFailureAndAcceptedReceipt() async throws {
    let app = try await launch("form", dark: true)
    let name = app.descendants(matching: .any).matching(identifier: "form-field-name").firstMatch
    let email = app.descendants(matching: .any).matching(identifier: "form-field-email").firstMatch
    XCTAssertTrue(name.waitForExistence(timeout: 12))
    XCTAssertFalse(app.buttons["Submit"].isEnabled)
    XCTAssertEqual(email.value as? String, "fixture@example.invalid")
    name.tap()
    name.typeText("Ada Native")
    // SwiftUI exposes a labeled accessibility row around the native switch.
    // Tap the switch itself; the text label is not an interactive toggle.
    let confirmation = app.switches["Confirm these details"]
    (confirmation.switches.firstMatch.exists ? confirmation.switches.firstMatch : confirmation).tap()
    XCTAssertEqual(app.switches["Confirm these details"].value as? String, "1")
    let saveInfo = app.switches["Save nonsecret info for future forms"]
    (saveInfo.switches.firstMatch.exists ? saveInfo.switches.firstMatch : saveInfo).tap()
    XCTAssertEqual(app.switches["Save nonsecret info for future forms"].value as? String, "1")
    try await control(
      "/__qa/control",
      ["failures": ["POST /api/v0/channel-messages/content-fixture/user-form": ["status": 503]]])
    app.buttons["Submit"].tap()
    XCTAssertTrue(
      app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "try again shortly"))
        .firstMatch.waitForExistence(timeout: 12))
    XCTAssertEqual(name.value as? String, "Ada Native")
    capture("user-form-error-dark", app)
    app.buttons["Submit"].tap()
    XCTAssertTrue(app.staticTexts["Filled into the page. Secret values were never shown to your Bot."].waitForExistence(timeout: 12))
    capture("user-form-completed-dark", app)
    let data = try await state()
    let receipt = try XCTUnwrap((data["contentReceipts"] as? [[String: Any]])?.first)
    XCTAssertEqual((receipt["values"] as? [String: Any])?["name"] as? String, "Ada Native")
    XCTAssertEqual(receipt["saveToVault"] as? Bool, true)
    app.staticTexts["Filled into the page. Secret values were never shown to your Bot."].press(forDuration: 0.8)
    XCTAssertTrue(app.buttons["Reply"].waitForExistence(timeout: 5))
    capture("form-native-message-menu", app)
  }
  func testPrivateImageRequiresAuthenticationAndOpensNativePreview() async throws {
    let app = try await launch("attachment", required: true)
    XCTAssertTrue(app.buttons["Open Fixture image.png"].waitForExistence(timeout: 12))
    capture("private-attachment", app)
    let data = try await state()
    XCTAssertTrue(
      (data["contentReceipts"] as? [[String: Any]] ?? []).contains {
        $0["authenticated"] as? Bool == true
      })
    app.buttons["Open Fixture image.png"].tap()
    XCTAssertTrue(app.buttons["photo-close"].waitForExistence(timeout: 12))
    capture("native-file-preview", app)
    app.buttons["photo-close"].tap()
  }
  /// Native control chrome must remain usable before or during a VNC reconnect.
  func testComputerControlBarAndBackgroundOwnership() async throws {
    try await exerciseComputerControlBar(largeText: false)
  }
  func testComputerControlBarWithAccessibilityText() async throws {
    try await exerciseComputerControlBar(largeText: true)
  }
  func testComputerControlMotion() async throws {
    let app = try await launch("plain-link", dark: true)
    defer { app.terminate() }
    if !app.buttons["Computer"].exists {
      app.descendants(matching: .any).matching(identifier: "chat-more").firstMatch.tap()
    }
    app.buttons["Computer"].tap()
    XCTAssertTrue(app.buttons["Take control"].waitForExistence(timeout: 12))
    try await Task.sleep(for: .seconds(2))
    print("COMPUTER_CONTROL_MOTION_START")
    try await Task.sleep(for: .seconds(1))
    for _ in 0..<3 {
      app.buttons["Take control"].tap()
      XCTAssertTrue(app.buttons["Give back control"].waitForExistence(timeout: 12))
      try await Task.sleep(for: .milliseconds(1200))
      let stopFrame = app.buttons["Give back control"].frame
      let barFrame = app.descendants(matching: .any).matching(identifier: "computer-control-bar").firstMatch.frame
      XCTAssertEqual(stopFrame.width, 64, accuracy: 2, "Stop must not retain Take control’s invisible layout slot")
      XCTAssertEqual(barFrame.maxX - stopFrame.maxX, 6, accuracy: 2, "Stop keeps the same trailing rim inset")
      XCTAssertEqual(barFrame.midY, stopFrame.midY, accuracy: 1, "Stop is vertically centered in the capsule")
      app.buttons["Give back control"].tap()
      XCTAssertTrue(app.buttons["Take control"].waitForExistence(timeout: 12))
      try await Task.sleep(for: .milliseconds(1200))
    }
    print("COMPUTER_CONTROL_MOTION_END")
    let final = try await state()
    XCTAssertEqual((final["screen"] as? [String: Any])?["humanTakeover"] as? Bool, false)
  }
  func testComputerControlReducedMotion() async throws {
    try await exerciseComputerControlBar(largeText: false, reducedMotion: true)
  }
  private func exerciseComputerControlBar(largeText: Bool, reducedMotion: Bool = false) async throws {
    let app = try await launch("plain-link", dark: true, largeText: largeText, reducedMotion: reducedMotion)
    defer { app.terminate() }
    if !app.buttons["Computer"].exists {
      app.descendants(matching: .any).matching(identifier: "chat-more").firstMatch.tap()
    }
    app.buttons["Computer"].tap()
    let take = app.buttons["Take control"]
    XCTAssertTrue(take.waitForExistence(timeout: 12), "Take control is visible without opening a menu")
    XCTAssertTrue(take.isHittable)
    XCTAssertGreaterThanOrEqual(take.frame.height, 44)
    capture(largeText ? "computer-control-large-text-watching" : "computer-control-watching", app)
    take.tap()
    let stop = app.buttons["Give back control"]
    XCTAssertTrue(stop.waitForExistence(timeout: 12))
    XCTAssertTrue(stop.isHittable)
    let owned = try await state()
    XCTAssertEqual((owned["screen"] as? [String: Any])?["humanTakeover"] as? Bool, true)
    capture(largeText ? "computer-control-large-text-owned" : "computer-control-owned", app)
    if !largeText {
      XCUIDevice.shared.press(.home)
      try await Task.sleep(for: .seconds(2))
      app.activate()
      XCTAssertTrue(stop.waitForExistence(timeout: 12))
      let returned = try await state()
      let expectedControl = try XCTUnwrap((owned["screen"] as? [String: Any])?["controlSession"] as? NSDictionary)
      XCTAssertEqual((returned["screen"] as? [String: Any])?["controlSession"] as? NSDictionary, expectedControl)
      XCTAssertEqual((returned["screen"] as? [String: Any])?["humanTakeover"] as? Bool, true)
    }
    stop.tap()
    XCTAssertTrue(take.waitForExistence(timeout: 12))
    let released = try await state()
    XCTAssertEqual((released["screen"] as? [String: Any])?["humanTakeover"] as? Bool, false)
    // Another viewer acquires ownership while this one is open.
    try await control("/api/v0/bots/bot-research/screen/takeover", [
      "active": true, "controlId": "other-viewer", "force": true,
    ])
    XCTAssertTrue(app.buttons["Take control here"].waitForExistence(timeout: 12))
    let resume = app.buttons["Resume bot"]
    XCTAssertTrue(resume.isHittable)
    capture(largeText ? "computer-control-large-text-other-device" : "computer-control-other-device", app)
    resume.tap()
    XCTAssertTrue(take.waitForExistence(timeout: 12))
    let resumed = try await state()
    XCTAssertEqual((resumed["screen"] as? [String: Any])?["humanTakeover"] as? Bool, false)
    app.buttons["Done"].tap()
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-more").firstMatch.waitForExistence(timeout: 12))
  }
  func testComputerHandoffControlBarCompletesRequest() async throws {
    let app = try await launch("handoff", dark: true)
    app.buttons["Take over"].tap()
    let done = app.buttons["I'm done"]
    XCTAssertTrue(done.waitForExistence(timeout: 12))
    XCTAssertTrue(done.isHittable)
    XCTAssertGreaterThanOrEqual(done.frame.height, 44)
    XCTAssertFalse(app.buttons["Give back control"].exists, "A requested step completes the handoff rather than only releasing input")
    capture("computer-handoff-control-bar", app)
    let path = "POST /api/v0/channel-messages/content-fixture/computer-handoff"
    try await control("/__qa/control", ["failures": [path: ["status": 503]]])
    done.tap()
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "try again shortly")).firstMatch.waitForExistence(timeout: 12))
    XCTAssertTrue(done.isHittable, "A failed completion keeps the viewer open for retry")
    done.tap()
    let closed = expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: app.buttons["conversation-details"])
    await fulfillment(of: [closed], timeout: 12)
    let data = try await state()
    let receipts = data["contentReceipts"] as? [[String: Any]] ?? []
    XCTAssertEqual(receipts.filter { $0["action"] as? String == "complete" }.count, 1)
    XCTAssertEqual((data["screen"] as? [String: Any])?["humanTakeover"] as? Bool, false)
  }
  /// Input delivery is covered against an actual VNC desktop in VNCValidationUITests.
  /// This fixture verifies handoff lifecycle even if the viewer cannot connect.
  func testComputerHandoffFailureAndReturnControl() async throws {
    let app = try await launch("handoff")
    let path = "POST /api/v0/channel-messages/content-fixture/computer-handoff"
    XCTAssertTrue(app.buttons["Take over"].waitForExistence(timeout: 12))
    app.buttons["Take over"].tap()
    XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 12))
    let active = try await state()
    XCTAssertEqual((active["screen"] as? [String: Any])?["humanTakeover"] as? Bool, true)
    capture("computer-handoff-viewer", app)
    try await control("/__qa/control", ["failures": [path: ["status": 503]]])
    app.buttons["Done"].tap()
    XCTAssertTrue(app.staticTexts.containing(
      NSPredicate(format: "label CONTAINS %@", "try again shortly"))
      .firstMatch.waitForExistence(timeout: 12))
    let failed = try await state()
    XCTAssertEqual((failed["screen"] as? [String: Any])?["humanTakeover"] as? Bool, true)
    XCTAssertTrue(app.buttons["Done"].isHittable)
    app.buttons["Done"].tap()
    let closed = expectation(for: NSPredicate(format: "isHittable == true"),
      evaluatedWith: app.buttons["conversation-details"])
    await fulfillment(of: [closed], timeout: 12)
    let data = try await state()
    let receipts = data["contentReceipts"] as? [[String: Any]] ?? []
    XCTAssertEqual(receipts.filter { $0["action"] as? String == "start" }.count, 1)
    XCTAssertEqual(receipts.filter { $0["action"] as? String == "complete" }.count, 1)
    XCTAssertEqual((data["screen"] as? [String: Any])?["humanTakeover"] as? Bool, false)
    capture("computer-handoff-returned", app)
  }
}
