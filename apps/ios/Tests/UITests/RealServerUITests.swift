import XCTest

/// Optional: real-server-qa.ts runs current production services and real inference.
/// The app connects directly to the authenticated server; control only arranges
/// disposable data and inspects persisted records through a separate connection.
@MainActor final class RealServerUITests: XCTestCase {
  private let control = "http://127.0.0.1:20022"
  private var channel = ""
  private var botID = ""
  private var conversation = ""

  private func request(_ path: String, _ body: [String: Any]? = nil, method: String? = nil)
    async throws -> [String: Any]
  {
    var request = URLRequest(url: URL(string: control + path)!)
    request.timeoutInterval = 60
    request.httpMethod = method ?? (body == nil ? "GET" : "POST")
    if let body {
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    XCTAssertTrue((200..<300).contains(status), "\(path): HTTP \(status)")
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
  private func capture(_ name: String, _ app: XCUIApplication) {
    let image = XCTAttachment(screenshot: app.screenshot())
    image.name = "real-server-" + name
    image.lifetime = .keepAlways
    add(image)
    let tree = XCTAttachment(string: app.debugDescription)
    tree.name = "real-server-" + name + "-accessibility"
    tree.lifetime = .keepAlways
    add(tree)
  }
  private func login(
    _ app: XCUIApplication, server: String? = nil, notifications: Bool = false,
    openChat: Bool = true, voiceSource: String? = nil
  ) async throws {
    addUIInterruptionMonitor(withDescription: "Password autofill") { alert in
      guard alert.buttons["Not Now"].exists else { return false }
      alert.buttons["Not Now"].tap()
      return true
    }
    let config = try await request("/config")
    app.launchArguments = [
      "--ui-testing", "--server", try server ?? XCTUnwrap(config["base"] as? String),
      "--appearance", "light",
    ]
    if let voiceSource {
      app.launchArguments += ["--qa-synthetic-voice"]
      app.launchEnvironment["OPENTEAM_QA_VOICE_SOURCE"] = control + voiceSource
    }
    if notifications {
      app.launchArguments += [
        "--qa-native-push", "--qa-push-reset", "--qa-push-token",
        String(repeating: "cd", count: 32),
      ]
    }
    app.launch()
    let username = app.textFields["username-field"]
    XCTAssertTrue(username.waitForExistence(timeout: 20))
    username.tap()
    username.typeText(try XCTUnwrap(config["username"] as? String))
    let password = app.secureTextFields["password-field"]
    password.tap()
    password.typeText(try XCTUnwrap(config["password"] as? String))
    app.buttons["sign-in-button"].tap()
    if notifications {
      let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow"]
      if allow.waitForExistence(timeout: 3) { allow.tap() }
    }
    XCTAssertTrue(app.buttons["channel-" + channel].waitForExistence(timeout: 25))
    let prompt = app.buttons["Not Now"]
    for _ in 0..<3 {
      guard prompt.waitForExistence(timeout: 2) else { break }
      prompt.tap()
      if prompt.waitForNonExistence(timeout: 3) { break }
    }
    XCTAssertFalse(prompt.exists, "iOS password prompt did not dismiss")
    guard openChat else { return }
    app.buttons["channel-" + channel].tap()
    XCTAssertTrue(
      app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
        .waitForExistence(timeout: 15))
  }
  private func createBot(_ name: String) async throws {
    let bot = try await request(
      "/api/v0/bots",
      [
        "clientRequestId": UUID().uuidString, "name": name,
        "instructions":
          "You are a disposable native app QA bot. On first start, send a short ready greeting. Respond to each user message using SendToUser. Follow requests for exact reply text. For other messages acknowledge briefly. Do not use any other tools, read files, browse, or contact anyone.",
      ])
    channel = try XCTUnwrap(bot["dmChannelId"] as? String)
    botID = try XCTUnwrap(bot["id"] as? String)
    conversation = try XCTUnwrap(bot["conversationId"] as? String)
  }
  private func messages() async throws -> [[String: Any]] {
    (try await request("/state")["messages"] as? [[String: Any]] ?? []).filter {
      $0["channelId"] as? String == channel
    }
  }
  private func saved(_ text: String, sender: String? = nil, timeout: TimeInterval = 100)
    async throws -> [String: Any]
  {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      if let message = try await messages().first(where: {
        (text.isEmpty || ($0["content"] as? String ?? "").contains(text))
          && (sender == nil || $0["sender"] as? String == sender)
      }) {
        return message
      }
      try await Task.sleep(for: .seconds(1))
    } while Date() < deadline
    let state = try await request("/state")
    let evidence = XCTAttachment(string: String(describing: state))
    evidence.name = "live-server-timeout-state"
    evidence.lifetime = .keepAlways
    add(evidence)
    XCTFail("No persisted \(sender ?? "") message containing \(text)")
    throw NSError(domain: "LiveQA", code: 1)
  }
  private func row(_ id: String, _ app: XCUIApplication) -> XCUIElement {
    let row = app.otherElements["message-" + id].firstMatch
    reveal(row, app)
    return row
  }
  private func reveal(_ row: XCUIElement, _ app: XCUIApplication) {
    let replying = app.buttons["thread-back"].exists
    let header = app.buttons[replying ? "thread-back" : "conversation-details"]
    let input = app.descendants(matching: .any).matching(
      identifier: replying ? "thread-message-input" : "message-input").firstMatch
    XCTAssertTrue(header.waitForExistence(timeout: 5))
    XCTAssertTrue(input.waitForExistence(timeout: 5))
    for _ in 0..<24 {
      let top = header.frame.maxY + 20
      let bottom = input.frame.minY - 20
      // Lazy history intentionally omits offscreen rows from accessibility.
      // These targets are earlier messages, so reveal them before reading their frame.
      let start = app.coordinate(withNormalizedOffset: .zero)
        .withOffset(CGVector(dx: app.frame.width * 0.8, dy: (top + bottom) / 2))
      guard row.exists else {
        start.press(forDuration: 0.05,
          thenDragTo: start.withOffset(CGVector(dx: 0, dy: min(180, (bottom - top) / 2))))
        continue
      }
      let frame = row.frame
      // Hosted message containers are not activation controls. After a cell
      // reconfiguration XCTest may reject isHittable despite a valid visible
      // frame; the actual hold/swipe and resulting UI verify interaction below.
      if frame.width > 0 && frame.height > 0 && frame.midY > top && frame.midY < bottom { return }
      start.press(
        forDuration: 0.05,
        thenDragTo: start.withOffset(CGVector(dx: 0, dy: frame.midY < top ? 180 : -180)))
    }
    XCTAssertTrue(row.exists)
    XCTAssertGreaterThan(row.frame.height, 0)
    XCTAssertGreaterThan(row.frame.midY, header.frame.maxY)
    XCTAssertLessThan(row.frame.midY, input.frame.minY)
  }
  private func send(_ text: String, _ app: XCUIApplication) {
    let replying = app.buttons["thread-back"].isHittable
    let input = app.descendants(matching: .any).matching(identifier: replying ? "thread-message-input" : "message-input").firstMatch
    input.tap()
    input.typeText(text)
    app.buttons[replying ? "thread-send-button" : "send-button"].tap()
  }
  private func requireVoiceSource(_ path: String) async throws {
    let (_, response) = try await URLSession.shared.data(from: URL(string: control + path)!)
    try XCTSkipUnless((response as? HTTPURLResponse)?.statusCode == 200,
      "Set SWIFT_REAL_QA_TRANSCRIPTION_CONTAINER and speech WAV paths for real ASR verification")
  }
  private func recordVoice(_ app: XCUIApplication, seconds: Int = 5, hasDraft: Bool = false)
    async throws
  {
    if hasDraft {
      app.buttons["attach-button"].tap()
      XCTAssertTrue(app.buttons["Record voice note"].waitForExistence(timeout: 5))
      capture("voice-draft-entry", app)
    }
    app.buttons["Record voice note"].tap()
    XCTAssertTrue(app.buttons["Stop recording"].waitForExistence(timeout: 10))
    let recording = app.descendants(matching: .any).matching(identifier: "Recording voice note")
      .firstMatch
    let elapsed = expectation(for: NSPredicate { _, _ in
      let value = recording.value as? String ?? ""
      return (Int(value.split(separator: " ").first ?? "") ?? 0) >= seconds
    }, evaluatedWith: recording)
    await fulfillment(of: [elapsed], timeout: TimeInterval(seconds + 8))
    app.buttons["Stop recording"].tap()
    XCTAssertTrue(app.buttons["Discard recording"].waitForExistence(timeout: 5))
  }
  private func assertSpeech(_ value: String, file: StaticString = #filePath, line: UInt = #line) {
    let words = value.lowercased().split { !$0.isLetter && !$0.isNumber }
      .map { $0 == "9" ? "nine" : String($0) }.joined(separator: " ")
    XCTAssertTrue(words.contains("please remind me to bring the blue notebook to our meeting tomorrow at nine"),
      "Actual ASR output: \(value)", file: file, line: line)
  }

  /// Real AAC upload, authenticated production route, configured ASR provider,
  /// composer insertion, and durable send. Only microphone samples are injected.
  func testLiveVoiceTranscriptionAndDraftPreservation() async throws {
    continueAfterFailure = false
    try await requireVoiceSource("/voice.wav")
    try await createBot("Live speech transcription QA")
    let app = XCUIApplication()
    try await login(app, voiceSource: "/voice.wav")
    try await recordVoice(app)
    let started = Date()
    app.buttons["Transcribe voice note"].tap()
    let field = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 130))
    let transcript = try XCTUnwrap(field.value as? String)
    assertSpeech(transcript)
    let evidence = XCTAttachment(string: "Live ASR took \(Date().timeIntervalSince(started)) seconds.\nTranscript: \(transcript)")
    evidence.name = "real-speech-transcript"
    evidence.lifetime = .keepAlways
    add(evidence)
    capture("voice-transcribed", app)
    let beforeSend = try await messages()
    XCTAssertFalse(beforeSend.contains { $0["sender"] as? String == "user" },
      "Transcription must remain a draft until Send is pressed")
    app.buttons["send-button"].tap()
    _ = try await saved(transcript, sender: "user", timeout: 20)

