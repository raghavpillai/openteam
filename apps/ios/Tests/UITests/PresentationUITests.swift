import XCTest

@MainActor final class PresentationUITests: XCTestCase {
  func testRecordPresentationShowcase() async throws {
    guard ProcessInfo.processInfo.environment["PRESENTATION_RECORDING"] == "1" else { throw XCTSkip("Run only when recording the presentation showcase") }
    continueAfterFailure = false
    let base = ProcessInfo.processInfo.environment["PRESENTATION_SERVER"] ?? "http://127.0.0.1:20182"
    func post(_ path: String, _ value: [String:String]) async throws {
      var request = URLRequest(url: URL(string: base + path)!)
      request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: value)
      let (_, response) = try await URLSession.shared.data(for: request)
      XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }
    func pause(_ seconds: Double = 1) { Thread.sleep(forTimeInterval: seconds) }
    for appearance in ["light", "dark"] {
      try await post("/__qa/content", ["scene":"presentation-showcase-map"])
      let app = XCUIApplication()
      app.launchArguments = ["--ui-testing","--server",base,"--appearance",appearance,"--open-channel","channel-research"]
      app.launch()
      let expand = app.buttons["expand-place-map"], first = app.buttons["place-card-map-widget-point-f078aff04d9bd814"]
      XCTAssertTrue(expand.waitForExistence(timeout: 20))
      for _ in 0..<5 { if first.isHittable && expand.isHittable { break }; app.tables["chat-history"].swipeDown() }
      pause(2)
      try await post("/__qa/presentation-recording", ["stage":appearance + "-ready"])
      pause(1.5)
      app.scrollViews["place-carousel"].swipeLeft(); pause(0.8)
      app.scrollViews["place-carousel"].swipeLeft(); pause(0.8)
      app.buttons["place-card-map-widget-point-8a1b2d2832f05b71"].tap()
      XCTAssertTrue(app.buttons["close-place-details"].waitForExistence(timeout: 5)); pause(1.5)
      let detail = XCTAttachment(screenshot: app.screenshot()); detail.name = "showcase-detail-" + appearance; detail.lifetime = .keepAlways; add(detail)
      app.buttons["close-place-details"].tap(); pause(0.5)
      expand.tap()
      XCTAssertTrue(app.buttons["close-place-map"].waitForExistence(timeout: 5)); pause(1)
      let full = XCTAttachment(screenshot: app.screenshot()); full.name = "showcase-fullscreen-" + appearance; full.lifetime = .keepAlways; add(full)
      app.scrollViews["place-itinerary"].swipeUp(); pause(1)
      app.buttons["close-place-map"].tap(); pause(0.6)
      try await post("/__qa/content", ["scene":"presentation-showcase-media"])
      XCTAssertTrue(app.staticTexts["Places worth a visit"].waitForExistence(timeout: 10)); pause(1.5)
      let media = XCTAttachment(screenshot: app.screenshot()); media.name = "showcase-media-" + appearance; media.lifetime = .keepAlways; add(media)
      app.tables["chat-history"].swipeDown(); pause(1)
      try await post("/__qa/presentation-recording", ["stage":appearance + "-end"])
      pause(0.5); app.terminate()
    }
  }
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
}
