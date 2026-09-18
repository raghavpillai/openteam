import XCTest

@MainActor final class AttachmentReferenceUITests: XCTestCase {
  let base = "http://127.0.0.1:20039"
  func id(_ number: Int) -> String { String(repeating: String(number), count: 64) }
  @discardableResult func request(_ path: String, _ body: [String: Any]? = nil) async throws
    -> [String: Any]
  {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = body == nil ? "GET" : "POST"
    if let body {
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
  func launch(scene: String, theme: String = "dark") async throws -> XCUIApplication {
    continueAfterFailure = false
    try await request("/__qa/reset", [:])
    try await request("/__qa/content", ["scene": scene])
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--server", base, "--appearance", theme, "--open-channel", "channel-research",
    ]
    app.launch()
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 15))
    return app
  }
  func capture(_ name: String, _ app: XCUIApplication) {
    Thread.sleep(forTimeInterval: 0.8)
    let image = XCTAttachment(screenshot: app.screenshot())
    image.name = "attachment-" + name
    image.lifetime = .keepAlways
    add(image)
    let tree = XCTAttachment(string: app.debugDescription)
    tree.name = "attachment-tree-" + name
    tree.lifetime = .keepAlways
    add(tree)
  }
  func openPhoto(_ app: XCUIApplication, _ number: Int = 6) {
    let photo = app.buttons["attachment-" + id(number)]
    XCTAssertTrue(photo.waitForExistence(timeout: 10))
    photo.tap()
    XCTAssertTrue(app.buttons["photo-options"].waitForExistence(timeout: 8))
  }
  func testFileCardsPreviewAndNativeShareInBothThemes() async throws {
    for theme in ["dark", "light"] {
      let app = try await launch(scene: "media-files", theme: theme)
      let file = app.buttons["attachment-" + id(9)]
      XCTAssertTrue(file.waitForExistence(timeout: 10))
      capture("files-" + theme, app)
      file.tap()
      let previewShown = app.buttons["file-preview-close"].waitForExistence(timeout: 10)
      capture("opened-file-" + theme, app)
      XCTAssertTrue(previewShown)
      XCTAssertTrue(
        app.staticTexts["This file type can't be previewed here.\nShare it to open elsewhere."]
          .exists)
      XCTAssertTrue(app.staticTexts["memory-deep-supplement-914.zip"].exists)
      capture("zip-preview-" + theme, app)
      app.buttons["file-preview-share"].tap()
      XCTAssertTrue(app.otherElements["ActivityListView"].waitForExistence(timeout: 8))
      capture("zip-share-" + theme, app)
      app.terminate()
    }
  }
  func testGalleryMenuPagingZoomAndForwardPreserveDraft() async throws {
    let app = try await launch(scene: "media")
    capture("inline-images", app)
    let field = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
    field.tap()
    field.typeText("Keep this draft")
    openPhoto(app)
    app.buttons["photo-thumbnail-" + id(5)].tap()
    XCTAssertTrue(
      app.staticTexts["Omnibox after handoff with _HANDOFF_TEST appended"].waitForExistence(
        timeout: 5))
    XCTAssertFalse(app.keyboards.firstMatch.exists)
    capture("viewer", app)
    app.buttons["photo-options"].tap()
    for title in ["Forward", "Share", "Save"] {
      XCTAssertTrue(app.buttons[title].waitForExistence(timeout: 5))
    }
    capture("viewer-menu", app)
    app.buttons["Forward"].tap()
    XCTAssertTrue(app.buttons["forward-to-channel-research"].waitForExistence(timeout: 5))
    app.buttons["forward-to-channel-research"].tap()
    app.buttons["forward-confirm"].tap()
    XCTAssertTrue(app.buttons["photo-options"].waitForExistence(timeout: 8))
    let state = try await request("/__qa/state")
    let messages = try XCTUnwrap(state["messages"] as? [[String: Any]])
    let forwarded = messages.filter { ($0["sender"] as? String) == "user" }.compactMap {
      (($0["metadata"] as? [String: Any])?["attachments"] as? [[String: Any]])?.first
    }
    XCTAssertTrue(
      forwarded.contains {
        ($0["assetId"] as? String) == id(5)
          && ($0["alt"] as? String) == "Omnibox after handoff with _HANDOFF_TEST appended"
      })
    app.buttons["photo-thumbnail-" + id(4)].tap()
    XCTAssertTrue(app.staticTexts["Desktop capture 4"].waitForExistence(timeout: 5))
    let photo = app.descendants(matching: .any).matching(identifier: "photo-image-" + id(4))
      .firstMatch
    XCTAssertTrue(photo.waitForExistence(timeout: 5))
    photo.pinch(withScale: 2, velocity: 1)
    capture("viewer-zoom", app)
    photo.doubleTap()
    photo.swipeLeft()
    XCTAssertTrue(
      app.staticTexts["Omnibox after handoff with _HANDOFF_TEST appended"].waitForExistence(
        timeout: 5))
    app.buttons["photo-close"].tap()
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    XCTAssertEqual(field.value as? String, "Keep this draft")
    app.terminate()
  }
  func testOfflineAttachmentOnlyQueueShowsFileIdentity() async throws {
    let app = try await launch(scene: "media")
    openPhoto(app)
    try await request("/__qa/control", ["offline": true])
    app.buttons["photo-options"].tap()
    app.buttons["Forward"].tap()
    app.buttons["forward-to-channel-research"].tap()
    app.buttons["forward-confirm"].tap()
    XCTAssertTrue(app.buttons["photo-close"].waitForExistence(timeout: 8))
    app.buttons["photo-close"].tap()
    XCTAssertTrue(app.staticTexts["Desktop 6.png"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.staticTexts["Queued · offline"].waitForExistence(timeout: 8))
    capture("queued-attachment-identity", app)
    try await request("/__qa/control", ["offline": false])
  }
  func testAttachmentHoldSwipeReplyAndReferenceMarkdown() async throws {
    let app = try await launch(scene: "media")
    let image = app.buttons["attachment-" + id(6)]
    XCTAssertTrue(image.waitForExistence(timeout: 10))
    image.press(forDuration: 0.8)
    XCTAssertTrue(app.buttons["Reply"].waitForExistence(timeout: 5))
    capture("attachment-hold", app)
    app.buttons["Reply"].tap()
    XCTAssertTrue(app.buttons["Cancel reply"].waitForExistence(timeout: 5))
    app.buttons["Cancel reply"].tap()
    app.terminate()
    app.launch()
    XCTAssertTrue(image.waitForExistence(timeout: 10))
    let start = image.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
    start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 150, dy: 0)))
    XCTAssertTrue(app.buttons["Cancel reply"].waitForExistence(timeout: 5))
    capture("attachment-swipe-reply", app)
    app.terminate()
    let markdown = try await launch(scene: "media-markdown")
    XCTAssertTrue(markdown.webViews.firstMatch.waitForExistence(timeout: 10))
    XCTAssertTrue(
      markdown.webViews.staticTexts.containing(
        NSPredicate(format: "label CONTAINS %@", "Mute / unmute")
      ).firstMatch.waitForExistence(timeout: 8))
    capture("reference-markdown", markdown)
    markdown.terminate()
  }
  func testPhotoSaveAndNativeShare() async throws {
    let app = try await launch(scene: "media", theme: "light")
    openPhoto(app)
    XCTAssertTrue(
      app.descendants(matching: .any).matching(identifier: "photo-image-" + id(6)).firstMatch
        .waitForExistence(timeout: 10))
    app.buttons["photo-options"].tap()
    app.buttons["Save"].tap()
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    if springboard.buttons["Allow Access to Add Photos"].waitForExistence(timeout: 3) {
      springboard.buttons["Allow Access to Add Photos"].tap()
    }
    XCTAssertTrue(app.alerts["Saved to Photos"].waitForExistence(timeout: 10))
    capture("saved", app)
    app.alerts.buttons["OK"].tap()
    app.buttons["photo-options"].tap()
    app.buttons["Share"].tap()
    XCTAssertTrue(app.otherElements["ActivityListView"].waitForExistence(timeout: 8))
    capture("photo-share", app)
    app.terminate()
  }
  func testImageFailureCanRetryAndOpen() async throws {
    let app = try await launch(scene: "media")
    app.terminate()
    try await request(
      "/__qa/control",
      [
        "failures": [
          "GET /api/v0/assets/" + id(6): [
            "status": 503, "message": "Temporary fixture failure", "count": 100,
          ]
        ]
      ])
    app.launch()
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 15))
    openPhoto(app)
    XCTAssertTrue(app.buttons["photo-retry"].waitForExistence(timeout: 10))
    capture("photo-failure", app)
    try await request("/__qa/control", ["failures": [:]])
    app.buttons["photo-retry"].tap()
    XCTAssertTrue(
      app.descendants(matching: .any).matching(identifier: "photo-image-" + id(6)).firstMatch
        .waitForExistence(timeout: 10))
    capture("photo-recovered", app)
    app.terminate()
  }
  func testProfileRoutinesNotificationsAndTemplateShare() async throws {
    let app = try await launch(scene: "media")
    for name in [
      "parity-probe-handwritten", "parity-probe-harmless", "cua-time-parity-20260831",
      "cua-parity-interval-20260902", "cua-parity-weekday-20260902",
    ] {
      try await request(
        "/api/v0/bots/bot-research/routines",
        [
          "name": name, "prompt": "Inert QA routine", "schedule": "0 11 * * 1-5", "enabled": false,
          "clientId": UUID().uuidString,
        ])
    }
    app.buttons["conversation-details"].tap()
    XCTAssertTrue(app.textFields["profile-name"].waitForExistence(timeout: 5))
    app.collectionViews.firstMatch.swipeUp()
    let toggle = app.switches["profile-notifications"]
    XCTAssertTrue(toggle.waitForExistence(timeout: 5))
    capture("profile", app)
    let before = toggle.value as? String
    toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
    try await Task.sleep(for: .milliseconds(700))
    let state = try await request("/__qa/state")
    let bot = try XCTUnwrap(
      (state["bots"] as? [[String: Any]])?.first { ($0["id"] as? String) == "bot-research" })
    XCTAssertEqual(bot["notificationsEnabled"] as? Bool, before != "1")
    app.buttons["profile-share-template"].tap()
    XCTAssertTrue(app.otherElements["ActivityListView"].waitForExistence(timeout: 8))
    capture("template-share", app)
    app.terminate()
  }
}
