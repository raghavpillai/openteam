import XCTest

@MainActor final class BrowserNetworkUITests: XCTestCase {
  let base = "http://127.0.0.1:19994"
  func post(_ path: String, _ body: [String: Any] = [:]) async throws {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode,200)
  }
  func state() async throws -> [String: Any] {
    let (data,_) = try await URLSession.shared.data(from: URL(string:base + "/__qa/state")!)
    return try XCTUnwrap(JSONSerialization.jsonObject(with:data) as? [String:Any])
  }
  func testAlwaysRankedPriorityAndFallback() async throws {
    continueAfterFailure = false
    try await post("/__qa/reset")
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing","--server",base,"--appearance","light"]
    app.launch()
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout:20))
    app.buttons["settings-button"].tap()
    XCTAssertTrue(app.buttons["server-settings"].waitForExistence(timeout:5))
    app.buttons["server-settings"].tap()
    XCTAssertTrue(app.staticTexts["network-source-server"].waitForExistence(timeout:5))
    waitStatus("Using MacBook Air", app)
    let privateIP = app.buttons["network-private-Exit IP"]
    let privateLocation = app.buttons["network-private-Location"]
    XCTAssertTrue(privateIP.waitForExistence(timeout: 5))
    XCTAssertEqual(privateIP.value as? String, "Hidden")
    XCTAssertEqual(privateLocation.value as? String, "Hidden")
    let qualityTest = app.buttons["network-quality-test"]
    XCTAssertTrue(qualityTest.exists)
    qualityTest.tap()
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "network-quality-result").firstMatch.waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["~28.4 Mbps"].exists)
    capture("initial",app)
    privateIP.tap()
    XCTAssertEqual(privateIP.value as? String, "203.0.113.10")
    try await Task.sleep(for: .seconds(2))
    privateLocation.tap()
    XCTAssertEqual(privateLocation.value as? String, "New York, United States")
    capture("revealed",app)
    try await Task.sleep(for: .seconds(2))
    privateIP.tap()
    privateLocation.tap()
    try await Task.sleep(for: .seconds(3))
    // Native drag-and-drop: the server is a regular ranked entry.
    let handles = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Reorder'"))
    XCTAssertEqual(handles.count, 3)
    handles.element(boundBy: 2).press(forDuration: 0.8, thenDragTo: handles.element(boundBy: 1))
    XCTAssertTrue(app.buttons["network-apply"].isEnabled)
    let before = try await state()
    XCTAssertEqual((before["networkPatches"] as? [Any])?.count,0)
    capture("draft",app)
    try await Task.sleep(for: .seconds(3))
    try apply(app)
    let saved = try await state()
    let network = try XCTUnwrap(saved["browserNetwork"] as? [String:Any])
    let settings = try XCTUnwrap(network["settings"] as? [String:Any])
    XCTAssertEqual(settings["sourceOrder"] as? [String],["air","server","mini"])
    XCTAssertEqual(settings["mode"] as? String,"ranked")
    // Simulate the desktop provider going offline; the iPhone polls the same saved priority.
    try await post("/__qa/browser-network",["devices":[["machineId":"air","connected":false]]])
    waitStatus("Using the server connection", app)
    XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "network-quality-result").firstMatch.exists)
    XCTAssertTrue(privateIP.waitForExistence(timeout: 5))
    XCTAssertEqual(privateIP.value as? String, "Hidden")
    privateIP.tap()
    XCTAssertEqual(privateIP.value as? String, "192.0.2.30")
    privateIP.tap()
    XCTAssertTrue(app.staticTexts["Not working"].firstMatch.exists)
    capture("server-fallback",app)
    try await Task.sleep(for: .seconds(4))
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Reorder'")).element(boundBy: 2).press(forDuration: 0.8, thenDragTo: app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Reorder'")).element(boundBy: 1))
    try apply(app)
    waitStatus("Using Mac mini", app)
    capture("computer-fallback",app)
    try await Task.sleep(for: .seconds(4))
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Reorder'")).element(boundBy: 1).press(forDuration: 0.8, thenDragTo: app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Reorder'")).element(boundBy: 0))
    app.buttons["network-discard"].tap()
    XCTAssertFalse(app.buttons["network-apply"].isEnabled)
    // Both computers offline -> the server still supplies the browser connection.
    try await post("/__qa/browser-network",["devices":[["machineId":"mini","connected":false]]])
    waitStatus("Using the server connection", app)
    capture("all-offline",app)
    try await Task.sleep(for: .seconds(4))

  }
  func waitStatus(_ label: String, _ app: XCUIApplication) {
    let status = app.descendants(matching: .any).matching(identifier: "network-status").firstMatch
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", label), object: status)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 8), .completed)
  }
  func apply(_ app: XCUIApplication) throws {
    app.buttons["network-apply"].tap()
    XCTAssertTrue(app.sheets.buttons["Apply priority"].waitForExistence(timeout:4))
    app.sheets.buttons["Apply priority"].tap()
    let done = XCTNSPredicateExpectation(predicate:NSPredicate(format:"enabled == false"),object:app.buttons["network-apply"])
    XCTAssertEqual(XCTWaiter.wait(for:[done],timeout:5),.completed)
  }
  func capture(_ name: String,_ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot:app.screenshot())
    attachment.name = "network-"+name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
