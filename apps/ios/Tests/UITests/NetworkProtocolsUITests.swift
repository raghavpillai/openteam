import XCTest

@MainActor final class NetworkProtocolsUITests: XCTestCase {
  let base = "http://127.0.0.1:20784"
  func post(_ path: String, _ body: [String: Any] = [:]) async throws {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }
  func open(_ appearance: String, largeText: Bool = false) async throws -> XCUIApplication {
    try await post("/__qa/reset")
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", appearance]
    if largeText { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] }
    app.launch()
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 20))
    app.buttons["settings-button"].tap()
    let server = app.buttons["server-settings"]
    for _ in 0..<8 { if server.exists && server.isHittable { break }; app.swipeUp() }
    XCTAssertTrue(server.waitForExistence(timeout: 5))
    server.tap()
    return app
  }
  func capture(_ name: String, _ app: XCUIApplication) {
    let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
  }
  func protocolElement(_ title: String, _ app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: "network-protocol-\(title)").firstMatch
  }
  func waitLabel(_ title: String, _ state: String, _ app: XCUIApplication) {
    let element = protocolElement(title, app)
    let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", state), object: element)
    XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 10), .completed)
  }
  func testProtocolStatesAndDetails() async throws {
    continueAfterFailure = false
    let app = try await open("light")
    waitLabel("IPv4", "Working", app); waitLabel("IPv6", "Unavailable", app)
    XCTAssertFalse(app.staticTexts["The selected exit could not connect."].exists)
    capture("protocols-ipv4-light", app)
    let disclosure = app.buttons.matching(identifier: "network-protocols").firstMatch
    XCTAssertTrue(disclosure.waitForExistence(timeout: 5)); disclosure.tap()
    XCTAssertTrue(app.staticTexts["The selected exit could not connect."].waitForExistence(timeout: 5))
    capture("protocols-details-light", app)
    for states in [["working", "working"], ["unavailable", "working"], ["unavailable", "unavailable"], ["checking", "checking"]] {
      try await post("/__qa/browser-network", ["protocols": states])
      waitLabel("IPv4", states[0] == "working" ? "Working" : states[0] == "checking" ? "Checking" : "Unavailable", app)
      waitLabel("IPv6", states[1] == "working" ? "Working" : states[1] == "checking" ? "Checking" : "Unavailable", app)
      capture("protocols-\(states.joined(separator: "-"))", app)
    }
    try await post("/__qa/browser-network", ["staleProtocols": true])
    waitLabel("IPv4", "Not checked", app); waitLabel("IPv6", "Not checked", app)
  }
  func testDarkAppearanceAndAccessibilityText() async throws {
    continueAfterFailure = false
    let app = try await open("dark", largeText: true)
    let row = app.descendants(matching: .any).matching(identifier: "network-protocols").firstMatch
    for _ in 0..<4 { if row.isHittable { break }; app.swipeUp() }
    XCTAssertTrue(row.waitForExistence(timeout: 5))
    waitLabel("IPv4", "Working", app); waitLabel("IPv6", "Unavailable", app)
    XCTAssertGreaterThan(row.frame.height, 40)
    let ipv4 = protocolElement("IPv4", app), ipv6 = protocolElement("IPv6", app)
    XCTAssertLessThan(ipv4.frame.height, 160, "Protocol words must remain readable at the largest text size")
    XCTAssertLessThan(ipv6.frame.height, 160, "Protocol words must remain readable at the largest text size")
    XCTAssertLessThanOrEqual(ipv6.frame.maxX, row.frame.maxX, "Protocol health stays within the disclosure row")
    XCTAssertLessThanOrEqual(ipv4.frame.maxY, ipv6.frame.minY, "Accessibility sizes stack the protocols")
    capture("protocols-dark-accessibility", app)
    row.tap()
    XCTAssertTrue(app.staticTexts["The selected exit could not connect."].waitForExistence(timeout: 5))
    capture("protocols-dark-accessibility-details", app)
  }
  func testPriorityChangeKeepsProtocolStatusOnTheSelectedExit() async throws {
    continueAfterFailure = false
    let app = try await open("dark")
    waitLabel("IPv4", "Working", app)
    app.staticTexts["network-source-air"].press(forDuration: 0.8)
    XCTAssertTrue(app.buttons["Move down"].waitForExistence(timeout: 5))
    app.buttons["Move down"].tap()
    XCTAssertTrue(app.buttons["network-apply"].isEnabled)
    app.buttons["network-apply"].tap()
    XCTAssertTrue(app.sheets.buttons["Apply priority"].waitForExistence(timeout: 5))
    app.sheets.buttons["Apply priority"].tap()
    let status = app.descendants(matching: .any).matching(identifier: "network-status").firstMatch
    let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "Using Mac mini"), object: status)
    XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 8), .completed)
    waitLabel("IPv4", "Working", app)
    waitLabel("IPv6", "Unavailable", app)
    capture("protocols-dark-new-exit", app)
  }

}
