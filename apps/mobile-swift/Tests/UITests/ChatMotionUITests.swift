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
  func testComposerFocusAtTextAndPaddingInBothAppearances() async throws {
    continueAfterFailure = false
    for appearance in ["dark", "light"] {
      for attempt in 0..<3 {
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
      "--ui-testing", "--server", base.absoluteString,
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
