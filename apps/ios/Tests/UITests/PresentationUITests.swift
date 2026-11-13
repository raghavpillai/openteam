import XCTest

@MainActor final class PresentationUITests: XCTestCase {
  func testMapCarouselFullScreenAndRankingsInBothAppearances() async throws {
    continueAfterFailure = false
    let base = ProcessInfo.processInfo.environment["PRESENTATION_SERVER"] ?? "http://127.0.0.1:20180"
    for appearance in ["light", "dark"] {
      var request = URLRequest(url: URL(string: base + "/__qa/content")!)
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: ["scene": "presentation"])
      let (_, response) = try await URLSession.shared.data(for: request)
      XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
      let app = XCUIApplication()
      app.launchArguments = ["--ui-testing", "--server", base, "--appearance", appearance, "--open-channel", "channel-research"]
      app.launch()
      let expand = app.buttons["expand-place-map"]
      XCTAssertTrue(expand.waitForExistence(timeout: 15))
      let first = app.buttons["place-card-map-widget-point-f078aff04d9bd814"]
      XCTAssertTrue(first.exists)
      for _ in 0..<5 {
        if first.isHittable && expand.isHittable { break }
        app.tables["chat-history"].swipeDown()
      }
      let inlineCapture = XCTAttachment(screenshot: app.screenshot())
      inlineCapture.name = "presentation-chat-" + appearance; inlineCapture.lifetime = .keepAlways; add(inlineCapture)
      let last = app.buttons["place-card-map-widget-point-8a1b2d2832f05b71"]
      for _ in 0..<3 {
        if last.isHittable { break }
        app.scrollViews["place-carousel"].swipeLeft()
      }
      XCTAssertTrue(last.isHittable)
      last.tap()
      XCTAssertTrue(app.buttons["close-place-details"].waitForExistence(timeout: 5))
      app.buttons["close-place-details"].tap()
      expand.tap()
      XCTAssertTrue(app.buttons["close-place-map"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.otherElements["place-itinerary"].exists || app.scrollViews["place-itinerary"].exists)
      let screenshot = XCTAttachment(screenshot: app.screenshot())
      screenshot.name = "presentation-fullscreen-" + appearance; screenshot.lifetime = .keepAlways; add(screenshot)
      app.buttons["close-place-map"].tap()
      XCTAssertTrue(expand.waitForExistence(timeout: 5))
      app.swipeUp()
      XCTAssertTrue(app.staticTexts["Places worth a visit"].waitForExistence(timeout: 5))
      app.terminate()
    }
  }
  func testExtremeFiniteRouteDurationKeepsConversationUsable() async throws {
    continueAfterFailure = false
    let base = ProcessInfo.processInfo.environment["PRESENTATION_SERVER"] ?? "http://127.0.0.1:20180"
    func post(_ path: String, _ body: [String: Any]) async throws {
      var request = URLRequest(url: URL(string: base + path)!)
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
      let (_, response) = try await URLSession.shared.data(for: request)
      XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }
    for duration in [120.0, 1e100] {
      try await post("/__qa/reset", [:])
      try await post("/__qa/content", ["scene": "plain-link"])
      let presentation: [String: Any] = ["version": 1,
        "places": [["id": "qa-start", "name": "Synthetic Start", "latitude": 10.0, "longitude": -40.0],
          ["id": "qa-end", "name": "Synthetic End", "latitude": 10.001, "longitude": -39.999]],
        "blocks": [["type": "place_map", "placeIds": ["qa-start", "qa-end"], "route": ["mode": "walking",
          "geometry": ["type": "LineString", "coordinates": [[-40.0, 10.0], [-39.999, 10.001]]],
          "distanceMeters": 100.0, "durationSeconds": duration,
          "legs": [["fromPlaceId": "qa-start", "toPlaceId": "qa-end", "distanceMeters": 100.0, "durationSeconds": duration]]]]]]
      try await post("/__qa/update-message", ["id": "content-fixture", "content": "", "metadata": ["type": "presentation", "presentation": presentation]])
      let app = XCUIApplication()
      app.launchArguments = ["--ui-testing", "--server", base, "--open-channel", "channel-research"]
      app.launch()
      XCTAssertTrue(app.buttons["expand-place-map"].waitForExistence(timeout: 15))
      XCTAssertEqual(app.state, .runningForeground)
      XCTAssertTrue(app.buttons["place-card-qa-end"].exists, "The destination card formats the route leg")
      app.terminate()
    }
  }
}
