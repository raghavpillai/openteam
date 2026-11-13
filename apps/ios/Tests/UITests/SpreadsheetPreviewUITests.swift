import XCTest

/// CSV attachments open in the native spreadsheet preview rather than Quick Look.
@MainActor final class SpreadsheetPreviewUITests: XCTestCase {
  let base = URL(string: ProcessInfo.processInfo.environment["CHAT_MOTION_SERVER"] ?? "http://127.0.0.1:20070")!
  func control(_ path: String, _ body: [String: Any]) async throws {
    var request = URLRequest(url: base.appendingPathComponent(path))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }

  /// The conversation settles into place after it appears; a tap before then can be lost.
  func waitUntilHittable(_ element: XCUIElement) async {
    let hittable = expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: element)
    await fulfillment(of: [hittable], timeout: 10)
  }

  func testCSVOpensInTheSpreadsheetPreview() async throws {
    continueAfterFailure = false
    try await control("__qa/reset", [:])
    try await control("__qa/content", ["scene": "spreadsheet"])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base.absoluteString, "--open-channel", "channel-research"]
    app.launch()
    defer { app.terminate() }
    let file = app.buttons["attachment-sheet-transactions"]
    XCTAssertTrue(file.waitForExistence(timeout: 15))
    await waitUntilHittable(file)
    file.tap()
    let grid = app.descendants(matching: .any)["spreadsheet-grid"]
    XCTAssertTrue(grid.waitForExistence(timeout: 10))
    XCTAssertEqual(app.staticTexts["file-preview-rows"].label, "30 rows")
    let header = app.descendants(matching: .any)["spreadsheet-cell-0-0"]
    XCTAssertEqual(header.label, "A1, Date")

    app.descendants(matching: .any)["spreadsheet-cell-2-1"].tap()
    XCTAssertEqual(app.staticTexts["spreadsheet-address"].label, "B3")
    XCTAssertEqual(app.staticTexts["spreadsheet-value"].label, "Fresh Market")

    app.descendants(matching: .any)["spreadsheet-row-4"].tap()
    XCTAssertEqual(app.staticTexts["spreadsheet-address"].label, "A5:E5")

    // The header row stays at the top while the rows scroll beneath it.
    let headerTop = header.frame.minY
    grid.swipeUp()
    XCTAssertTrue(header.isHittable)
    XCTAssertEqual(header.frame.minY, headerTop, accuracy: 13)
    XCTAssertFalse(app.descendants(matching: .any)["spreadsheet-row-1"].isHittable)

    app.buttons["file-preview-close"].tap()
    XCTAssertTrue(grid.waitForNonExistence(timeout: 5))
  }

  /// Wide displays such as an unfolded iPhone Duo open documents as a floating card that
  /// Close, a tap outside, or a drag on its grabber dismisses.
  func testWideDisplaysUseAFloatingCard() async throws {
    continueAfterFailure = false
    try await control("__qa/reset", [:])
    try await control("__qa/content", ["scene": "spreadsheet"])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base.absoluteString, "--open-channel", "channel-research"]
    app.launch()
    defer { app.terminate() }
    try XCTSkipUnless(app.windows.firstMatch.frame.width > 700, "Only wide displays use the floating card")
    let file = app.buttons["attachment-sheet-transactions"]
    let grid = app.descendants(matching: .any)["spreadsheet-grid"]
    let close = app.buttons["file-preview-close"]
    XCTAssertTrue(file.waitForExistence(timeout: 15))
    await waitUntilHittable(file)

    file.tap()
    XCTAssertTrue(grid.waitForExistence(timeout: 20))
    let window = app.windows.firstMatch.frame
    XCTAssertGreaterThan(grid.frame.width, window.width * 0.75, "the card spans most of the display")
    close.tap()
    XCTAssertTrue(grid.waitForNonExistence(timeout: 5))

    file.tap()
    XCTAssertTrue(grid.waitForExistence(timeout: 10))
    let backdrop = app.descendants(matching: .any)["file-preview-backdrop"]
    backdrop.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.5)).tap()
    XCTAssertTrue(grid.waitForNonExistence(timeout: 5), "tapping outside closes the card")

    file.tap()
    XCTAssertTrue(grid.waitForExistence(timeout: 10))
    let grabber = app.descendants(matching: .any)["file-preview-grabber"]
      .coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
    grabber.press(forDuration: 0.05, thenDragTo: grabber.withOffset(CGVector(dx: 0, dy: 400)))
    XCTAssertTrue(grid.waitForNonExistence(timeout: 5), "dragging the grabber down closes the card")
    XCTAssertTrue(file.isHittable, "the conversation is usable again")
  }
}
