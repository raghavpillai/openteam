import XCTest

/// Record this deterministic scenario with simctl recordVideo for frame inspection.
@MainActor final class ChatMotionUITests: XCTestCase {
  let base = URL(string: "http://127.0.0.1:20070")!
  var marks: [[String: Any]] = []
  func control(_ path: String, _ body: [String: Any]) async throws {
    var request = URLRequest(url: base.appendingPathComponent(path))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }
  func mark(_ name: String) {
    marks.append(["name": name, "time": Date().timeIntervalSince1970])
  }
  func capture(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
  func testDelayedImagePreservesVisibleTranscriptGeometry() async throws {
    continueAfterFailure = false
    try await control("__qa/scene", ["scene": "initial-media-layout"])
    try await control("__qa/control", ["failures": [
      "GET /api/v0/assets/layout-portrait": ["delayMs": 12000, "count": 10],
    ]])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--ui-testing-delay-document", "--server", base.absoluteString,
      "--appearance", "dark", "--open-channel", "visual-chat"]
    app.launch()
    defer { app.terminate() }
    let marker = app.staticTexts["Layout settled marker"]
    XCTAssertTrue(marker.waitForExistence(timeout: 15))
    let spinner = app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch
    XCTAssertTrue(spinner.waitForNonExistence(timeout: 15))
    let picture = app.buttons["attachment-layout-portrait"]
    XCTAssertTrue(picture.isHittable)
    let initial = picture.frame
    let start = Date()
    var samples: [[String: Double]] = []
    for _ in 0..<28 {
      let frame = picture.frame
      samples.append(["seconds": Date().timeIntervalSince(start), "x": frame.minX,
        "y": frame.minY, "width": frame.width, "height": frame.height, "markerY": marker.frame.midY])
      try await Task.sleep(for: .milliseconds(500))
    }
    let evidence = XCTAttachment(data: try JSONSerialization.data(withJSONObject: samples, options: .prettyPrinted),
      uniformTypeIdentifier: "public.json")
    evidence.name = "visible-media-geometry"
    evidence.lifetime = .keepAlways
    add(evidence)
    capture("visible-media-final", app)
    let first = try XCTUnwrap(samples.first)
    for sample in samples {
      for key in ["x", "y", "width", "height", "markerY"] {
        XCTAssertEqual(sample[key]!, first[key]!, accuracy: 1, "Visible media changed: \(key)")
      }
    }
    XCTAssertEqual(initial.width, 120, accuracy: 1)
    XCTAssertEqual(initial.height, 240, accuracy: 1)
  }
  func testFailedInitialHistoryDoesNotPresentBootstrapPreviewAsFullChat() async throws {
    continueAfterFailure = false
    try await control("__qa/scene", ["scene": "history-pages"])
    try await control("__qa/control", ["failures": [
      "GET /api/v0/channels/visual-chat/history": ["status": 503, "count": 100],
    ]])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base.absoluteString, "--open-channel", "visual-chat"]
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(app.buttons["chat-load-error"].waitForExistence(timeout: 12),
      "The single bootstrap preview must not masquerade as the complete conversation")
    XCTAssertFalse(app.staticTexts["Page message 180"].isHittable)
    // Exercise retry while the failure is stable; clearing it first lets the
    // automatic recovery remove the button before XCTest can synthesize a tap.
    app.buttons["chat-load-error"].tap()
    XCTAssertTrue(app.buttons["chat-load-error"].exists)
    try await control("__qa/control", ["failures": [:]])
    XCTAssertTrue(app.buttons["chat-load-error"].waitForNonExistence(timeout: 15))
    XCTAssertTrue(app.staticTexts["Page message 180"].waitForExistence(timeout: 15))
    XCTAssertTrue(app.staticTexts["Page message 179"].exists)
  }
  func testColdLaunchKeepsSavedHistoryReadableWhenRefreshFails() async throws {
    continueAfterFailure = false
    try await control("__qa/scene", ["scene": "history-pages"])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--qa-session", UUID().uuidString,
      "--server", base.absoluteString, "--open-channel", "visual-chat"]
    app.launch()
    defer { app.terminate() }
    let spinner = app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 15))
    XCTAssertTrue(spinner.waitForNonExistence(timeout: 15))
    XCTAssertTrue(app.staticTexts["Page message 179"].exists)
    // Persist through the normal background lifecycle, then create a new process.
    XCUIDevice.shared.press(.home)
    app.terminate()
    try await control("__qa/control", ["failures": [
      "GET /api/v0/channels/visual-chat/history": ["status": 503, "count": 100],
    ]])
    app.launch()
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 15))
    XCTAssertTrue(spinner.waitForNonExistence(timeout: 15))
    XCTAssertTrue(app.staticTexts["Page message 180"].isHittable)
    XCTAssertTrue(app.staticTexts["Page message 179"].exists)
    XCTAssertFalse(app.buttons["chat-load-error"].exists)
  }
  func testSwitchingChatsWhileHistoryLoadsKeepsTheSelectedConversation() async throws {
    continueAfterFailure = false
    try await control("__qa/scene", ["scene": "navigation-layout"])
    try await control("__qa/control", ["failures": [
      "GET /api/v0/channels/visual-chat/history": ["delayMs": 5000, "count": 2],
    ]])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--ui-testing-delay-document", "--server", base.absoluteString]
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(app.buttons["channel-visual-chat"].waitForExistence(timeout: 15))
    app.buttons["channel-visual-chat"].tap()
    let spinner = app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch
    XCTAssertTrue(spinner.waitForExistence(timeout: 3))
    app.buttons["chat-back"].tap()
    XCTAssertTrue(app.buttons["channel-visual-other"].waitForExistence(timeout: 5))
    app.buttons["channel-visual-other"].tap()
    XCTAssertTrue(spinner.waitForNonExistence(timeout: 15))
    XCTAssertTrue(app.staticTexts["Other chat latest"].isHittable)
    let y = app.staticTexts["Other chat latest"].frame.midY
    try await Task.sleep(for: .seconds(5))
    XCTAssertTrue(app.staticTexts["Other chat latest"].isHittable)
    XCTAssertEqual(app.staticTexts["Other chat latest"].frame.midY, y, accuracy: 1)
    XCTAssertFalse(app.staticTexts["Main chat latest"].exists)
    for (id, label) in [("visual-chat", "Main chat latest"), ("visual-other", "Other chat latest"),
                        ("visual-chat", "Main chat latest")] {
      app.buttons["chat-back"].tap()
      XCTAssertTrue(app.buttons["channel-" + id].waitForExistence(timeout: 5))
      app.buttons["channel-" + id].tap()
      XCTAssertTrue(app.staticTexts[label].waitForExistence(timeout: 15))
      XCTAssertTrue(spinner.waitForNonExistence(timeout: 15))
      XCTAssertTrue(app.staticTexts[label].isHittable)
      let y = app.staticTexts[label].frame.midY
      try await Task.sleep(for: .milliseconds(700))
      XCTAssertEqual(app.staticTexts[label].frame.midY, y, accuracy: 1)
    }
  }
  func testBackgroundRefreshPreservesTheMessageBeingRead() async throws {
    continueAfterFailure = false
    try await control("__qa/scene", ["scene": "history-pages"])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base.absoluteString, "--open-channel", "visual-chat"]
    app.launch()
    defer { app.terminate() }
    let spinner = app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 15))
    XCTAssertTrue(spinner.waitForNonExistence(timeout: 15))
    app.tables["chat-history"].swipeDown()
    XCTAssertTrue(app.buttons["Latest messages"].waitForExistence(timeout: 5))
    let candidates = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Page message '")).allElementsBoundByIndex
    let anchor = try XCTUnwrap(candidates.first(where: { $0.isHittable && $0.frame.midY > 180 && $0.frame.midY < 650 }))
    let label = anchor.label
    let y = anchor.frame.midY
    XCUIDevice.shared.press(.home)
    try await control("__qa/motion", ["active": false, "content": "Arrived while backgrounded"])
    app.activate()
    XCTAssertTrue(app.staticTexts[label].waitForExistence(timeout: 15))
    try await Task.sleep(for: .seconds(3))
    XCTAssertEqual(app.staticTexts[label].frame.midY, y, accuracy: 2)
    XCTAssertTrue(app.buttons["Latest messages"].exists)
    app.buttons["Latest messages"].tap()
    XCTAssertTrue(app.staticTexts["Arrived while backgrounded"].waitForExistence(timeout: 10))
  }
  func testInitialMediaAndDocumentsKeepTheirPositions() async throws {
    continueAfterFailure = false
    try await control("__qa/scene", ["scene": "initial-media-layout"])
    try await control("__qa/control", ["failures": [
      "GET /api/v0/assets/layout-portrait": ["delayMs": 6000, "count": 10],
    ]])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--ui-testing-delay-document", "--server", base.absoluteString,
      "--appearance", "dark", "--open-channel", "visual-chat"]
    app.launch()
    defer { app.terminate() }
    let spinner = app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch
    XCTAssertTrue(spinner.waitForExistence(timeout: 10))
    XCTAssertTrue(spinner.waitForNonExistence(timeout: 15))
    let marker = app.staticTexts["Layout settled marker"]
    XCTAssertTrue(marker.isHittable)
    let picture = app.buttons["attachment-layout-portrait"]
    XCTAssertTrue(picture.exists)
    let frame = picture.frame
    XCTAssertEqual(frame.width, 120, accuracy: 1)
    XCTAssertEqual(frame.height, 240, accuracy: 1)
    let markerY = marker.frame.midY
    // SwiftUI can briefly publish a zero accessibility frame when the button's
    // loading content changes. Measure the native row that positions the chat.
    let mediaRow = app.tables["chat-history"].cells.containing(.button, identifier: "attachment-layout-portrait").firstMatch
    let mediaFrame = mediaRow.frame
    XCTAssertGreaterThan(mediaFrame.height, 0)
    let document = app.tables["chat-history"].cells.containing(.any, identifier: "message-visual-message-visual-chat-3").firstMatch
    let documentFrame = document.frame
    XCTAssertGreaterThan(documentFrame.height, 0)
    for _ in 0..<12 {
      try await Task.sleep(for: .milliseconds(500))
      XCTAssertEqual(marker.frame.midY, markerY, accuracy: 1)
      let currentMediaFrame = mediaRow.frame
      XCTAssertEqual(currentMediaFrame.minY, mediaFrame.minY, accuracy: 1)
      XCTAssertEqual(currentMediaFrame.height, mediaFrame.height, accuracy: 1)
      XCTAssertEqual(document.frame.minY, documentFrame.minY, accuracy: 1)
      XCTAssertEqual(document.frame.height, documentFrame.height, accuracy: 1)
    }
    XCTAssertEqual(picture.value as? String, "Loaded")
    let loadedFrame = picture.frame
    XCTAssertEqual(loadedFrame.minX, frame.minX, accuracy: 1)
    XCTAssertEqual(loadedFrame.minY, frame.minY, accuracy: 1)
    XCTAssertEqual(loadedFrame.width, frame.width, accuracy: 1)
    XCTAssertEqual(loadedFrame.height, frame.height, accuracy: 1)
    capture("initial-media-layout-settled", app)
    app.buttons["chat-back"].tap()
    XCTAssertTrue(app.buttons["channel-visual-chat"].waitForExistence(timeout: 5))
    app.buttons["channel-visual-chat"].tap()
    XCTAssertTrue(marker.waitForExistence(timeout: 10))
    XCTAssertTrue(spinner.waitForNonExistence(timeout: 10))
    XCTAssertEqual(marker.frame.midY, markerY, accuracy: 1)
    XCTAssertEqual(picture.frame.height, frame.height, accuracy: 1)
  }
  func testFailedImageKeepsItsReservedFrame() async throws {
    continueAfterFailure = false
    try await control("__qa/scene", ["scene": "initial-media-layout"])
    try await control("__qa/control", ["failures": [
      "GET /api/v0/assets/layout-portrait": ["delayMs": 4000, "status": 503, "count": 10],
    ]])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base.absoluteString, "--open-channel", "visual-chat"]
    app.launch()
    defer { app.terminate() }
    let marker = app.staticTexts["Layout settled marker"]
    XCTAssertTrue(marker.waitForExistence(timeout: 15))
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch.waitForNonExistence(timeout: 15))
    let picture = app.buttons["attachment-layout-portrait"]
    let frame = picture.frame
    let markerY = marker.frame.midY
    let failed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == 'Failed'"), object: picture)
    XCTAssertEqual(XCTWaiter.wait(for: [failed], timeout: 10), .completed)
    XCTAssertEqual(picture.frame.minY, frame.minY, accuracy: 1)
    XCTAssertEqual(picture.frame.height, frame.height, accuracy: 1)
    XCTAssertEqual(marker.frame.midY, markerY, accuracy: 1)
    XCTAssertEqual(picture.label, "Open portrait.png")
  }
  func testStalledDocumentFallsBackToText() async throws {
    continueAfterFailure = false
    try await control("__qa/scene", ["scene": "initial-media-layout"])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--ui-testing-stall-document", "--server", base.absoluteString,
      "--open-channel", "visual-chat"]
    app.launch()
    defer { app.terminate() }
    let spinner = app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch
    XCTAssertTrue(spinner.waitForExistence(timeout: 10))
    XCTAssertTrue(spinner.waitForNonExistence(timeout: 15))
    let marker = app.staticTexts["Layout settled marker"]
    XCTAssertTrue(marker.isHittable)
    let frame = marker.frame
    try await Task.sleep(for: .seconds(5))
    XCTAssertEqual(marker.frame.minY, frame.minY, accuracy: 1)
    XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "rich-markdown").firstMatch.exists)
  }
  func testComposerFocusAtTextAndPaddingInBothAppearances() async throws {
    continueAfterFailure = false
    for appearance in ["dark", "light"] {
      for attempt in 0..<5 {
        try await control("__qa/scene", ["scene": "motion-reference"])
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--server", base.absoluteString,
          "--appearance", appearance, "--open-channel", "visual-chat"]
        app.launch()
        defer { app.terminate() }
        let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 15))
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-loading")
          .firstMatch.waitForNonExistence(timeout: 15))
        XCTAssertTrue(input.isEnabled)
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3),
          "The first tap must focus the native field (\(appearance), launch \(attempt))")
        input.typeText("Focus check")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
        // This is inside the 44-point message bar, above the text's AX rectangle.
        input.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: -0.3)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3),
          "The message bar's padding must also focus the field")
        input.typeText(" reopened")
        XCTAssertTrue(app.buttons["send-button"].isEnabled)
      }
    }
  }

  func testHistoryScrollDismissesKeyboardAndPreservesDraft() async throws {
    continueAfterFailure = false
    func waitForKeyboard(_ app: XCUIApplication, visible: Bool) -> Bool {
      let predicate = NSPredicate { _, _ in
        // UIKit can keep a keyboard accessibility node below the screen after
        // on-drag dismissal. Its existence alone does not mean it is visible.
        let frames = app.keyboards.allElementsBoundByIndex.map { $0.frame }
        let onScreen = frames.contains { !$0.isEmpty && app.frame.intersects($0) }
        return onScreen == visible
      }
      return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: 3) == .completed
    }
    for appearance in ["light", "dark"] {
      try await control("__qa/scene", ["scene": "history-pages"])
      let app = XCUIApplication()
      app.launchArguments = ["--ui-testing", "--server", base.absoluteString,
        "--appearance", appearance, "--open-channel", "visual-chat"]
      app.launch()
      let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
      XCTAssertTrue(input.waitForExistence(timeout: 15))
      XCTAssertTrue(app.staticTexts["Page message 180"].waitForExistence(timeout: 15))
      input.tap()
      XCTAssertTrue(waitForKeyboard(app, visible: true))
      input.typeText("Keep this draft")
      // Both directions must dismiss, including browsing older messages and
      // scrolling back toward the latest, without sending or clearing a draft.
      for dy in [140.0, -140.0] {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.34))
        start.press(forDuration: 0.05,
          thenDragTo: start.withOffset(CGVector(dx: 0, dy: dy)),
          withVelocity: .slow, thenHoldForDuration: 0.1)
        XCTAssertTrue(waitForKeyboard(app, visible: false),
          "Scrolling history must dismiss the keyboard in either direction")
        XCTAssertGreaterThan(input.frame.minY, app.frame.maxY * 0.8)
        XCTAssertEqual(input.value as? String, "Keep this draft")
        capture("scroll-dismiss-\(appearance)-\(dy)", app)
        input.tap()
        XCTAssertTrue(waitForKeyboard(app, visible: true))
      }
      input.typeText(" reopened")
      // A native field tap positions the caret where tapped; insertion needn't
      // be at the end. Verify editing resumed without losing the original draft.
      let edited = try XCTUnwrap(input.value as? String)
      XCTAssertTrue(edited.contains(" reopened"))
      XCTAssertEqual(edited.replacingOccurrences(of: " reopened", with: ""), "Keep this draft")
      app.terminate()
    }
  }

  func testOpeningShowsSpinnerThenStableLatestMessage() async throws {
    continueAfterFailure = false
    for appearance in ["dark", "light"] {
      try await control("__qa/scene", ["scene": "history-pages"])
      try await control(
        "__qa/control",
        [
          "failures": [
            "GET /api/v0/channels/visual-chat/history": ["delayMs": 7000, "count": 10]
          ]
        ])
      let app = XCUIApplication()
      app.launchArguments = [
        "--ui-testing", "--server", base.absoluteString, "--appearance", appearance,
      ]
      app.launch()
      let chat = app.buttons["channel-visual-chat"]
      XCTAssertTrue(chat.waitForExistence(timeout: 15))
      mark("open-chat-" + appearance)
      chat.tap()
      let spinner = app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch
      XCTAssertTrue(spinner.waitForExistence(timeout: 3))
      XCTAssertFalse(app.staticTexts["Page message 180"].isHittable)
      XCTAssertFalse(app.buttons["Latest messages"].exists)
      capture("opening-spinner-" + appearance, app)
      XCTAssertTrue(spinner.waitForNonExistence(timeout: 15))
      let latest = app.staticTexts["Page message 180"]
      XCTAssertTrue(
        latest.isHittable, "The first revealed history must already show the latest message")
      let y = latest.frame.midY
      for _ in 0..<4 {
        try await Task.sleep(for: .milliseconds(250))
        XCTAssertEqual(
          latest.frame.midY, y, accuracy: 1, "No delayed scroll after revealing history")
        XCTAssertFalse(app.buttons["Latest messages"].exists)
      }
      capture("opening-latest-" + appearance, app)
      // A previously loaded page opens immediately while its slow refresh runs.
      app.buttons["chat-back"].tap()
      chat.tap()
      XCTAssertTrue(latest.waitForExistence(timeout: 3))
      XCTAssertTrue(latest.isHittable)
      XCTAssertFalse(spinner.exists)
      capture("opening-cached-" + appearance, app)
      app.terminate()
    }
    let timing = XCTAttachment(
      data: try JSONSerialization.data(withJSONObject: marks), uniformTypeIdentifier: "public.json")
    timing.name = "opening-timestamps"
    timing.lifetime = .keepAlways
    add(timing)
  }

  func testEmptyChatFinishesLoadingAndCanSend() async throws {
    continueAfterFailure = false
    try await control("__qa/scene", ["scene": "empty-chat"])
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--server", base.absoluteString, "--open-channel", "visual-chat",
    ]
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 15))
    XCTAssertTrue(
      app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch
        .waitForNonExistence(timeout: 8))
    let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    XCTAssertTrue(input.isEnabled)
    input.tap()
    input.typeText("First message")
    app.buttons["send-button"].tap()
    XCTAssertTrue(app.staticTexts["First message"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["Latest messages"].exists)
    try await Task.sleep(for: .milliseconds(500))
    let bottom = app.staticTexts["First message"].frame.maxY
    try await control("__qa/motion", ["active": true])
    XCTAssertTrue(app.otherElements["bot-activity"].waitForExistence(timeout: 8))
    try await Task.sleep(for: .milliseconds(500))
    try await control("__qa/motion", ["active": false])
    let activityHidden = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "hittable == false"), object: app.otherElements["bot-activity"])
    XCTAssertEqual(XCTWaiter.wait(for: [activityHidden], timeout: 8), .completed)
    try await Task.sleep(for: .milliseconds(500))
    XCTAssertEqual(app.staticTexts["First message"].frame.maxY, bottom, accuracy: 1)
    XCTAssertFalse(app.buttons["Latest messages"].exists)
    capture("short-chat-after-activity-collapse", app)
  }

  func testUnavailableChatShowsReferenceErrorAndRetries() async throws {
    continueAfterFailure = false
    for (appearance, status) in [("light", 503), ("dark", 404)] {
      try await control("__qa/scene", ["scene": "empty-chat"])
      try await control("__qa/control", ["failures": [
        "GET /api/v0/channels/visual-chat/history": ["status": status, "count": 100],
      ]])
      let app = XCUIApplication()
      app.launchArguments = ["--ui-testing", "--server", base.absoluteString,
        "--appearance", appearance, "--open-channel", "visual-chat"]
      app.launch()
      let error = app.buttons["chat-load-error"]
      XCTAssertTrue(error.waitForExistence(timeout: 12))
      XCTAssertTrue(app.buttons["chat-back"].exists)
      XCTAssertFalse(app.alerts.firstMatch.exists)
      XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "message-input").firstMatch.exists)
      XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch.exists)
      capture("chat-load-error-" + appearance, app)
      app.buttons["chat-back"].tap()
      XCTAssertTrue(app.buttons["channel-visual-chat"].waitForExistence(timeout: 5))
      app.buttons["channel-visual-chat"].tap()
      XCTAssertTrue(error.waitForExistence(timeout: 5))
      error.tap()
      XCTAssertTrue(error.exists)
      try await control("__qa/control", ["failures": [:]])
      XCTAssertTrue(error.waitForNonExistence(timeout: 10))
      let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
      XCTAssertTrue(input.waitForExistence(timeout: 5))
      XCTAssertTrue(input.isEnabled)
      input.tap()
      input.typeText("Recovered chat")
      app.buttons["send-button"].tap()
      XCTAssertTrue(app.staticTexts["Recovered chat"].waitForExistence(timeout: 5))
      app.terminate()
    }
  }

  func testOfflineChatRecoversWithoutTappingError() async throws {
    continueAfterFailure = false
    try await control("__qa/scene", ["scene": "empty-chat"])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base.absoluteString, "--appearance", "light"]
    app.launch()
    XCTAssertTrue(app.buttons["channel-visual-chat"].waitForExistence(timeout: 12))
    try await control("__qa/control", ["offline": true])
    app.buttons["channel-visual-chat"].tap()
    XCTAssertTrue(app.buttons["chat-load-error"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.alerts.firstMatch.exists)
    try await control("__qa/control", ["offline": false])
    XCTAssertTrue(app.buttons["chat-load-error"].waitForNonExistence(timeout: 15))
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "message-input").firstMatch.isEnabled)
    app.terminate()
  }

  func testOfflineChatKeepsCachedMessagesReadable() async throws {
    continueAfterFailure = false
    try await control("__qa/scene", ["scene": "dark-chat-seven"])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base.absoluteString,
      "--appearance", "light", "--open-channel", "visual-chat"]
    app.launch()
    XCTAssertTrue(app.staticTexts["Got it — here."].waitForExistence(timeout: 12))
    app.buttons["chat-back"].tap()
    try await control("__qa/control", ["offline": true])
    app.buttons["channel-visual-chat"].tap()
    XCTAssertTrue(app.staticTexts["Got it — here."].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["chat-load-error"].exists)
    XCTAssertFalse(app.alerts.firstMatch.exists)
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "message-input").firstMatch.isEnabled)
    capture("offline-cached-chat-readable", app)
    app.terminate()
  }
  func testKeyboardSendAndActivityTransitions() async throws {
    continueAfterFailure = false
    try await control("__qa/scene", ["scene": "dark-chat-seven"])
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--server", base.absoluteString,
      "--appearance", "dark", "--open-channel", "visual-chat",
    ]
    app.launch()
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 15))
    let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    XCTAssertTrue(input.waitForExistence(timeout: 10))
    // A visible composer stays disabled until the history has reached Latest.
    // Wait for that state instead of assuming a fixed launch delay is enough.
    XCTAssertTrue(
      app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch
        .waitForNonExistence(timeout: 15))
    XCTAssertTrue(input.isEnabled)
    try await Task.sleep(for: .seconds(2))
    let latestReply = app.staticTexts["Got it — here."]
    let originalBottom = latestReply.frame.maxY
    mark("keyboard-open")
    input.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    input.typeText("Motion check")
    try await Task.sleep(for: .seconds(1))
    capture("keyboard-open", app)
    mark("keyboard-tap-outside")
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
    let dismissed = app.keyboards.firstMatch.waitForNonExistence(timeout: 3)
    XCTAssertTrue(dismissed, "Tapping chat history must dismiss the keyboard")
    if !dismissed { app.tables["chat-history"].swipeDown() }
    try await Task.sleep(for: .seconds(1))
    if dismissed { XCTAssertEqual(latestReply.frame.maxY, originalBottom, accuracy: 3) }
    capture("keyboard-closed", app)
    mark("keyboard-reopen")
    input.tap()
    try await control(
      "__qa/control",
      [
        "failures": [
          "POST /api/v0/conversations/conversation-visual-chat/messages": ["delayMs": 2000],
          "POST /api/v0/channels/visual-chat/messages": ["delayMs": 2000],
        ]
      ])
    mark("short-send")
    app.buttons["send-button"].tap()
    try await Task.sleep(for: .milliseconds(400))
    XCTAssertFalse(app.staticTexts["Sending…"].exists)
    let queuedFrame = app.staticTexts["Motion check"].frame
    let previousMessageY = latestReply.frame.minY
    try await Task.sleep(for: .seconds(3))
    // Confirmed message actions expand the Text's accessibility hit rectangle.
    // Its center and the existing message above it must stay in place.
    let acceptedFrame = app.staticTexts["Motion check"].frame
    XCTAssertEqual(queuedFrame.midY, acceptedFrame.midY, accuracy: 1.5)
    XCTAssertEqual(queuedFrame.midX, acceptedFrame.midX, accuracy: 1.5)
    XCTAssertEqual(previousMessageY, latestReply.frame.minY, accuracy: 1.5)
    capture("short-send-accepted", app)
    input.tap()
    input.typeText("A longer message\nSecond line\nThird line\nFourth line")
    try await Task.sleep(for: .seconds(1))
    mark("multiline-send")
    app.buttons["send-button"].tap()
    try await Task.sleep(for: .seconds(2))
    mark("activity-start")
    try await control("__qa/motion", ["active": true])
    XCTAssertTrue(app.otherElements["bot-activity"].waitForExistence(timeout: 8))
    let recordVoice = app.buttons["Record voice note"]
    XCTAssertTrue(recordVoice.waitForExistence(timeout: 3))
    XCTAssertTrue(recordVoice.isEnabled, "Bot activity must not replace or disable voice input")
    XCTAssertFalse(app.buttons["Stop"].exists, "The composer must not gain a bot-stop control")
    try await Task.sleep(for: .seconds(2))
    capture("active-bot-keeps-voice-input", app)
    mark("activity-complete-with-reply")
    try await control("__qa/motion", ["active": false, "content": "Motion reply complete."])
    XCTAssertTrue(app.staticTexts["Motion reply complete."].waitForExistence(timeout: 8))
    try await Task.sleep(for: .seconds(2))
    capture("reply-and-activity-complete", app)
    mark("keyboard-close-after-send")
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
    try await Task.sleep(for: .seconds(1))
    mark("scroll-away")
    app.tables["chat-history"].swipeDown()
    let latest = app.buttons["Latest messages"]
    XCTAssertTrue(latest.waitForExistence(timeout: 5))
    mark("return-to-latest")
    latest.tap()
    XCTAssertTrue(latest.waitForNonExistence(timeout: 5))
    try await Task.sleep(for: .seconds(1))
    capture("returned-to-latest", app)
    let timing = XCTAttachment(
      data: try JSONSerialization.data(withJSONObject: marks, options: .prettyPrinted),
      uniformTypeIdentifier: "public.json")
    timing.name = "motion-timestamps"
    timing.lifetime = .keepAlways
    add(timing)
  }

  func testRecordingReference() async throws {
    continueAfterFailure = false
    try await control("__qa/scene", ["scene": "motion-reference"])
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--trace-chat-layout", "--server", base.absoluteString,
      "--appearance", "dark", "--open-channel", "visual-chat",
    ]
    app.launch()
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 15))
    let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    XCTAssertTrue(input.waitForExistence(timeout: 10))
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch.waitForNonExistence(timeout: 15))
    input.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    input.typeText("Okay testing")
    try await Task.sleep(for: .seconds(1))
    XCTAssertGreaterThanOrEqual(
      app.keyboards.firstMatch.frame.minY - app.buttons["attach-button"].frame.maxY, 12,
      "The focused composer must retain its spacing above the keyboard")
    let prompt = app.otherElements["message-visual-message-visual-chat-3"]
    let lookup = app.otherElements["message-visual-message-visual-chat-4"]
    let result = app.otherElements["message-visual-message-visual-chat-5"]
    XCTAssertTrue(prompt.exists && lookup.exists && result.exists)
    XCTAssertEqual(lookup.frame.minY - prompt.frame.maxY, 12, accuracy: 0.5)
    XCTAssertEqual(result.frame.minY - lookup.frame.maxY, 8, accuracy: 0.5)
    XCTAssertEqual(prompt.frame.height, 106, accuracy: 0.5)
    XCTAssertEqual(lookup.frame.height, 40, accuracy: 0.5)
    XCTAssertEqual(result.frame.height, 84, accuracy: 0.5)
    capture("reference-before-send", app)
    mark("reference-send")
    app.buttons["send-button"].tap()
    try await Task.sleep(for: .milliseconds(150))
    mark("reference-loader-start")
    try await control("__qa/motion", ["active": true])
    try await Task.sleep(for: .seconds(3))
    // Keep XCTest screenshot capture out of the reply animation interval.
    // Extract the loading still from simctl's recording after the run instead.
    mark("reference-reply")
    try await control("__qa/motion", ["active": true, "content": "Got it — ready when you are."])
    try await Task.sleep(for: .milliseconds(1350))
    mark("reference-loader-finish")
    try await control("__qa/motion", ["active": false])
    try await Task.sleep(for: .seconds(2))
    XCTAssertTrue(app.staticTexts["Got it — ready when you are."].exists)
    XCTAssertLessThanOrEqual(app.staticTexts["Got it — ready when you are."].frame.maxY,
      input.frame.minY - 12, "The final reply must stay above the composer after the loader collapses")
    capture("reference-finished", app)
    let history = app.coordinate(withNormalizedOffset: CGVector(dx: 0.65, dy: 0.23))
    history.press(
      forDuration: 0.02, thenDragTo: history.withOffset(CGVector(dx: 0, dy: 220)),
      withVelocity: .slow, thenHoldForDuration: 0)
    try await Task.sleep(for: .seconds(1))
    capture("reference-scrolled-glass", app)
    let timing = XCTAttachment(
      data: try JSONSerialization.data(withJSONObject: marks, options: .prettyPrinted),
      uniformTypeIdentifier: "public.json")
    timing.name = "reference-timestamps"
    timing.lifetime = .keepAlways
    add(timing)
  }

  func testComposerHitAreasInBothAppearances() async throws {
    continueAfterFailure = false
    for appearance in ["dark", "light"] {
      try await control("__qa/scene", ["scene": "motion-reference"])
      let app = XCUIApplication()
      app.launchArguments = [
        "--ui-testing", "--server", base.absoluteString,
        "--appearance", appearance, "--open-channel", "visual-chat",
      ]
      app.launch()
      let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
      XCTAssertTrue(input.waitForExistence(timeout: 15))
      XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch.waitForNonExistence(timeout: 15))
      XCTAssertTrue(input.isEnabled)
      input.tap()
      XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
      input.typeText("Okay testing")
      let send = app.buttons["send-button"]
      let attach = app.buttons["attach-button"]
      XCTAssertGreaterThanOrEqual(send.frame.width, 44)
      XCTAssertGreaterThanOrEqual(send.frame.height, 44)
      XCTAssertGreaterThanOrEqual(attach.frame.width, 44)
      XCTAssertGreaterThanOrEqual(attach.frame.height, 44)
      capture("composer-" + appearance, app)
      // Tap outside the smaller visual pill, but inside the promised hit target.
      send.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
      XCTAssertTrue(app.staticTexts["Okay testing"].waitForExistence(timeout: 5))
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
      capture("composer-" + appearance + "-keyboard-closed", app)
      app.terminate()
    }
  }
}
