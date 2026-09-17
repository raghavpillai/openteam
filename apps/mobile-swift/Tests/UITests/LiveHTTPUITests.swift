import XCTest

/// Opt-in connection probe against the running local installation; no owner credentials or data writes.

@MainActor final class LiveHTTPUITests: XCTestCase {
  func testNativeHTTPServerDiscoveryAndAuthenticationResponse() async throws {
    try await verifyConnection("http://100.94.42.50:8787")
  }
  func testNativeHTTPSServerDiscoveryAndAuthenticationResponse() async throws {
    try await verifyConnection("https://office-mac-mini.tail658346.ts.net:10000")
  }
  private func verifyConnection(_ base: String) async throws {
    continueAfterFailure = false
    let scheme = try XCTUnwrap(URL(string: base)?.scheme)
    var receipt: [String: Any] = ["server": base, "httpsUsed": scheme == "https"]
    for path in ["/health", "/api/auth/config"] {
      let (data, response) = try await URLSession.shared.data(from: URL(string: base + path)!)
      let http = try XCTUnwrap(response as? HTTPURLResponse)
      XCTAssertEqual(http.statusCode, 200)
      XCTAssertEqual(http.url?.scheme, scheme)
      let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
      if path == "/health" { XCTAssertEqual(json["status"] as? String, "ready") }
      else { XCTAssertEqual(json["mode"] as? String, "required") }
      receipt[path] = json
    }
    let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys]), uniformTypeIdentifier: "public.json")
    attachment.name = "live-http-server-response"
    attachment.lifetime = .keepAlways
    add(attachment)
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--show-login", "--server", base, "--appearance", "light"]
    app.launch()
    XCTAssertTrue(app.buttons["get-started"].waitForExistence(timeout: 10))
    app.buttons["get-started"].tap()
    XCTAssertEqual(app.textFields["server-field"].value as? String, base)
    var screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "live-http-server-entry"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    app.buttons["connect-button"].tap()
    guard app.textFields["username-field"].waitForExistence(timeout: 20) else {
      XCTFail("Native app failed to reach sign-in over \(scheme)")
      return
    }
    screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "live-http-sign-in"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    app.textFields["username-field"].tap()
    app.textFields["username-field"].typeText("nativeqa0917")
    app.secureTextFields["password-field"].tap()
    app.secureTextFields["password-field"].typeText("not-a-real-account-password")
    app.buttons["sign-in-button"].tap()
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", "username or password")).firstMatch.waitForExistence(timeout: 20))
    screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "live-http-authentication-response"
    screenshot.lifetime = .keepAlways
    add(screenshot)
  }
}
