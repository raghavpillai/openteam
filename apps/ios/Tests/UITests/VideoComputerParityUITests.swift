import XCTest

/// Opt-in live VNC visual capture; uses a disposable QA server, never a user's desktop.
@MainActor final class VideoComputerParityUITests: XCTestCase {
  private let base = "http://127.0.0.1:20024"
  private func request(_ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
    var r = URLRequest(url: URL(string: base + path)!)
    if let body { r.httpMethod = "POST"; r.httpBody = try JSONSerialization.data(withJSONObject: body); r.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    let (data, response) = try await URLSession.shared.data(for: r)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
  private func capture(_ name: String, _ app: XCUIApplication) async throws {
    try await Task.sleep(for: .milliseconds(400))
    let a = XCTAttachment(screenshot: app.screenshot()); a.name = "fixed0921-computer-" + name; a.lifetime = .keepAlways; add(a)
  }
  func testRealComputerKeyboardAndControls() async throws {
    continueAfterFailure = false
    let config = try await request("/__qa/config")
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--show-login", "--server", base, "--appearance", "dark"]
    app.launch()
    XCTAssertTrue(app.buttons["get-started"].waitForExistence(timeout: 15)); app.buttons["get-started"].tap()
    XCTAssertTrue(app.buttons["connect-button"].waitForExistence(timeout: 10)); app.buttons["connect-button"].tap()
    XCTAssertTrue(app.textFields["username-field"].waitForExistence(timeout: 15))
    app.textFields["username-field"].tap(); app.textFields["username-field"].typeText(try XCTUnwrap(config["username"] as? String))
    app.secureTextFields["password-field"].tap(); app.secureTextFields["password-field"].typeText(try XCTUnwrap(config["password"] as? String))
    app.buttons["sign-in-button"].tap()
    let chat = app.buttons["channel-" + (try XCTUnwrap(config["channel"] as? String))]
    XCTAssertTrue(chat.waitForExistence(timeout: 20))
    for _ in 0..<2 where app.buttons["Not Now"].waitForExistence(timeout: 2) { app.buttons["Not Now"].tap() }
    chat.tap(); XCTAssertTrue(app.buttons["Computer"].waitForExistence(timeout: 10))
    _ = try await request("/__qa/control", ["statusDelay": 3000, "vncDelay": 3000])
    app.buttons["Computer"].tap()
    XCTAssertTrue(app.staticTexts["Starting desktop…"].waitForExistence(timeout: 5))
    try await capture("starting", app)
    _ = try await request("/__qa/control", ["statusDelay": 0, "vncDelay": 0])
    XCTAssertTrue(app.buttons["Computer options"].waitForExistence(timeout: 30))
    _ = try await request("/__qa/desktop", [:])
    try await capture("desktop", app)
    app.buttons["Show computer keyboard"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
    try await capture("keyboard", app)
    app.buttons["Hide computer keyboard"].tap()
    app.buttons["Computer options"].tap()
    try await capture("menu", app)
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.3)).tap()
    app.buttons["Done"].tap()
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 10))
    let receipt = try await request("/__qa/state")
    XCTAssertEqual((receipt["status"] as? [String: Any])?["humanTakeover"] as? Bool, false)
    app.terminate()
  }
}
