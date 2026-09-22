import CoreImage
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
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat-loading")
      .firstMatch.waitForNonExistence(timeout: 15))
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
    XCTAssertTrue(app.staticTexts["Waiting for connection"].waitForExistence(timeout: 8))
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
    XCTAssertTrue(app.buttons["thread-back"].waitForExistence(timeout: 5))
    app.buttons["thread-back"].tap()
    app.terminate()
    app.launch()
    XCTAssertTrue(image.waitForExistence(timeout: 10))
    let start = image.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
    start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 150, dy: 0)))
    XCTAssertTrue(app.buttons["thread-back"].waitForExistence(timeout: 5))
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
    let photosPermission = springboard.alerts.containing(
      NSPredicate(format: "label CONTAINS[c] %@", "Photos")
    ).firstMatch
    if photosPermission.waitForExistence(timeout: 3) {
      // iOS 26 labels add-only access "Allow"; earlier releases use the longer label.
      let allow = photosPermission.buttons.matching(
        NSPredicate(format: "label IN %@", ["Allow", "Allow Access to Add Photos"])
      ).firstMatch
      XCTAssertTrue(allow.waitForExistence(timeout: 3))
      allow.tap()
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

  func testLongGalleryKeepsVisibleThumbnailsAndReopensCachedPhotosOffline() async throws {
    let app = try await launch(scene: "media-long")
    let last = app.buttons["attachment-gallery-24"]
    XCTAssertTrue(last.waitForExistence(timeout: 10))
    let initial = try await request("/__qa/state")
    let inlineRequests = try XCTUnwrap(initial["contentReceipts"] as? [[String: Any]])
    last.tap()
    XCTAssertTrue(app.buttons["photo-options"].waitForExistence(timeout: 8))
    let strip = app.scrollViews["photo-filmstrip"]
    XCTAssertTrue(strip.waitForExistence(timeout: 5))
    func select(_ number: Int, backwards: Bool) {
      let thumbnail = app.buttons["photo-thumbnail-gallery-\(number)"]
      for _ in 0..<12 {
        if thumbnail.exists, !thumbnail.frame.isEmpty, app.frame.contains(thumbnail.frame) { break }
        if backwards { strip.swipeRight() } else { strip.swipeLeft() }
      }
      XCTAssertTrue(thumbnail.exists)
      XCTAssertFalse(thumbnail.frame.isEmpty)
      XCTAssertTrue(app.frame.contains(thumbnail.frame))
      thumbnail.tap()
      XCTAssertTrue(app.staticTexts["Gallery photo \(number)"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "photo-image-gallery-\(number)")
        .firstMatch.waitForExistence(timeout: 10))
    }
    // Traverse more photos than the full-size cache can retain.
    for number in stride(from: 23, through: 1, by: -1) { select(number, backwards: true) }
    select(24, backwards: false)
    try await Task.sleep(for: .seconds(1))
    let bitmap = try XCTUnwrap(app.screenshot().image.cgImage)
    let scale = CGFloat(bitmap.width) / app.frame.width
    var sampled = 0
    for number in 1...24 {
      let thumbnail = app.buttons["photo-thumbnail-gallery-\(number)"]
      guard thumbnail.exists, !thumbnail.frame.isEmpty, app.frame.contains(thumbnail.frame) else { continue }
      let rect = CGRect(x: thumbnail.frame.midX * scale - 6, y: thumbnail.frame.midY * scale - 6, width: 12, height: 12)
      let sample = try XCTUnwrap(bitmap.cropping(to: rect))
      let filter = try XCTUnwrap(CIFilter(name: "CIAreaAverage"))
      filter.setValue(CIImage(cgImage: sample), forKey: kCIInputImageKey)
      filter.setValue(CIVector(cgRect: CGRect(x: 0, y: 0, width: 12, height: 12)), forKey: kCIInputExtentKey)
      var rgba = [UInt8](repeating: 0, count: 4)
      CIContext().render(try XCTUnwrap(filter.outputImage), toBitmap: &rgba, rowBytes: 4,
        bounds: CGRect(x: 0, y: 0, width: 1, height: 1), format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
      XCTAssertGreaterThan(Int(rgba[0]) + Int(rgba[1]) + Int(rgba[2]), 180,
        "Photo \(number) regressed to an empty dark filmstrip tile")
      sampled += 1
    }
    XCTAssertGreaterThanOrEqual(sampled, 3)
    capture("long-gallery-thumbnails", app)
    let before = try await request("/__qa/state")
    let requests = try XCTUnwrap(before["contentReceipts"] as? [[String: Any]])
    let receipts = XCTAttachment(data: try JSONSerialization.data(withJSONObject: [
      "inline": inlineRequests, "afterGallery": requests,
    ], options: [.prettyPrinted, .sortedKeys]), uniformTypeIdentifier: "public.json")
    receipts.name = "gallery-download-receipts"; receipts.lifetime = .keepAlways; add(receipts)
    for number in 1...23 {
      let path = "/api/v0/assets/gallery-\(number)"
      let inlineCount = inlineRequests.filter { ($0["path"] as? String) == path }.count
      XCTAssertEqual(requests.filter { ($0["path"] as? String) == path }.count - inlineCount, 1,
        "Page and thumbnail should share one original download for \(path); inline count \(inlineCount)")
    }
    try await request("/__qa/control", ["offline": true])
    select(1, backwards: true)
    XCTAssertFalse(app.buttons["photo-retry"].exists)
    capture("long-gallery-offline-return", app)
    try await request("/__qa/control", ["offline": false])
    app.terminate()
  }
  func testImageFailureCanRetryAndOpen() async throws {
    for status in [503, 200] {
    let app = try await launch(scene: "media")
    app.terminate()
    try await request(
      "/__qa/control",
      [
        "failures": [
          "GET /api/v0/assets/" + id(6): [
            "status": status, "message": "Temporary fixture failure", "count": 100,
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
  }
  func testProfileRoutinesNotificationsAndTemplateShare() async throws {
    let app = try await launch(scene: "media")
    for (name, schedules) in [
      ("parity-probe-handwritten", ["0 11 * * 1-5"]),
      ("parity-probe-harmless", ["0 11 * * 1-5"]),
      ("cua-time-parity-20260831", ["0 * * * *"]),
      ("cua-parity-interval-20260902", ["@every 5m", "45 19 * * 1-5"]),
      ("cua-parity-weekday-20260902", ["45 19 * * 1-5"]),
    ] {
      try await request(
        "/api/v0/bots/bot-research/routines",
        [
          "name": name, "prompt": "Inert QA routine", "schedule": schedules[0], "schedules": schedules, "enabled": false,
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
