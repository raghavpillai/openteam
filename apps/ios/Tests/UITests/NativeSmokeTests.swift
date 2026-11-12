import XCTest

@MainActor
final class NativeSmokeTests: XCTestCase {
  let base = URL(string: ProcessInfo.processInfo.environment["NATIVE_SMOKE_SERVER"] ?? "http://127.0.0.1:19997")!
  func control(_ path: String, body: [String: Bool] = [:]) async throws {
    var request = URLRequest(url: base.appendingPathComponent(path))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }
  func launch() async throws -> XCUIApplication {
    continueAfterFailure = false
    try await control("__qa/reset")
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--server", base.absoluteString, "--appearance", "light",
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
    try await control("__qa/control", body: ["dropNextSend": true])
    app.buttons["send-button"].tap()
    let empty = NSPredicate(format: "value == %@ OR value == %@", "", "Ask Research")
    let emptied = expectation(for: empty, evaluatedWith: input(app))
    await fulfillment(of: [emptied], timeout: 10)
    let (data, _) = try await URLSession.shared.data(
      from: base.appendingPathComponent("__qa/state"))
    let state = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    let messages = state["messages"] as! [[String: Any]]
    XCTAssertEqual(
      messages.filter { ($0["content"] as? String)?.hasPrefix("Native keyboard parity") == true }
        .count, 1)
    capture("native-message-accepted", app)
  }
}
