import XCTest

/// Uses the loopback parity fixture, including HTTP request counts, not real account data.
@MainActor final class ServerActivityUITests: XCTestCase {
  private let base = "http://127.0.0.1:20091"

  private func control(fail: Bool? = nil) async throws -> Int {
    var request = URLRequest(url: URL(string: base + "/__qa/activity")!)
    if let fail {
      request.httpMethod = "POST"
      request.httpBody = try JSONSerialization.data(withJSONObject: ["fail": fail])
    }
    let (data, _) = try await URLSession.shared.data(for: request)
    return (try JSONSerialization.jsonObject(with: data) as! [String: Int])["requests"]!
  }

  func testLiveActivityAndVisibilityLifecycle() async throws {
    continueAfterFailure = false
    _ = try await control(fail: false)
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "light"]
    app.launch()
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 20))
    app.buttons["settings-button"].tap()
    let server = app.buttons["Server status"]
    for _ in 0..<4 where !server.isHittable { app.swipeUp() }
    XCTAssertTrue(server.waitForExistence(timeout: 5))
    server.tap()
    let cpu = app.descendants(matching: .any)["server-activity-cpu"].firstMatch
    XCTAssertTrue(cpu.waitForExistence(timeout: 8))
    let loaded = NSPredicate(format: "value == %@", "32% used")
    let initialLoaded = expectation(for: loaded, evaluatedWith: cpu)
    await fulfillment(of: [initialLoaded], timeout: 8)
    capture("ios-light", app)
    XCTAssertEqual(
      app.descendants(matching: .any)["server-activity-ram"].firstMatch.value as? String, "76% used"
    )
    XCTAssertEqual(
      app.descendants(matching: .any)["server-activity-disk"].firstMatch.value as? String,
      "94% used")
    let before = try await control()
    try await Task.sleep(for: .seconds(5.2))
    let after = try await control()
    XCTAssertEqual(after, before + 1)

    _ = try await control(fail: true)
    let unavailable = expectation(
      for: NSPredicate(format: "value == %@", "Unavailable"), evaluatedWith: cpu)
    // Allow a polling interval, the request deadline, and simulator accessibility latency.
    await fulfillment(of: [unavailable], timeout: 15)
    _ = try await control(fail: false)
    let recovered = expectation(for: loaded, evaluatedWith: cpu)
    await fulfillment(of: [recovered], timeout: 15)

    XCUIDevice.shared.press(.home)
    try await Task.sleep(for: .seconds(1))
    let background = try await control()
    try await Task.sleep(for: .seconds(5.2))
    let stillBackground = try await control()
    XCTAssertEqual(stillBackground, background)
    app.activate()
    XCTAssertTrue(cpu.waitForExistence(timeout: 5))
    app.navigationBars.buttons.firstMatch.tap()
    try await Task.sleep(for: .seconds(1))
    let away = try await control()
    try await Task.sleep(for: .seconds(5.2))
    let stillAway = try await control()
    XCTAssertEqual(stillAway, away)

    app.terminate()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "dark"]
    app.launch()
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 20))
    app.buttons["settings-button"].tap()
    for _ in 0..<4 where !server.isHittable { app.swipeUp() }
    server.tap()
    let darkLoaded = expectation(for: loaded, evaluatedWith: cpu)
    await fulfillment(of: [darkLoaded], timeout: 8)
    capture("ios-dark", app)
  }

  private func capture(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
