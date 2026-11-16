import XCTest

@MainActor
final class NativeSmokeTests: XCTestCase {
  let fixture = QAFixture(
    base: ProcessInfo.processInfo.environment["NATIVE_SMOKE_SERVER"] ?? "http://127.0.0.1:19997")
  func launch() async throws -> XCUIApplication {
    continueAfterFailure = false
    try await fixture.post("/__qa/reset")
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--server", fixture.base, "--appearance", "light",
    ]
    app.launch()
    XCTAssertTrue(app.buttons["channel-channel-research"].waitForExistence(timeout: 15))
    return app
  }
  func capture(_ name: String, _ app: XCUIApplication) {
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = name
    screenshot.lifetime = .keepAlways
    add(screenshot)
  }
  func input(_ app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
  }
  func testChatKeyboardSendAndLostAcknowledgment() async throws {
    let app = try await launch()
    capture("native-home-light", app)
    app.buttons["channel-channel-research"].tap()
    XCTAssertTrue(input(app).waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["conversation-details"].exists)
    capture("native-chat-light", app)
    input(app).tap()
    input(app).typeText("Native keyboard parity")
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    XCTAssertLessThanOrEqual(input(app).frame.maxY, app.keyboards.firstMatch.frame.minY + 1)
    capture("native-keyboard-short", app)
    input(app).typeText(
      "\nSecond line\nThird line\nFourth line\nFifth line\nSixth line\nSeventh line")
    XCTAssertLessThanOrEqual(
      app.buttons["send-button"].frame.maxY, app.keyboards.firstMatch.frame.minY + 1)
    capture("native-keyboard-multiline", app)
    try await fixture.post("/__qa/control", ["dropNextSend": true])
    app.buttons["send-button"].tap()
    let empty = NSPredicate(format: "value == %@ OR value == %@", "", "Ask Research")
    let emptied = expectation(for: empty, evaluatedWith: input(app))
    await fulfillment(of: [emptied], timeout: 10)
    let messages = try await fixture.state()["messages"] as? [[String: Any]] ?? []
    XCTAssertEqual(
      messages.filter { ($0["content"] as? String)?.hasPrefix("Native keyboard parity") == true }
        .count, 1)
    capture("native-message-accepted", app)
  }
  /// MapKit builds a pin's view outside the message row while the map grows to full
  /// screen; a pin with a photo once crashed there for want of the app's store.
  func testFullScreenMapWithPlacePhotosStaysOpen() async throws {
    continueAfterFailure = false
    try await fixture.post("/__qa/scene", ["scene": "bot-reply"])
    let places: [[String: Any]] = [("qa-photo-a", 40.7420, -74.0103), ("qa-photo-b", 40.7480, -74.0048), ("qa-photo-c", 40.7538, -74.0022)]
      .map { ["id": $0.0, "name": "Photo stop " + $0.0.suffix(1).uppercased(), "latitude": $0.1, "longitude": $0.2,
              "imageUrl": "https://example.invalid/" + $0.0 + ".jpg"] }
    let presentation: [String: Any] = ["version": 1, "places": places,
      "blocks": [["type": "place_map", "placeIds": places.map { $0["id"]! }]]]
    try await fixture.post("/__qa/update-message", ["id": "content-fixture", "content": "", "metadata": ["type": "presentation", "presentation": presentation]])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", fixture.base, "--open-channel", "channel-research"]
    app.launch()
    let expand = app.buttons["expand-place-map"]
    XCTAssertTrue(expand.waitForExistence(timeout: 15))
    for _ in 0..<3 {
      expand.tap()
      XCTAssertTrue(app.buttons["close-place-map"].waitForExistence(timeout: 8), "The map opens full screen")
      XCTAssertEqual(app.state, .runningForeground)
      // The chat's own map is still underneath, so the pin exists twice: tap the one on top.
      let pin = app.buttons.matching(identifier: "place-pin-qa-photo-b").allElementsBoundByIndex.first { $0.isHittable }
      XCTAssertNotNil(pin, "The full-screen map shows the pin")
      pin?.tap()
      XCTAssertTrue(app.buttons["close-place-details"].waitForExistence(timeout: 5))
      app.buttons["close-place-details"].tap()
      app.buttons["close-place-map"].tap()
      XCTAssertTrue(expand.waitForExistence(timeout: 8))
    }
    XCTAssertEqual(app.state, .runningForeground)
    app.terminate()
  }
}
