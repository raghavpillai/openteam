import XCTest

/// Run with the Duo's inner display vertical (hinge orient landscape-left),
/// an iPad in portrait, or a compact iPhone.
@MainActor final class PortraitSidebarUITests: XCTestCase {
  func testPortraitTopControlsAndCompactNavigation() {
    continueAfterFailure = false
    let app = launch()
    let hide = app.buttons["sidebar-toggle"]
    let back = app.buttons["chat-back"]
    XCTAssertTrue(hide.waitForExistence(timeout: 20) || back.waitForExistence(timeout: 5))
    if back.exists {
      back.tap()
      XCTAssertTrue(app.buttons["channel-channel-research"].waitForExistence(timeout: 5))
      XCTAssertFalse(hide.exists)
      return
    }
    XCTAssertGreaterThan(app.frame.height, app.frame.width)
    let history = app.tables["chat-history"]
    XCTAssertTrue(history.waitForExistence(timeout: 10))
    let title = app.buttons["conversation-details"]
    XCTAssertLessThan(title.frame.minY, 40, "No empty status-bar band above the header")
    XCTAssertLessThan(app.buttons["search-button"].frame.minY, 40)
    XCTAssertLessThan(app.buttons["Computer"].frame.minY, 40)
    if UIDevice.current.userInterfaceIdiom == .phone {
      XCTAssertLessThan(app.buttons["Computer"].frame.maxX, app.frame.maxX - 120,
        "Top actions must stay clear of Duo’s clock and connectivity cluster")
    }
    XCTAssertEqual(history.frame.maxX, app.frame.maxX, accuracy: 1,
      "Portrait must reclaim the right control column")
    XCTAssertGreaterThan(app.buttons["settings-button"].frame.minY, app.frame.height * 0.7)
    let width = history.frame.width
    XCTAssertGreaterThan(width, 0)
    capture("portrait-top-controls", app)
    hide.tap()
    let show = app.buttons["chat-sidebar"]
    XCTAssertTrue(show.waitForExistence(timeout: 5))
    XCTAssertEqual(show.label, "Show conversations")
    XCTAssertGreaterThan(history.frame.width, width + 200)
    capture("portrait-full-width", app)
    show.tap()
    XCTAssertTrue(hide.waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["channel-channel-research"].exists)
    XCTAssertFalse(app.buttons["sidebar-dismiss"].exists)
  }

  private func launch() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", "http://127.0.0.1:20116",
      "--appearance", "dark", "--open-channel", "channel-research"]
    app.launch()
    return app
  }

  private func capture(_ name: String, _ app: XCUIApplication) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }
}