    let prefix = "Draft introduction. "
    field.tap()
    field.typeText(prefix)
    try await recordVoice(app, hasDraft: true)
    app.buttons["Discard recording"].tap()
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    XCTAssertEqual(field.value as? String, prefix)
    try await recordVoice(app, hasDraft: true)
    app.buttons["Transcribe voice note"].tap()
    XCTAssertTrue(field.waitForExistence(timeout: 130))
    let combined = try XCTUnwrap(field.value as? String)
    XCTAssertTrue(combined.hasPrefix(prefix), "Voice insertion must preserve the typed draft")
    assertSpeech(combined)
    capture("voice-existing-draft", app)
  }

  func testLiveSilentRecordingCanRetryAndDiscard() async throws {
    continueAfterFailure = false
    try await requireVoiceSource("/silence.wav")
    try await createBot("Live silence transcription QA")
    let app = XCUIApplication()
    try await login(app, voiceSource: "/silence.wav")
    try await recordVoice(app, seconds: 3)
    for attempt in 1...2 {
      app.buttons["Transcribe voice note"].tap()
      XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 130))
      XCTAssertTrue(app.alerts.staticTexts.containing(
        NSPredicate(format: "label CONTAINS[c] %@", "No speech")).firstMatch.exists)
      capture("silence-retry-\(attempt)", app)
      app.alerts.buttons["OK"].tap()
      XCTAssertTrue(app.buttons["Discard recording"].exists)
    }
    app.buttons["Discard recording"].tap()
    let field = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.tap()
    field.typeText("Typing after a silent recording still works.")
    XCTAssertTrue(app.buttons["send-button"].isEnabled)
    capture("silence-discard-restores-composer", app)
  }
  private func verifyReply(_ text: String, parent: String, _ app: XCUIApplication) async throws
    -> String
  {
    let message = try await saved(text, sender: "user")
    let metadata = try XCTUnwrap(message["metadata"] as? [String: Any])
    XCTAssertEqual(metadata["replyTo"] as? String, parent)
    XCTAssertEqual(metadata["branched"] as? Bool, true)
    let matching = try await messages().filter { $0["content"] as? String == text }
    XCTAssertEqual(matching.count, 1, "Inline reply must be durably accepted once")
    let id = try XCTUnwrap(message["id"] as? String)
    if app.buttons["thread-back"].isHittable { app.buttons["thread-back"].tap() }
    XCTAssertTrue(app.buttons["reply-quote-" + id].waitForExistence(timeout: 15))
    return id
  }

  func testLiveLoginDeliveryHoldAndSwipeRepliesPersist() async throws {
    continueAfterFailure = false
    executionTimeAllowance = 360
    let nonce = String(UUID().uuidString.prefix(8))
    try await createBot("Native live replies " + nonce)
    let app = XCUIApplication()
    try await login(app)
    let expected = "LIVE-REPLY-" + nonce
    send("For this live delivery check, reply with exactly " + expected, app)
    let original = try await saved(expected, sender: "agent")
    let originalID = try XCTUnwrap(original["id"] as? String)
    XCTAssertEqual((original["metadata"] as? [String: Any])?["type"] as? String, "text")
    let ready = try await request("/api/v0/notification-state")
    XCTAssertNotNil(
      ready["readStates"], "Current live server must expose notification reconciliation")
    row(originalID, app).press(forDuration: 0.8)
    XCTAssertTrue(app.buttons["Reply"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Start a thread"].exists)
    XCTAssertTrue(app.buttons["Copy"].exists)
    capture("held-message-actions", app)
    app.buttons["Reply"].tap()
    XCTAssertTrue(app.buttons["thread-back"].waitForExistence(timeout: 5))
    let held = "Held inline reply " + nonce
    send(held, app)
    let heldID = try await verifyReply(held, parent: originalID, app)
    capture("held-inline-reply-saved", app)
    let source = row(originalID, app).coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
    source.press(
      forDuration: 0.05, thenDragTo: source.withOffset(CGVector(dx: 145, dy: 0)),
      withVelocity: .slow, thenHoldForDuration: 0.1)
    XCTAssertTrue(app.buttons["thread-back"].waitForExistence(timeout: 5))
    let swiped = "Swipe inline reply " + nonce
    send(swiped, app)
    let swipeID = try await verifyReply(swiped, parent: originalID, app)
    capture("swipe-inline-reply-saved", app)
    app.terminate()
    try await login(app)
    XCTAssertTrue(app.buttons["reply-quote-" + swipeID].waitForExistence(timeout: 15))
    app.buttons["reply-quote-" + swipeID].tap()
    XCTAssertTrue(row(heldID, app).waitForExistence(timeout: 15))
    XCTAssertTrue(row(swipeID, app).exists)
    capture("replies-survive-relaunch", app)
    let persisted = XCTAttachment(string: String(describing: try await messages()))
    persisted.name = "real-server-persisted-replies"
    persisted.lifetime = .keepAlways
    add(persisted)
  }

  func testRichMessagesHoldSwipeCancelAndVerticalScrolling() async throws {
    continueAfterFailure = false
    executionTimeAllowance = 300
    let nonce = String(UUID().uuidString.prefix(8))
    try await createBot("Native rich gestures " + nonce)
    // Ensure there is older history to scroll toward. A short conversation
    // correctly springs back to the same position, and an upward drag at the
    // newest-message boundary cannot demonstrate scrolling.
    _ = try await request(
      "/api/v0/conversations/" + conversation + "/messages",
      [
        "clientId": UUID().uuidString,
        "content": (1...24).map { "Earlier QA history line \($0)" }.joined(separator: "\n"),
      ])
    let text =
      "# Rich message " + nonce
      + "\n\n- Native message actions\n- Swipe replies\n\n**Formatting stays interactive.**"
    _ = try await request(
      "/api/v0/conversations/" + conversation + "/messages",
      ["clientId": UUID().uuidString, "content": text])
    let original = try await saved("# Rich message " + nonce, sender: "user")
    let originalID = try XCTUnwrap(original["id"] as? String)
    let app = XCUIApplication()
    try await login(app)
    let message = row(originalID, app)
    XCTAssertTrue(message.webViews.firstMatch.waitForExistence(timeout: 10))
    message.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)).press(forDuration: 0.8)
    XCTAssertTrue(app.buttons["Reply"].waitForExistence(timeout: 5))
    capture("rich-message-actions", app)
    app.buttons["Reply"].tap()
    XCTAssertTrue(app.buttons["thread-back"].waitForExistence(timeout: 5))
    app.buttons["thread-back"].tap()
    XCTAssertFalse(app.buttons["thread-back"].exists)
    let source = row(originalID, app).coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
    source.press(
      forDuration: 0.05, thenDragTo: source.withOffset(CGVector(dx: 145, dy: 0)),
      withVelocity: .slow, thenHoldForDuration: 0.1)
    XCTAssertTrue(app.buttons["thread-back"].waitForExistence(timeout: 5))
    let reply = "Rich swipe reply " + nonce
    send(reply, app)
    _ = try await verifyReply(reply, parent: originalID, app)
    // A short, reversed or vertical gesture must never prime a reply.
    for movement in [
      CGVector(dx: 35, dy: 0), CGVector(dx: -100, dy: 0), CGVector(dx: 15, dy: 150),
    ] {
      let target = row(originalID, app)
      let previousY = target.frame.minY
      let start = target.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
      start.press(
        forDuration: 0.05, thenDragTo: start.withOffset(movement), withVelocity: .slow,
        thenHoldForDuration: 0)
      XCTAssertFalse(app.buttons["thread-back"].exists)
      if movement.dy != 0 {
        XCTAssertGreaterThan(
          abs(target.frame.minY - previousY), 20,
          "Vertical scrolling must actually move the history")
      }
    }
    capture("rich-swipe-saved-no-accidental-reply", app)
  }

  func testLiveAttachmentTapHoldReactionAndSwipeReply() async throws {
    continueAfterFailure = false
    executionTimeAllowance = 300
    let nonce = String(UUID().uuidString.prefix(8))
    try await createBot("Native attachment gestures " + nonce)
    let fileName = "Gesture QA image.png"
    let asset = try await request(
      "/api/v0/assets",
      [
        "fileName": fileName, "mimeType": "image/png",
        "bytesBase64":
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      ])
    let sent = try await request(
      "/api/v0/conversations/" + conversation + "/messages",
      [
        "clientId": UUID().uuidString, "content": "Attachment QA " + nonce, "attachments": [asset],
      ])
    _ = sent
    let original = try await saved("Attachment QA " + nonce, sender: "user")
    let originalID = try XCTUnwrap(original["id"] as? String)
    let app = XCUIApplication()
    try await login(app)
    _ = row(originalID, app)
    let image = app.buttons["attachment-" + (asset["assetId"] as? String ?? "")]
    XCTAssertTrue(image.waitForExistence(timeout: 15))
    image.tap()
    XCTAssertTrue(
      app.buttons["photo-close"].waitForExistence(timeout: 10), "A quick tap must still open the photo")
    capture("attachment-native-preview", app)
    app.buttons["photo-close"].tap()
    image.press(forDuration: 0.8)
    XCTAssertTrue(app.buttons["Reply"].waitForExistence(timeout: 5))
    app.buttons["👍"].tap()
    var reacted = false
    for _ in 0..<15 {
      let updated = try await saved("Attachment QA " + nonce, sender: "user")
      let reactions =
        (updated["metadata"] as? [String: Any])?["reactions"] as? [[String: Any]] ?? []
      if reactions.contains(where: { $0["emoji"] as? String == "👍" }) {
        reacted = true
        break
      }
      try await Task.sleep(for: .seconds(1))
    }
    XCTAssertTrue(reacted, "Hold-menu reaction must persist on the live server")
    image.press(forDuration: 0.8)
    XCTAssertTrue(app.buttons["Reply"].waitForExistence(timeout: 5))
    app.buttons["Reply"].tap()
    let held = "Held attachment reply " + nonce
    send(held, app)
    _ = try await verifyReply(held, parent: originalID, app)
    _ = row(originalID, app)
    reveal(image, app)
    let start = image.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.5))
    start.press(
      forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 145, dy: 0)),
      withVelocity: .slow, thenHoldForDuration: 0)
    XCTAssertTrue(app.buttons["thread-back"].waitForExistence(timeout: 5))
    let swiped = "Swiped attachment reply " + nonce
    send(swiped, app)
    _ = try await verifyReply(swiped, parent: originalID, app)
    capture("attachment-replies-persisted", app)
  }

  func testLiveDesktopReadEventsClearDeliveredNotificationsSelectively() async throws {
    continueAfterFailure = false
    executionTimeAllowance = 300
    let proxy = "http://127.0.0.1:20023"
    func push(_ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
      var request = URLRequest(url: URL(string: proxy + path)!)
      if let body {
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      }
      let (data, response) = try await URLSession.shared.data(for: request)
      XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
      return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    func observe(_ ids: Set<String>, after count: Int) async throws {
      for _ in 0..<60 {
        let state = try await push("/__push/state")
        let observations = state["observations"] as? [[String: Any]] ?? []
        if observations.count > count, let last = observations.last,
          Set(last["delivered"] as? [String] ?? []) == ids
        {
          return
        }
        try await Task.sleep(for: .milliseconds(300))
      }
      let evidence = XCTAttachment(string: String(describing: try await push("/__push/state")))
      evidence.name = "live-read-sync-failure"
      evidence.lifetime = .keepAlways
      add(evidence)
      XCTFail("Notification Center did not reconcile to \(ids)")
    }
    _ = try await push("/__push/reset", [:])
    var targets: [[String: Any]] = []
    for index in 1...2 {
      try await createBot("Live push read QA \(index) " + String(UUID().uuidString.prefix(8)))
      let message = try await saved("", sender: "agent")
      targets.append([
        "qaID": "live-chat-\(index)", "channelId": channel, "botId": botID,
        "messageId": try XCTUnwrap(message["id"] as? String),
        "messageSequence": try XCTUnwrap(message["sequence"] as? String),
      ])
    }
    let bootstrap = try await request("/api/v0/client-bootstrap")
    for index in targets.indices {
      let value = (bootstrap["channels"] as? [[String: Any]])?.first {
        $0["id"] as? String == targets[index]["channelId"] as? String
      }
      targets[index]["notificationSequence"] = try XCTUnwrap(
        (value?["notificationState"] as? [String: Any])?["notificationCursor"] as? String)
    }
    let app = XCUIApplication()
    try await login(app, server: proxy, notifications: true, openChat: false)
    var registration: [String: Any]?
    for _ in 0..<40 {
      registration = try await push("/__push/state")["registration"] as? [String: Any]
      if registration != nil { break }
      try await Task.sleep(for: .milliseconds(250))
    }
    let installed = try XCTUnwrap(registration)
    XCTAssertEqual(
      installed["status"] as? Int, 201, "Native registration must be accepted by the live server")
    XCUIDevice.shared.press(.home)
    for target in targets { _ = try await push("/__push/deliver", target) }
    app.activate()
    try await observe(["live-chat-1", "live-chat-2"], after: 0)
    capture("live-notifications-delivered", app)
    for (index, target) in targets.enumerated() {
      let before = (try await push("/__push/state")["observations"] as? [Any])?.count ?? 0
      // This is the same public read API used by the desktop. Keep iOS on the
      // home screen: the live event stream must drive cleanup without a relaunch.
      _ = try await request(
        "/api/v0/channels/" + (target["channelId"] as! String) + "/read",
        [
          "throughSequence": target["messageSequence"]!,
          "throughNotificationSequence": target["notificationSequence"]!,
        ])
      try await observe(index == 0 ? ["live-chat-2"] : [], after: before)
    }
    let evidence = XCTAttachment(string: String(describing: try await push("/__push/state")))
    evidence.name = "live-server-notification-center-read-sync"
    evidence.lifetime = .keepAlways
    add(evidence)
    let final = try await push("/__push/state")
    let badge = (final["observations"] as? [[String: Any]])?.last?["badge"] as? Int
    let snapshot = try await request("/api/v0/notification-state")
    XCTAssertEqual(badge, snapshot["badgeCount"] as? Int)
    _ = try await request(
      "/api/v0/notification-devices/" + (installed["installationId"] as! String), method: "DELETE")
    app.terminate()
  }
}
