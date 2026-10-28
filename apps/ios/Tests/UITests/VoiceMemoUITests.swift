import XCTest

/// Hold-to-record voice memos against the loopback parity fixture, which answers
/// /api/v0/transcriptions with "Native voice QA transcription". Audio comes from the
/// simulator-only synthetic microphone (`--qa-synthetic-voice`).
@MainActor final class VoiceMemoUITests: XCTestCase {
  let base = ProcessInfo.processInfo.environment["VOICE_MEMO_SERVER"] ?? "http://127.0.0.1:19992"
  let transcript = "Native voice QA transcription"

  private func fixture(_ path: String, _ body: [String: Any] = [:], method: String = "POST") async throws {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }
  private func state() async throws -> [String: Any] {
    let (data, _) = try await URLSession.shared.data(from: URL(string: base + "/__qa/state")!)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
  private func uploads() async throws -> Int {
    (try await state()["requests"] as? [[String: Any]] ?? []).filter {
      $0["method"] as? String == "POST" && $0["path"] as? String == "/api/v0/transcriptions"
    }.count
  }
  private func sentMessages(_ text: String) async throws -> [[String: Any]] {
    (try await state()["messages"] as? [[String: Any]] ?? []).filter {
      $0["sender"] as? String == "user" && $0["content"] as? String == text
    }
  }
  private func capture(_ name: String, _ app: XCUIApplication) {
    let image = XCTAttachment(screenshot: app.screenshot())
    image.name = "voice-memo-" + name
    image.lifetime = .keepAlways
    add(image)
  }

  private func launch(appearance: String = "dark", arguments: [String] = []) async throws -> XCUIApplication {
    continueAfterFailure = false
    try await fixture("/__qa/reset")
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", appearance,
      "--open-channel", "channel-research", "--qa-synthetic-voice", "--haptic-audit", "--qa-session", UUID().uuidString] + arguments
    app.launch()
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 20))
    let loading = app.descendants(matching: .any).matching(identifier: "chat-loading").firstMatch
    XCTAssertTrue(loading.waitForNonExistence(timeout: 20), "History never finished positioning")
    if !arguments.contains("--visual-draft-base64") {
      XCTAssertTrue(mic(app).waitForExistence(timeout: 10))
      XCTAssertTrue(mic(app).isEnabled)
    }
    // Snapshot resets intentionally preserve the audit log; each gesture test needs a fresh log.
    try await fixture("/__qa/haptics", method: "DELETE")
    return app
  }
  private func mic(_ app: XCUIApplication) -> XCUIElement { app.buttons["voice-record-button"] }
  private func center(of element: XCUIElement) -> XCUICoordinate {
    element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
  }
  /// Press the mic, hold, then slide by (dx, dy) points and hold before lifting.
  private func holdAndSlide(_ app: XCUIApplication, dx: CGFloat, dy: CGFloat, hold: TimeInterval = 1) {
    let start = center(of: mic(app))
    start.press(forDuration: hold, thenDragTo: start.withOffset(CGVector(dx: dx, dy: dy)),
      withVelocity: .slow, thenHoldForDuration: 0.3)
  }
  private func waitForMessage(_ app: XCUIApplication, _ text: String) async throws {
    XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 15), "\(text) never appeared in the chat")
    let deadline = Date().addingTimeInterval(10)
    while try await sentMessages(text).isEmpty, Date() < deadline { try await Task.sleep(for: .milliseconds(250)) }
    let sent = try await sentMessages(text).count
    XCTAssertEqual(sent, 1, "The transcript must be sent exactly once")
  }

  func testHoldAndReleaseTranscribesAndSends() async throws {
    let app = try await launch()
    // Hold the transcription long enough to observe the processing bar.
    try await fixture("/__qa/control", ["failures": ["POST /api/v0/transcriptions": ["delayMs": 2500]]])
    let start = center(of: mic(app))
    // XCUITest can't sample mid-press, so release first, then look at the transcribing bar.
    start.press(forDuration: 1.6)
    let cancel = app.buttons["Cancel transcription"]
    XCTAssertTrue(cancel.waitForExistence(timeout: 3), "Releasing must stop and transcribe")
    XCTAssertTrue(app.descendants(matching: .any)["Transcribing"].exists)
    capture("transcribing", app)
    try await waitForMessage(app, transcript)
    XCTAssertTrue(mic(app).waitForExistence(timeout: 5), "The composer returns after sending")
    let field = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    XCTAssertEqual((field.value as? String) ?? "", "", "The transcript is sent, not left in the draft")
    let count = try await uploads()
    XCTAssertEqual(count, 1)
  }

  func testTapAndShortHoldRecordHandsFree() async throws {
    let app = try await launch(appearance: "light")
    mic(app).tap()
    let send = app.buttons["Send voice note"]
    XCTAssertTrue(send.waitForExistence(timeout: 3), "A tap starts a hands-free recording")
    XCTAssertTrue(app.buttons["Discard recording"].exists)
    let bars = app.descendants(matching: .any).matching(identifier: "voice-memo-bar")
    XCTAssertEqual(bars.count, 1, "Recording must have one expanded message bar")
    XCTAssertEqual(bars.firstMatch.frame.height, 64, accuracy: 1)
    XCTAssertEqual(send.frame.midY, app.buttons["Discard recording"].frame.midY, accuracy: 1,
      "Morphed actions must stay centred in the expanded bar")
    XCTAssertEqual(app.descendants(matching: .any)["voice-clock"].label, "Recording voice note")
    capture("tap-locked", app)
    app.buttons["Discard recording"].tap()
    XCTAssertTrue(mic(app).waitForExistence(timeout: 5))
    // Past the 180 ms hold delay but under the 500 ms minimum: also hands-free, not sent.
    center(of: mic(app)).press(forDuration: 0.4)
    XCTAssertTrue(send.waitForExistence(timeout: 3))
    try await Task.sleep(for: .seconds(1.2))
    var count = try await uploads()
    XCTAssertEqual(count, 0, "Nothing is sent until Send is tapped")
    send.tap()
    try await waitForMessage(app, transcript)
    count = try await uploads()
    XCTAssertEqual(count, 1)
  }

  func testSlideLeftCancelsAndKeepsNothing() async throws {
    let app = try await launch()
    holdAndSlide(app, dx: -170, dy: 0)
    XCTAssertTrue(mic(app).waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["Send voice note"].exists)
    try await Task.sleep(for: .seconds(1.5))
    let count = try await uploads()
    XCTAssertEqual(count, 0, "A cancelled recording is never uploaded")
    let sent = try await sentMessages(transcript)
    XCTAssertTrue(sent.isEmpty)
    let (data, _) = try await URLSession.shared.data(from: URL(string: base + "/__qa/haptics")!)
    let events = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
    let resistance = events.filter { $0["source"] as? String == "composer.voice-cancel-detent" }
    XCTAssertFalse(resistance.isEmpty)
    XCTAssertTrue(resistance.allSatisfy {
      $0["effect"] as? String == "soft" && $0["emitted"] as? Bool == true
        && (0.12...0.53).contains($0["intensity"] as? Double ?? 0)
    })
    let armed = events.filter { $0["source"] as? String == "composer.voice-cancel-arm" }
    XCTAssertEqual(armed.count, 1)
    XCTAssertEqual(armed.first?["effect"] as? String, "soft")
  }

  func testSmallLeftDriftStaysInsideCancellationDeadZone() async throws {
    let app = try await launch()
    holdAndSlide(app, dx: -12, dy: 0)
    try await waitForMessage(app, transcript)
    let (data, _) = try await URLSession.shared.data(from: URL(string: base + "/__qa/haptics")!)
    let events = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
    XCTAssertFalse(events.contains {
      ($0["source"] as? String ?? "").hasPrefix("composer.voice-cancel-")
    }, "Finger drift must not add cancellation feedback")
  }

  func testSlideUpLocksThenSendOrTrash() async throws {
    let app = try await launch()
    holdAndSlide(app, dx: 0, dy: -120)
    let send = app.buttons["Send voice note"]
    XCTAssertTrue(send.waitForExistence(timeout: 3), "Sliding up locks the recording")
    XCTAssertTrue(app.buttons["Discard recording"].waitForExistence(timeout: 3))
    let clock = app.descendants(matching: .any)["voice-clock"]
    XCTAssertEqual(clock.label, "Recording voice note")
    // Lifting the finger after the lock keeps recording.
    let recording = expectation(for: NSPredicate { _, _ in
      Int((clock.value as? String ?? "").split(separator: " ").first ?? "") ?? 0 >= 2
    }, evaluatedWith: clock)
    await fulfillment(of: [recording], timeout: 8)
    // Locking emits the dedicated double click once; releasing after the lock adds no cue.
    let (data, _) = try await URLSession.shared.data(from: URL(string: base + "/__qa/haptics")!)
    let events = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
    let lockEvents = events.filter { $0["source"] as? String == "composer.voice-lock" }
    XCTAssertEqual(lockEvents.count, 2)
    XCTAssertTrue(lockEvents.allSatisfy {
      $0["effect"] as? String == "rigid" && $0["emitted"] as? Bool == true
    })
    capture("locked", app)
    send.tap()
    try await waitForMessage(app, transcript)

    holdAndSlide(app, dx: 0, dy: -120)
    XCTAssertTrue(app.buttons["Discard recording"].waitForExistence(timeout: 3))
    app.buttons["Discard recording"].tap()
    XCTAssertTrue(mic(app).waitForExistence(timeout: 5))
    try await Task.sleep(for: .seconds(1))
    let count = try await uploads()
    XCTAssertEqual(count, 1, "Only the sent recording was uploaded")
  }

  func testDraftMenuRecordsHandsFreeAndSendsDraftWithTranscript() async throws {
    let app = try await launch()
    let field = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    field.tap()
    field.typeText("Draft intro.")
    XCTAssertTrue(mic(app).waitForNonExistence(timeout: 3), "Send replaces the mic while drafting")
    app.buttons["attach-button"].tap()
    XCTAssertTrue(app.buttons["Record voice note"].waitForExistence(timeout: 5))
    app.buttons["Record voice note"].tap()
    XCTAssertTrue(app.buttons["Discard recording"].waitForExistence(timeout: 5))
    // Trash restores the draft untouched.
    app.buttons["Discard recording"].tap()
    XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 5))
    XCTAssertEqual(field.value as? String, "Draft intro.")
    app.buttons["attach-button"].tap()
    XCTAssertTrue(app.buttons["Record voice note"].waitForExistence(timeout: 5))
    app.buttons["Record voice note"].tap()
    XCTAssertTrue(app.buttons["Send voice note"].waitForExistence(timeout: 5))
    try await Task.sleep(for: .seconds(1.2))
    app.buttons["Send voice note"].tap()
    try await waitForMessage(app, "Draft intro. " + transcript)
  }

  func testReducedMotionRecordingSendsAndRestoresComposer() async throws {
    let app = try await launch(appearance: "light", arguments: ["--qa-reduce-motion"])
    mic(app).tap()
    XCTAssertTrue(app.buttons["Send voice note"].waitForExistence(timeout: 5))
    let bars = app.descendants(matching: .any).matching(identifier: "voice-memo-bar")
    XCTAssertEqual(bars.count, 1)
    XCTAssertEqual(bars.firstMatch.frame.height, 64, accuracy: 1)
    app.buttons["Send voice note"].tap()
    try await waitForMessage(app, transcript)
    XCTAssertTrue(mic(app).waitForExistence(timeout: 5))
  }

  func testMultilineDraftSurvivesRecordingAndDiscard() async throws {
    let value = "Keep the first line.\nAnd the second line.\nAnd the third line."
    // Seed the existing draft so this tests recording/discard independently of
    // XCTest's multiline keyboard injection and keyboard reconfiguration.
    let app = try await launch(appearance: "light",
      arguments: ["--visual-draft-base64", Data(value.utf8).base64EncodedString()])
    let field = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    XCTAssertEqual(field.value as? String, value)
    field.tap()
    app.buttons["attach-button"].tap()
    XCTAssertTrue(app.buttons["Record voice note"].waitForExistence(timeout: 5))
    app.buttons["Record voice note"].tap()
    XCTAssertTrue(app.buttons["Discard recording"].waitForExistence(timeout: 5))
    let bars = app.descendants(matching: .any).matching(identifier: "voice-memo-bar")
    XCTAssertEqual(bars.count, 1)
    XCTAssertEqual(bars.firstMatch.frame.height, 64, accuracy: 1)
    app.buttons["Discard recording"].tap()
    XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 5))
    XCTAssertEqual(field.value as? String, value, "The complete multiline draft must survive")
    XCTAssertTrue(field.isHittable, "The restored draft must be visible and usable")
    let count = try await uploads()
    XCTAssertEqual(count, 0)
  }

  func testFailedTranscriptionKeepsTheRecordingForRetry() async throws {
    let app = try await launch()
    try await fixture("/__qa/control", ["failures": ["POST /api/v0/transcriptions": ["status": 503, "count": 1]]])
    center(of: mic(app)).press(forDuration: 1.5)
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 10))
    app.alerts.buttons["OK"].tap()
    let clock = app.descendants(matching: .any)["voice-clock"]
    XCTAssertTrue(clock.waitForExistence(timeout: 3))
    XCTAssertEqual(clock.label, "Voice note ready")
    capture("review-after-failure", app)
    app.buttons["Send voice note"].tap()
    try await waitForMessage(app, transcript)
    // The fixture logs only the uploads it accepts: the injected 503 is not counted.
    let count = try await uploads()
    XCTAssertEqual(count, 1, "Retry uploads the kept recording")
  }
}
