import XCTest

/// September 16 seven-screen comparison. Inert content; unmodified native view hierarchy.
@MainActor final class SevenReferenceUITests: XCTestCase {
  let base = "http://127.0.0.1:20026"

  func launch(home: Bool = false, voice: Bool = false, theme: String = "dark") async throws -> XCUIApplication {
    continueAfterFailure = false
    var request = URLRequest(url: URL(string: base + "/__qa/scene")!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: ["scene": home ? "dark-home" : "dark-chat-seven"])
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", theme]
    if !home { app.launchArguments += ["--open-channel", "visual-chat"] }
    if voice { app.launchArguments += ["--qa-synthetic-voice"] }
    app.launch()
    XCTAssertTrue(app.buttons[home ? "settings-button" : "chat-back"].waitForExistence(timeout: 15))
    if !home {
      XCTAssertTrue(app.staticTexts["Got it — here."].waitForExistence(timeout: 10))
      // Native rows may enter the accessibility tree while the initial history
      // position is still settling. The composer is disabled until that finishes.
      XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-loading")
        .firstMatch.waitForNonExistence(timeout: 15))
      XCTAssertTrue(field(app).isEnabled)
    }
    return app
  }

  func capture(_ number: Int, _ app: XCUIApplication, settle: TimeInterval = 0.7) {
    // Let the native menu/material animation finish before collecting evidence.
    Thread.sleep(forTimeInterval: settle)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = String(format: "seven-native-%02d", number)
    screenshot.lifetime = .keepAlways
    add(screenshot)
    let tree = XCTAttachment(string: app.debugDescription)
    tree.name = String(format: "seven-tree-%02d", number)
    tree.lifetime = .keepAlways
    add(tree)
  }

  func field(_ app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
  }

  func testSearchAndCreationGeometryInBothAppearances() async throws {
    for theme in ["dark", "light"] {
      let app = try await launch(home: true, theme: theme)
      let home = XCTAttachment(screenshot: app.screenshot())
      home.name = "home-geometry-" + theme; home.lifetime = .keepAlways; add(home)
      app.buttons["Search"].tap()
      XCTAssertTrue(app.textFields["search-input"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
      let search = XCTAttachment(screenshot: app.screenshot())
      search.name = "search-geometry-" + theme; search.lifetime = .keepAlways; add(search)
      app.buttons["sheet-close"].tap()
      XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 5))
      app.buttons["New conversation"].tap()
      XCTAssertTrue(app.buttons["New Group Chat"].waitForExistence(timeout: 5))
      let menu = XCTAttachment(screenshot: app.screenshot())
      menu.name = "creation-geometry-" + theme; menu.lifetime = .keepAlways; add(menu)
      app.terminate()
    }
  }
  func test01AttachmentMenuOverKeyboard() async throws {
    let app = try await launch()
    field(app).tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    XCTAssertLessThan(app.keyboards.firstMatch.frame.minY, app.frame.maxY - 200)
    app.buttons["attach-button"].tap()
    XCTAssertTrue(app.buttons["Choose File"].waitForExistence(timeout: 5))
    XCTAssertLessThan(app.buttons["Attach Image"].frame.minY, app.buttons["Take Photo"].frame.minY)
    XCTAssertLessThan(app.buttons["Take Photo"].frame.minY, app.buttons["Choose File"].frame.minY)
    XCTAssertTrue(app.keyboards.firstMatch.exists)
    XCTAssertLessThan(app.keyboards.firstMatch.frame.minY, app.frame.maxY - 200)
    capture(1, app)
    app.buttons["Choose File"].tap()
    XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 8))
  }

  func testAttachmentPickerCancelKeepsDraftInBothThemes() async throws {
    for theme in ["dark", "light"] {
      let app = try await launch(theme: theme)
      field(app).tap()
      field(app).typeText("Unsent attachment draft")
      XCTAssertLessThan(app.keyboards.firstMatch.frame.minY, app.frame.maxY - 200)
      app.buttons["attach-button"].tap()
      XCTAssertTrue(app.buttons["Choose File"].waitForExistence(timeout: 5))
      XCTAssertLessThan(app.buttons["Attach Image"].frame.minY, app.buttons["Take Photo"].frame.minY)
      XCTAssertLessThan(app.buttons["Take Photo"].frame.minY, app.buttons["Choose File"].frame.minY)
      XCTAssertLessThan(app.keyboards.firstMatch.frame.minY, app.frame.maxY - 200)
      let menu = XCTAttachment(screenshot: app.screenshot())
      menu.name = "attachment-menu-draft-" + theme; menu.lifetime = .keepAlways; add(menu)
      app.buttons["Attach Image"].tap()
      XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 8))
      app.buttons["Cancel"].tap()
      XCTAssertTrue(field(app).waitForExistence(timeout: 5))
      XCTAssertEqual(field(app).value as? String, "Unsent attachment draft")
      field(app).tap()
      app.buttons["attach-button"].tap()
      XCTAssertTrue(app.buttons["Choose File"].waitForExistence(timeout: 5))
      app.buttons["Choose File"].tap()
      XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 8))
      app.buttons["Cancel"].tap()
      XCTAssertEqual(field(app).value as? String, "Unsent attachment draft")
      XCTAssertFalse(app.alerts.firstMatch.exists)
      app.terminate()
    }
  }

  func testAttachmentMenuDismissalPreservesKeyboardAndPosition() async throws {
    for theme in ["dark", "light"] {
      let app = try await launch(theme: theme)
      field(app).tap()
      field(app).typeText("Keep this draft")
      let inputFrame = field(app).frame
      let messageFrame = app.staticTexts["Got it — here."].frame
      for _ in 0..<2 {
        app.buttons["attach-button"].tap()
        XCTAssertTrue(app.buttons["Choose File"].waitForExistence(timeout: 5))
        let menu = app.descendants(matching: .any).matching(identifier: "attachment-menu-panel").firstMatch
        XCTAssertEqual(menu.frame.minX, 8, accuracy: 1)
        XCTAssertEqual(menu.frame.width, 250, accuracy: 1)
        XCTAssertEqual(field(app).frame.minY, inputFrame.minY, accuracy: 1)
        XCTAssertEqual(app.staticTexts["Got it — here."].frame.minY, messageFrame.minY, accuracy: 1)
        XCTAssertLessThan(app.keyboards.firstMatch.frame.minY, app.frame.maxY - 200)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.25)).tap()
        XCTAssertTrue(app.buttons["Choose File"].waitForNonExistence(timeout: 5))
        XCTAssertEqual(field(app).value as? String, "Keep this draft")
        XCTAssertEqual(field(app).frame.minY, inputFrame.minY, accuracy: 1)
        XCTAssertLessThan(app.keyboards.firstMatch.frame.minY, app.frame.maxY - 200)
      }
      // Dismissing a panel must not leave an invisible layer eating chat taps.
      field(app).typeText(" still editable")
      XCTAssertEqual(field(app).value as? String, "Keep this draft still editable")
      app.terminate()
    }
  }

  func testAttachmentMenuWithoutKeyboardAndBackgroundCleanup() async throws {
    for theme in ["dark", "light"] {
      let app = try await launch(theme: theme)
      app.buttons["attach-button"].tap()
      XCTAssertTrue(app.buttons["Choose File"].waitForExistence(timeout: 5))
      XCTAssertFalse(app.keyboards.firstMatch.exists)
      let capture = XCTAttachment(screenshot: app.screenshot())
      capture.name = "attachment-menu-unfocused-" + theme
      capture.lifetime = .keepAlways; add(capture)
      XCUIDevice.shared.press(.home)
      app.activate()
      XCTAssertTrue(app.buttons["Choose File"].waitForNonExistence(timeout: 5))
      field(app).tap()
      field(app).typeText("After returning")
      XCTAssertEqual(field(app).value as? String, "After returning")
      app.terminate()
    }
  }

  func test02RecordingControls() async throws {
    let app = try await launch(voice: true)
    app.buttons["Record voice note"].tap()
    let recording = app.descendants(matching: .any).matching(identifier: "Recording voice note").firstMatch
    let elapsed = expectation(for: NSPredicate(format: "value == %@", "2 seconds"), evaluatedWith: recording)
    await fulfillment(of: [elapsed], timeout: 8)
    capture(2, app, settle: 0)
    app.buttons["Stop recording"].tap()
    XCTAssertTrue(app.buttons["Discard recording"].waitForExistence(timeout: 5))
    app.buttons["Discard recording"].tap()
    XCTAssertTrue(field(app).waitForExistence(timeout: 5))
  }

  func test03MultilineDraft() async throws {
    let app = try await launch()
    field(app).tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    field(app).typeText("Heheh\n\n")
    XCTAssertTrue(app.buttons["send-button"].isEnabled)
    capture(3, app)
    XCTAssertLessThanOrEqual(app.buttons["send-button"].frame.maxY, app.keyboards.firstMatch.frame.minY)
    XCTAssertEqual(field(app).value as? String, "Heheh\n\n")
  }

  func test04ScrolledChatAndReturnToLatest() async throws {
    let app = try await launch()
    let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.5))
    start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 70)), withVelocity: .slow, thenHoldForDuration: 0.5)
    XCTAssertTrue(app.buttons["Latest messages"].waitForExistence(timeout: 5))
    capture(4, app)
    let before = app.staticTexts["Got it — here."].frame
    app.buttons["Latest messages"].tap()
    let hiddenAfterFirstTap = app.buttons["Latest messages"].waitForNonExistence(timeout: 5)
    let after = app.staticTexts["Got it — here."].frame
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "seven-after-jump"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    let tree = XCTAttachment(string: app.debugDescription)
    tree.name = "seven-after-jump-tree"
    tree.lifetime = .keepAlways
    add(tree)
    if !hiddenAfterFirstTap { app.buttons["Latest messages"].tap() }
    let hiddenAfterSecondTap = app.buttons["Latest messages"].waitForNonExistence(timeout: 5)
    let facts = XCTAttachment(string: "Last message before: \(before)\nAfter first tap: \(after)\nAfter second tap: \(app.staticTexts["Got it — here."].frame)\nJump hidden after first: \(hiddenAfterFirstTap)\nJump hidden after second: \(hiddenAfterSecondTap)")
    facts.name = "seven-jump-observations"
    facts.lifetime = .keepAlways
    add(facts)
    XCTAssertTrue(hiddenAfterFirstTap, "Latest-messages button remains after jumping to the bottom")
    XCTAssertTrue(app.staticTexts["Got it — here."].isHittable)
  }

  func test05LatestChat() async throws {
    let app = try await launch()
    XCTAssertFalse(app.keyboards.firstMatch.exists)
    XCTAssertFalse(app.buttons["Latest messages"].exists)
    capture(5, app)
  }

  func test06SettingsSheet() async throws {
    let app = try await launch(home: true)
    app.buttons["settings-button"].tap()
    XCTAssertTrue(app.buttons["account-settings"].waitForExistence(timeout: 5))
    capture(6, app)
  }

  func test07HomeCreationMenu() async throws {
    let app = try await launch(home: true)
    app.buttons["new-button"].tap()
    XCTAssertTrue(app.buttons["New Bot"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["New Group Chat"].exists)
    capture(7, app)
    app.buttons["New Group Chat"].tap()
    XCTAssertTrue(app.textFields["group-search"].waitForExistence(timeout: 5))
  }
}
