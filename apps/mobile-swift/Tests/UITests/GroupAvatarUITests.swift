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
