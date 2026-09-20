import XCTest

@MainActor final class GroupAvatarUITests: XCTestCase {
  func testListAndHeaderInBothAppearances() async throws {
    continueAfterFailure = false
    for appearance in ["dark", "light"] {
      var request = URLRequest(url: URL(string: "http://127.0.0.1:20070/__qa/scene")!)
      request.httpMethod = "POST"
      request.httpBody = Data(#"{"scene":"group-avatars"}"#.utf8)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      let (_, response) = try await URLSession.shared.data(for: request)
      XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
      let app = XCUIApplication()
      app.launchArguments = [
        "--ui-testing", "--server", "http://127.0.0.1:20070", "--appearance", appearance,
      ]
      app.launch()
      XCTAssertTrue(app.buttons["channel-visual-group-5"].waitForExistence(timeout: 15))
      try await Task.sleep(for: .seconds(1))
      capture("groups-list-" + appearance, app)
      for count in [2, 5, 12] {
        app.buttons["channel-visual-group-\(count)"].tap()
        XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 8))
        let avatar = app.descendants(matching: .any).matching(
          identifier: "group-avatar-visual-group-\(count)"
        ).firstMatch
        XCTAssertTrue(avatar.waitForExistence(timeout: 5))
        XCTAssertEqual(avatar.label, "\(count) bots")
        XCTAssertEqual(avatar.value as? String, count > 3 ? "+\(count - 3) more" : "")
        XCTAssertGreaterThan(avatar.frame.width, 27)
        XCTAssertTrue(app.buttons["Computer"].exists)
        assertHeaderCentered(app)
        try await Task.sleep(for: .seconds(1))
        capture("groups-header-\(count)-" + appearance, app)
        app.buttons["chat-back"].tap()
      }
      for name in ["short", "long"] {
        app.buttons["channel-visual-header-\(name)"].tap()
        XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["Computer"].exists)
        assertHeaderCentered(app)
        capture("direct-header-\(name)-" + appearance, app)
        app.buttons["chat-back"].tap()
      }
      app.terminate()
    }
  }
  func testComputerFollowsLatestResponderAndKeepsOpenSessionStable() async throws {
    continueAfterFailure = false
    try await fixturePost("scene", ["scene": "group-avatars"])
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", "http://127.0.0.1:20070", "--appearance", "dark"]
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(app.buttons["channel-visual-group-5"].waitForExistence(timeout: 15))
    app.buttons["channel-visual-group-5"].tap()
    let computer = app.buttons["Computer"]
    XCTAssertTrue(computer.waitForExistence(timeout: 8))
    XCTAssertEqual(computer.value as? String, "Member 2")
    assertHeaderCentered(app)
    capture("group-computer-header", app)
    computer.tap()
    XCTAssertTrue(app.buttons["Computer options"].waitForExistence(timeout: 12))
    XCTAssertTrue(app.staticTexts["Member 2"].exists)
    try await assertRequestedScreen("visual-group-5-bot-1")

    try await fixturePost("group-reply", ["channelId": "visual-group-5", "botId": "visual-group-5-bot-2", "content": "Newest group reply."])
    try await Task.sleep(for: .seconds(2))
    XCTAssertTrue(app.staticTexts["Member 2"].exists, "A reply must not switch an open desktop")
    app.buttons["Done"].tap()
    XCTAssertTrue(computer.waitForExistence(timeout: 8))
    let changed = NSPredicate(format: "value == %@", "Member 3")
    await fulfillment(of: [XCTNSPredicateExpectation(predicate: changed, object: computer)], timeout: 8)
    // A newer human message leaves the last bot responder selected.
    try await fixturePost("group-reply", ["channelId": "visual-group-5", "content": "Thanks."])
    XCTAssertTrue(app.staticTexts["Thanks."].waitForExistence(timeout: 8))
    XCTAssertEqual(computer.value as? String, "Member 3")
    capture("group-computer-latest-responder", app)
    computer.tap()
    XCTAssertTrue(app.buttons["Computer options"].waitForExistence(timeout: 12))
    XCTAssertTrue(app.staticTexts["Member 3"].exists)
    try await assertRequestedScreen("visual-group-5-bot-2")
    capture("group-computer-open", app)
  }
  private func fixturePost(_ path: String, _ body: [String: String]) async throws {
    var request = URLRequest(url: URL(string: "http://127.0.0.1:20070/__qa/" + path)!)
    request.httpMethod = "POST"
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }
  private func assertRequestedScreen(_ botID: String) async throws {
    let (data, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:20070/__qa/state")!)
    let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let requests = try XCTUnwrap(state["requests"] as? [[String: Any]])
    for suffix in ["", "/frame"] {
      XCTAssertTrue(requests.contains { $0["path"] as? String == "/api/v0/bots/\(botID)/screen\(suffix)" && $0["method"] as? String == "GET" })
    }
  }
  func assertHeaderCentered(_ app: XCUIApplication) {
    let pill = app.buttons["conversation-details"]
    let back = app.buttons["chat-back"]
    XCTAssertTrue(pill.isHittable)
    XCTAssertEqual(
      pill.frame.midX, app.frame.midX, accuracy: 0.5,
      "The avatar/title pill must remain centered on the screen")
    XCTAssertGreaterThanOrEqual(pill.frame.minX, back.frame.maxX + 7.5)
    XCTAssertLessThanOrEqual(pill.frame.maxX, app.frame.maxX - back.frame.maxX - 7.5)
  }
  func capture(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
