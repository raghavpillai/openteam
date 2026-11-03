import XCTest

@MainActor final class MessageFeatureUITests: XCTestCase {
  private let base = ProcessInfo.processInfo.environment["MESSAGE_FEATURE_SERVER"] ?? "http://127.0.0.1:19997"
  @discardableResult private func control(_ path: String, _ body: [String: Any] = [:]) async throws -> [String: Any] {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (data, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
  }
  private func launch(_ scene: String, visual: Bool = false, appearance: String = "dark") async throws -> XCUIApplication {
    continueAfterFailure = false
    try await control("/__qa/reset")
    try await control(visual ? "/__qa/scene" : "/__qa/content", ["scene": scene])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", appearance,
      "--open-channel", visual ? "visual-chat" : "channel-research", "--qa-session", UUID().uuidString]
    app.launch()
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 20))
    let loading = app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch
    XCTAssertTrue(loading.waitForNonExistence(timeout: 20), "History never finished positioning")
    return app
  }
  private func capture(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
  }
  func testReferenceInboxUnreadAccountAndMarketplace() async throws {
    try await verifyReferenceInbox(appearance: "dark")
  }
  func testReferenceInboxControlsInLightMode() async throws {
    try await verifyReferenceInbox(appearance: "light")
  }
  private func verifyReferenceInbox(appearance: String) async throws {
    continueAfterFailure = false
    try await control("/__qa/reset")
    try await control("/__qa/scene", ["scene": "dark-home"])
    try await control("/api/v0/settings/sidebar", [
      "version": 2, "pinnedIds": [], "unreadIds": [], "unassignedCollapsed": false,
      "sections": [["id": "later", "name": "Later", "collapsed": true]],
      "sectionByChannel": ["visual-6": "later"],
      "channelOrderByGroup": ["later": ["visual-6"]],
    ])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", appearance, "--qa-session", UUID().uuidString]
    app.launch()
    let unread = app.buttons["inbox-unread"]
    XCTAssertTrue(unread.waitForExistence(timeout: 20))
    XCTAssertEqual(unread.label, "2 unread conversations")
    XCTAssertTrue(app.buttons["settings-button"].isHittable)
    XCTAssertFalse(app.buttons["settings-button"].label.contains("OpenTeam owner"))
    verifyInboxControlPlacement(app)
    let hasSidebar = app.staticTexts["sidebar-account-name"].exists
    let unreadRow = app.buttons["channel-visual-6"]
    XCTAssertFalse(unreadRow.exists)
    unread.tap()
    XCTAssertTrue(unreadRow.waitForExistence(timeout: 5))
    XCTAssertTrue(unreadRow.isHittable)
    capture("reference-inbox-controls-" + appearance, app)
    if app.buttons["marketplace-button"].exists {
      app.buttons["marketplace-button"].tap()
      XCTAssertTrue(app.buttons["installed-plugins"].waitForExistence(timeout: 10))
      app.buttons["marketplace-back"].tap()
    } else {
      app.buttons["settings-button"].tap()
      let plugins = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Plugins")).firstMatch
      XCTAssertTrue(plugins.waitForExistence(timeout: 5))
      plugins.tap()
      XCTAssertTrue(app.buttons["installed-plugins"].waitForExistence(timeout: 10))
      capture("reference-iphone-plugins-in-settings", app)
      app.buttons["marketplace-back"].tap()
      app.buttons["sheet-close"].tap()
    }
    XCTAssertTrue(unread.waitForExistence(timeout: 5))
    app.buttons["settings-button"].tap()
    XCTAssertTrue(app.buttons["account-settings"].waitForExistence(timeout: 5))
    app.buttons["sheet-close"].tap()
    unreadRow.tap()
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 10))
    if hasSidebar {
      let updated = expectation(for: NSPredicate(format: "label == %@", "1 unread conversation"), evaluatedWith: unread)
      await fulfillment(of: [updated], timeout: 8)
      XCTAssertTrue(app.buttons["marketplace-button"].isHittable)
      XCTAssertTrue(app.buttons["settings-button"].isHittable)
      XCTAssertTrue(unread.isHittable)
      capture("reference-persistent-sidebar", app)
      app.buttons["marketplace-button"].tap()
      XCTAssertTrue(app.buttons["installed-plugins"].waitForExistence(timeout: 10))
      app.buttons["marketplace-back"].tap()
      XCTAssertTrue(app.buttons["conversation-details"].isHittable)
      app.buttons["settings-button"].tap()
      XCTAssertTrue(app.buttons["account-settings"].waitForExistence(timeout: 5))
      app.buttons["sheet-close"].tap()
      XCTAssertTrue(app.buttons["conversation-details"].isHittable)
    } else {
      XCTAssertFalse(app.buttons["marketplace-button"].exists)
    }
    if !hasSidebar {
      app.buttons["chat-back"].tap()
      XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 5))
      verifyInboxControlPlacement(app)
    }
    XCTAssertEqual(unread.label, "1 unread conversation")
    unread.tap()
    let lastUnread = app.buttons["channel-visual-10"]
    XCTAssertTrue(lastUnread.isHittable)
    let nextName = try XCTUnwrap(lastUnread.label.components(separatedBy: ",").first)
    lastUnread.tap()
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 10))
    let selected = expectation(for: NSPredicate(format: "label == %@", nextName), evaluatedWith: app.buttons["conversation-details"])
    await fulfillment(of: [selected], timeout: 8)
    let loading = app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch
    XCTAssertTrue(loading.waitForNonExistence(timeout: 20))
    app.buttons["chat-back"].tap()
    XCTAssertTrue(unread.waitForNonExistence(timeout: 8))
  }
  private func verifyInboxControlPlacement(_ app: XCUIApplication) {
    let account = app.buttons["settings-button"].frame
    let search = app.buttons["search-button"].frame
    switch ProcessInfo.processInfo.environment["REFERENCE_CONTROL_PLACEMENT"] {
    case "right":
      XCTAssertFalse(app.staticTexts["sidebar-account-name"].exists)
      let marketplace = app.buttons["marketplace-button"].frame
      XCTAssertGreaterThan(marketplace.midX, app.frame.maxX - 80)
      XCTAssertEqual(account.midX, search.midX, accuracy: 2)
      XCTAssertEqual(marketplace.midX, search.midX, accuracy: 2)
      XCTAssertGreaterThan(marketplace.minY, search.maxY)
      XCTAssertGreaterThan(account.minY, marketplace.maxY)
      app.buttons["new-button"].tap()
      XCTAssertTrue(app.buttons["New Bot"].waitForExistence(timeout: 5))
      app.buttons["New Bot"].tap()
      XCTAssertTrue(app.textFields["new-name"].waitForExistence(timeout: 5))
      app.buttons["sheet-close"].tap()
      app.buttons["search-button"].tap()
      XCTAssertTrue(app.textFields["search-input"].waitForExistence(timeout: 5))
      app.buttons["sheet-close"].tap()
    case "top":
      XCTAssertLessThan(account.maxY, app.frame.height * 0.25)
      XCTAssertEqual(account.midY, search.midY, accuracy: 2)
      XCTAssertFalse(app.buttons["marketplace-button"].exists)
      XCTAssertFalse(app.staticTexts["sidebar-account-name"].exists)
    case "sidebar":
      XCTAssertTrue(app.staticTexts["sidebar-account-name"].exists)
      let marketplace = app.buttons["marketplace-button"].frame
      XCTAssertGreaterThan(account.midY, app.frame.maxY - 100)
      XCTAssertEqual(account.midY, marketplace.midY, accuracy: 2)
    default: break
    }
  }
  func testReferenceRotationKeepsConversationAndDraft() async throws {
    XCUIDevice.shared.orientation = .portrait
    defer { XCUIDevice.shared.orientation = .portrait }
    let app = try await launch("dark-chat", visual: true)
    let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    input.tap()
    input.typeText("734829")
    XCTAssertEqual(input.value as? String, "734829")
    XCUIDevice.shared.orientation = .landscapeLeft
    let headerReady = expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: app.buttons["conversation-details"])
    await fulfillment(of: [headerReady], timeout: 8)
    XCTAssertFalse(app.buttons["marketplace-button"].exists)
    XCTAssertFalse(app.staticTexts["sidebar-account-name"].exists)
    XCTAssertEqual(input.value as? String, "734829")
    capture("reference-iphone-landscape-with-draft", app)
    XCUIDevice.shared.orientation = .portrait
    XCTAssertTrue(app.buttons["marketplace-button"].waitForNonExistence(timeout: 8))
    XCTAssertEqual(input.value as? String, "734829")
    XCTAssertTrue(app.buttons["conversation-details"].isHittable)
  }
  func testReferencePartialSwipeTimestampAndInlineReply() async throws {
    try await verifyReferenceReply(appearance: "dark")
  }
  func testReferenceSwipeAndReplyInLightMode() async throws {
    try await verifyReferenceReply(appearance: "light")
  }
  private func verifyReferenceReply(appearance: String) async throws {
    let app = try await launch("dark-chat", visual: true, appearance: appearance)
    let target = app.tables["chat-history"].staticTexts["Got it — here."]
    XCTAssertTrue(target.isHittable)
    let start = target.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.5))
    start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 30, dy: 0)),
      withVelocity: .slow, thenHoldForDuration: 0.3)
    XCTAssertFalse(app.buttons["Cancel reply"].exists)
    // A timestamp drag must spring back without navigating or arming Reply.
    let restingX = target.frame.minX
    start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: -100, dy: 0)),
      withVelocity: .slow, thenHoldForDuration: 0.3)
    XCTAssertFalse(app.buttons["Cancel reply"].exists)
    XCTAssertFalse(app.buttons["thread-back"].exists)
    XCTAssertTrue(target.isHittable)
    XCTAssertEqual(target.frame.minX, restingX, accuracy: 1)
    start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 85, dy: 0)),
      withVelocity: .slow, thenHoldForDuration: 0.3)
    XCTAssertTrue(app.buttons["Cancel reply"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["thread-back"].exists)
    let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    input.typeText("Reference inline reply")
    capture("reference-inline-reply-composer", app)
    app.buttons["send-button"].tap()
    XCTAssertTrue(app.tables["chat-history"].staticTexts["Reference inline reply"].waitForExistence(timeout: 10))
    let quote = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "reply-quote-")).firstMatch
    XCTAssertTrue(quote.waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["Cancel reply"].exists)
    let (data, _) = try await URLSession.shared.data(from: URL(string: base + "/__qa/state")!)
    let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let sent = try XCTUnwrap((state["messages"] as? [[String: Any]])?.first { $0["content"] as? String == "Reference inline reply" })
    let metadata = try XCTUnwrap(sent["metadata"] as? [String: Any])
    XCTAssertNotNil(metadata["replyTo"] as? String)
    XCTAssertNotEqual(metadata["branched"] as? Bool, true)
  }
  func testReferenceMarketplaceRefreshesInstalledIcons() async throws {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .landscapeLeft
    defer { XCUIDevice.shared.orientation = .portrait }
    try await control("/__qa/reset")
    try await control("/__qa/scene", ["scene": "dark-home"])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "dark", "--qa-session", UUID().uuidString]
    app.launch()
    let shortcut = app.buttons["marketplace-button"]
    XCTAssertTrue(shortcut.waitForExistence(timeout: 20))
    XCTAssertEqual(shortcut.value as? String, "0 installed plugins")
    shortcut.tap()
    XCTAssertTrue(app.buttons["installed-plugins"].waitForExistence(timeout: 10))
    try await control("/api/v0/plugins/install", ["pluginKey": "fixture-notes"])
    app.buttons["marketplace-back"].tap()
    let updated = expectation(for: NSPredicate(format: "value == %@", "1 installed plugin"), evaluatedWith: shortcut)
    await fulfillment(of: [updated], timeout: 8)
    let hittable = expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: shortcut)
    await fulfillment(of: [hittable], timeout: 8)
    shortcut.tap()
    XCTAssertTrue(app.buttons["installed-plugins"].waitForExistence(timeout: 10))
    app.buttons["marketplace-back"].tap()
    capture("reference-marketplace-installed-icon", app)
  }
  func testReferenceProviderArtworkInMarketplaceAndSidebar() async throws {
    continueAfterFailure = false
    try await control("/__qa/reset")
    try await control("/__qa/scene", ["scene": "dark-home"])
    let plugins: [[String: Any]] = ["slack", "notion", "granola"].map { key in
      ["key": key, "pluginKey": key, "name": key.capitalized, "installed": true,
       "status": "installed", "description": "Reference provider artwork", "connections": []]
    }
    try await control("/__qa/control", ["pluginCatalog": plugins, "pluginInstalls": plugins])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "dark", "--qa-session", UUID().uuidString]
    app.launch()
    let shortcut = app.buttons["marketplace-button"]
    XCTAssertTrue(shortcut.waitForExistence(timeout: 20))
    let loaded = expectation(for: NSPredicate(format: "value == %@", "3 installed plugins"), evaluatedWith: shortcut)
    await fulfillment(of: [loaded], timeout: 10)
    XCTAssertTrue(shortcut.isHittable)
    capture("reference-three-provider-footer", app)
    shortcut.tap()
    XCTAssertTrue(app.buttons["installed-plugins"].waitForExistence(timeout: 10))
    for name in ["Slack", "Notion", "Granola"] {
      XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch.exists)
    }
    capture("reference-bundled-provider-marketplace", app)
    app.buttons["marketplace-back"].tap()
    XCTAssertTrue(shortcut.waitForExistence(timeout: 5))
    XCTAssertTrue(shortcut.isHittable)
  }
  func testReferenceDeviceControlPlacement() async throws {
    continueAfterFailure = false
    let recording = ProcessInfo.processInfo.environment["REFERENCE_RECORD_EXISTING_APP"] == "1"
    if !recording {
      try await control("/__qa/reset")
      try await control("/__qa/scene", ["scene": "dark-home"])
      try await control("/api/v0/settings/sidebar", [
        "version": 2, "pinnedIds": [], "unreadIds": (0...10).map { "visual-\($0)" },
        "sections": [], "sectionByChannel": [:], "channelOrderByGroup": [:], "unassignedCollapsed": false,
      ])
    }
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "light", "--qa-session", UUID().uuidString]
    if recording { app.activate() } else { app.launch() }
    let search = app.buttons["search-button"], add = app.buttons["new-button"]
    XCTAssertTrue(search.waitForExistence(timeout: 20))
    if recording {
      try await Task.sleep(for: .seconds(2))
      app.scrollViews.firstMatch.swipeUp()
      try await Task.sleep(for: .seconds(1))
      app.scrollViews.firstMatch.swipeDown()
    }
    let layout = ProcessInfo.processInfo.environment["REFERENCE_DEVICE_LAYOUT"] ?? "iphone"
    let name = app.staticTexts["sidebar-account-name"]
    let toggle = app.buttons["sidebar-toggle"]
    if layout == "duo-unfolded" {
      XCTAssertTrue(name.waitForExistence(timeout: 5))
      XCTAssertEqual(app.scrollViews.firstMatch.frame.width, 320, accuracy: 1)
      XCTAssertGreaterThan(toggle.frame.minX, 320, "Duo toggle belongs in the right content panel")
      XCTAssertGreaterThan(search.frame.minX, 320)
      XCTAssertGreaterThan(add.frame.minX, 320)
      XCTAssertEqual(toggle.frame.width, 44, accuracy: 1)
      capture("duo-expanded-controls", app)
      toggle.tap()
      XCTAssertTrue(name.waitForNonExistence(timeout: 5))
      XCTAssertEqual(toggle.label, "Show sidebar")
      toggle.tap()
      XCTAssertTrue(name.waitForExistence(timeout: 5))
    } else if layout == "duo-folded" {
      XCTAssertFalse(name.exists)
      let marketplace = app.buttons["marketplace-button"]
      XCTAssertTrue(marketplace.isHittable)
      XCTAssertEqual(search.frame.midX, marketplace.frame.midX, accuracy: 1)
      XCTAssertGreaterThan(marketplace.frame.minY, search.frame.maxY)
      XCTAssertFalse(toggle.exists)
    } else if layout == "ipad" {
      XCTAssertTrue(name.exists)
      XCTAssertLessThan(toggle.frame.maxX, 320)
    } else {
      XCTAssertFalse(name.exists)
      XCTAssertFalse(app.buttons["marketplace-button"].exists)
      XCTAssertEqual(search.frame.midY, app.buttons["settings-button"].frame.midY, accuracy: 1)
    }
    XCTAssertEqual(app.buttons["inbox-unread"].label, "11 unread conversations")
    capture("device-controls-" + layout, app)
    search.tap()
    XCTAssertTrue(app.textFields["search-input"].waitForExistence(timeout: 5))
    app.buttons["sheet-close"].tap()
    app.buttons["settings-button"].tap()
    XCTAssertTrue(app.buttons["account-settings"].waitForExistence(timeout: 5))
    app.buttons["sheet-close"].tap()
    capture("device-controls-after-actions-" + layout, app)
  }
  func testReferenceSidebarFooterGeometryAndActions() async throws {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .portrait
    try await control("/__qa/reset")
    try await control("/__qa/scene", ["scene": "dark-home"])
    try await control("/api/v0/settings/sidebar", [
      "version": 2, "pinnedIds": [], "unreadIds": (0...10).map { "visual-\($0)" },
      "sections": [], "sectionByChannel": [:], "channelOrderByGroup": [:], "unassignedCollapsed": false,
    ])
    let plugins: [[String: Any]] = ["slack", "notion", "granola"].map { key in
      ["key": key, "pluginKey": key, "name": key.capitalized, "installed": true,
       "status": "installed", "description": "Reference provider artwork", "connections": []]
    }
    try await control("/__qa/control", ["pluginCatalog": plugins, "pluginInstalls": plugins])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base,
      "--appearance", "dark", "--qa-session", UUID().uuidString]
    app.launch()
    let account = app.buttons["settings-button"], marketplace = app.buttons["marketplace-button"]
    XCTAssertTrue(account.waitForExistence(timeout: 15))
    let loaded = expectation(for: NSPredicate(format: "value == %@", "3 installed plugins"), evaluatedWith: marketplace)
    await fulfillment(of: [loaded], timeout: 10)
    let sidebar = app.scrollViews.firstMatch
    XCTAssertEqual(sidebar.frame.width, 320, accuracy: 1)
    XCTAssertEqual(app.buttons["sidebar-toggle"].frame.width, 44, accuracy: 0.5)
    XCTAssertEqual(app.buttons["search-button"].frame.width, 44, accuracy: 0.5)
    XCTAssertEqual(app.buttons["new-button"].frame.midX - app.buttons["search-button"].frame.midX, 52, accuracy: 0.5)
    let firstRow = app.buttons["channel-visual-0"]
    XCTAssertTrue(firstRow.exists)
    XCTAssertEqual(firstRow.frame.minX, 20, accuracy: 0.5)
    XCTAssertEqual(firstRow.frame.height, 86, accuracy: 0.5)
    XCTAssertEqual(account.frame.minX, 20, accuracy: 1)
    XCTAssertEqual(marketplace.frame.maxX, 307, accuracy: 0.5)
    XCTAssertEqual(marketplace.frame.width, 78, accuracy: 0.5)
    XCTAssertEqual(account.frame.midY, marketplace.frame.midY, accuracy: 1)
    XCTAssertEqual(app.frame.maxY - account.frame.midY, 40, accuracy: 2)
    XCTAssertEqual(app.buttons["inbox-unread"].label, "11 unread conversations")
    XCTAssertEqual(account.frame.midY - app.buttons["inbox-unread"].frame.midY, 76, accuracy: 2)
    capture("reference-sidebar-footer-measured", app)
    account.tap()
    XCTAssertTrue(app.buttons["account-settings"].waitForExistence(timeout: 5))
    app.buttons["sheet-close"].tap()
    marketplace.tap()
    XCTAssertTrue(app.buttons["installed-plugins"].waitForExistence(timeout: 10))
    app.buttons["marketplace-back"].tap()
    XCTAssertTrue(account.waitForExistence(timeout: 5))
    sidebar.swipeUp()
    capture("reference-sidebar-footer-scroll", app)
    XCTAssertTrue(account.isHittable)
    XCTAssertTrue(marketplace.isHittable)
    app.buttons["sidebar-toggle"].tap()
    XCTAssertTrue(app.staticTexts["sidebar-account-name"].waitForNonExistence(timeout: 5))
    XCTAssertEqual(app.buttons["sidebar-toggle"].label, "Show sidebar")
    app.buttons["sidebar-toggle"].tap()
    XCTAssertTrue(app.staticTexts["sidebar-account-name"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.scrollViews.firstMatch.frame.width, 320, accuracy: 1)
  }
  func testReferenceCancelReplyPreservesDraftAndSendsWithoutQuote() async throws {
    let app = try await launch("dark-chat", visual: true)
    let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    input.tap(); input.typeText("Unsent draft")
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    capture("reference-draft-before-swipe", app)
    let target = app.tables["chat-history"].staticTexts["Got it — here."]
    XCTAssertTrue(target.isHittable)
    let start = target.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.5))
    start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 85, dy: 0)),
      withVelocity: .slow, thenHoldForDuration: 0.3)
    XCTAssertTrue(app.buttons["Cancel reply"].waitForExistence(timeout: 5))
    XCTAssertEqual(input.value as? String, "Unsent draft")
    app.buttons["Cancel reply"].tap()
    XCTAssertTrue(app.buttons["Cancel reply"].waitForNonExistence(timeout: 5))
    XCTAssertEqual(input.value as? String, "Unsent draft")
    input.typeText(" with suffix")
    app.buttons["send-button"].tap()
    XCTAssertTrue(app.tables["chat-history"].staticTexts["Unsent draft with suffix"].waitForExistence(timeout: 10))
    let (data, _) = try await URLSession.shared.data(from: URL(string: base + "/__qa/state")!)
    let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let sent = try XCTUnwrap((state["messages"] as? [[String: Any]])?.first { $0["content"] as? String == "Unsent draft with suffix" })
    let metadata = try XCTUnwrap(sent["metadata"] as? [String: Any])
    XCTAssertNil(metadata["replyTo"])
    XCTAssertNotEqual(metadata["branched"] as? Bool, true)
  }
  func testShortAndEmptyChatsStartAtBottomWithoutAStuckSpinner() async throws {
    for scene in ["empty-chat", "dark-chat"] {
      let app = try await launch(scene, visual: true)
      XCTAssertFalse(app.buttons["Latest messages"].exists)
      let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
      XCTAssertTrue(input.isEnabled)
      if scene == "dark-chat" { XCTAssertTrue(app.staticTexts["Got it — here."].isHittable) }
      capture(scene + "-native-timeline", app)
      app.terminate()
    }
  }
  func testDraftPersistsWhenLeavingAndReopeningChat() async throws {
    let app = try await launch("edge-text")
    let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    input.tap(); input.typeText("Keep this unsent draft")
    app.buttons["chat-back"].tap()
    let research = app.buttons["channel-channel-research"]
    XCTAssertTrue(research.waitForExistence(timeout: 5))
    research.tap()
    XCTAssertTrue(input.waitForExistence(timeout: 5))
    XCTAssertEqual(input.value as? String, "Keep this unsent draft")
    capture("restored-chat-draft", app)
    app.buttons["chat-back"].tap()
    app.terminate()
    app.launch()
    XCTAssertTrue(input.waitForExistence(timeout: 20))
    XCTAssertEqual(input.value as? String, "Keep this unsent draft", "The draft must survive a process relaunch")
  }
  func testReactionCountsAndOwnSelectionToggleIndependently() async throws {
    let app = try await launch("reactions")
    let thumbs = app.buttons["reaction-content-fixture-👍"]
    XCTAssertTrue(thumbs.waitForExistence(timeout: 5))
    XCTAssertEqual(thumbs.label, "👍, 2 reactions")
    XCTAssertEqual(thumbs.value as? String, "Selected")
    thumbs.tap()
    let changed = expectation(for: NSPredicate(format: "label == %@ AND value == %@", "👍, 1 reactions", "Not selected"), evaluatedWith: thumbs)
    await fulfillment(of: [changed], timeout: 8)
    XCTAssertTrue(app.buttons["reaction-content-fixture-❤️"].exists)
    capture("reaction-counts-and-selection", app)
  }
  func testExchangeIsNavigableAndViewOnly() async throws {
    let app = try await launch("exchange")
    XCTAssertFalse(app.staticTexts["Outgoing exchange payload"].exists)
    app.buttons["exchange-exchange-in"].tap()
    XCTAssertTrue(app.buttons["exchange-back"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.staticTexts["Read-only"].exists)
    XCTAssertTrue(app.staticTexts["Incoming exchange payload"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Outgoing exchange payload"].exists)
    XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "message-input").firstMatch.exists)
    capture("bot-exchange-view-only", app)
    app.buttons["exchange-back"].tap()
    XCTAssertTrue(app.buttons["exchange-exchange-in"].waitForExistence(timeout: 5))
  }
  func testGroupSpeakerIdentityInBothAppearances() async throws {
    for mode in ["light", "dark"] {
      let app = try await launch("group-speakers", appearance: mode)
      XCTAssertTrue(app.buttons["speaker-content-fixture"].waitForExistence(timeout: 5))
      XCTAssertEqual(app.buttons["speaker-content-fixture"].label, "Ops")
      capture("group-speaker-" + mode, app)
      app.buttons["speaker-content-fixture"].tap()
      XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.staticTexts["Ops"].exists)
      app.terminate()
    }
  }
  func testCanonicalSecretMetadataAndSafeFormReceipt() async throws {
    var app = try await launch("secret-canonical")
    XCTAssertTrue(app.staticTexts["Deployment token"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["DEPLOY_TOKEN"].exists)
    XCTAssertTrue(app.staticTexts["Saved securely for you"].exists)
    capture("canonical-secret-request", app)
    app.terminate()
    app = try await launch("secret-bot")
    XCTAssertTrue(app.staticTexts["Shared bot token"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Saved for all users of this Bot"].exists)
    XCTAssertTrue(app.staticTexts["Provided securely"].exists)
    app.terminate()
    app = try await launch("form-receipt")
    XCTAssertTrue(app.staticTexts["Held for recovery"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Filled"].exists)
    XCTAssertFalse(app.staticTexts["NEVER_RENDER_EMAIL"].exists)
    XCTAssertFalse(app.staticTexts["NEVER_RENDER_SECRET"].exists)
    XCTAssertTrue(app.buttons["Open computer"].exists)
    capture("safe-form-receipt", app)
  }
  func testFormEscalationOpensComputerOnlyAfterAcceptedAction() async throws {
    let app = try await launch("form")
    let escalate = app.buttons["form-escalate"]
    XCTAssertTrue(escalate.waitForExistence(timeout: 5))
    escalate.tap()
    XCTAssertTrue(app.buttons["Computer help"].waitForExistence(timeout: 10))
    let (data, _) = try await URLSession.shared.data(from: URL(string: base + "/__qa/state")!)
    let state = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    let messages = try XCTUnwrap(state["messages"] as? [[String: Any]])
    let message = try XCTUnwrap(messages.first { $0["id"] as? String == "content-fixture" })
    XCTAssertEqual((message["metadata"] as? [String: Any])?["cardState"] as? String, "escalated")
    capture("form-escalation-computer", app)
  }
  func testRoutineEventOpensTheReferencedEditor() async throws {
    let app = try await launch("routine-event")
    app.buttons["routine-event-content-fixture"].tap()
    XCTAssertTrue(app.textFields["routine-name"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.textFields["routine-name"].value as? String, "Morning summary")
    capture("routine-event-destination", app)
  }
  func testFocusedExchangeMessageOpensTheReadOnlyConversation() async throws {
    let app = try await launch("exchange")
    app.open(URL(string: "openteam-swift://chat/channel-research?messageId=exchange-in")!)
    XCTAssertTrue(app.buttons["exchange-back"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Incoming exchange payload"].isHittable)
    XCTAssertTrue(app.staticTexts["Read-only"].exists)
    XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "message-input").firstMatch.exists)
  }
  func testOlderSearchContextLoadsForwardWithoutSkippingPages() async throws {
    let app = try await launch("history-pages", visual: true)
    app.open(URL(string: "openteam-swift://chat/visual-chat?messageId=visual-message-visual-chat-20")!)
    XCTAssertTrue(app.staticTexts["Page message 20"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.staticTexts["Page message 180"].exists)
    let later = app.buttons["Load later messages"]
    for _ in 0..<12 {
      if later.isHittable { break }
      app.tables["chat-history"].swipeUp()
    }
    XCTAssertTrue(later.isHittable)
    later.tap()
    for _ in 0..<5 {
      if app.staticTexts["Page message 41"].isHittable { break }
      app.tables["chat-history"].swipeUp()
    }
    XCTAssertTrue(app.staticTexts["Page message 41"].exists)
    XCTAssertFalse(app.staticTexts["Page message 180"].exists)
    app.buttons["Latest messages"].tap()
    XCTAssertTrue(app.staticTexts["Page message 180"].waitForExistence(timeout: 8))
  }
  func testContinuousScrollCrossesNativeWindowsAndReturnsToLatest() async throws {
    let app = try await launch("window-history", visual: true)
    XCTAssertTrue(app.staticTexts["Page message 180"].isHittable)
    for _ in 0..<24 {
      if app.staticTexts["Page message 1"].exists && app.staticTexts["Page message 1"].isHittable { break }
      app.tables["chat-history"].swipeDown(velocity: .fast)
    }
    XCTAssertTrue(app.staticTexts["Page message 1"].isHittable)
    XCTAssertTrue(app.staticTexts["Page message 2"].isHittable)
    XCTAssertTrue(app.staticTexts["Page message 3"].isHittable)
    XCTAssertTrue(app.buttons["Latest messages"].exists)
    capture("continuous-history-first-window", app)
    app.buttons["Latest messages"].tap()
    XCTAssertTrue(app.staticTexts["Page message 180"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.staticTexts["Page message 180"].isHittable)
    XCTAssertFalse(app.buttons["Latest messages"].exists)
  }

}
