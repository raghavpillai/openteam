import XCTest

@MainActor
final class MobileUpdateUITests: XCTestCase {
  func launch(updateAvailable: Bool, appearance: String = "light") -> XCUIApplication {
    continueAfterFailure = false
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--server", "http://127.0.0.1:19997", "--appearance", appearance,
    ]
    if updateAvailable { app.launchArguments.append("--qa-mobile-update") }
    app.launch()
    XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 15))
    return app
  }

  func capture(_ name: String, _ app: XCUIApplication) {
    // The sheet's labels finish fading in after its controls become hittable.
    Thread.sleep(forTimeInterval: 0.6)
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func testUpdateBadgeAndSettingsNoticeOpenTestFlightWithoutDismissingTheNotice() {
    let app = launch(updateAvailable: true)
    let badge = app.buttons["mobile-update-badge"]
    XCTAssertTrue(badge.waitForExistence(timeout: 5))
    XCTAssertGreaterThanOrEqual(badge.frame.height, 44)
    capture("mobile-update-home-light", app)
    badge.tap()
    XCTAssertTrue(badge.exists)
    app.buttons["settings-button"].tap()
    let update = app.buttons["mobile-update-testflight"]
    XCTAssertTrue(update.waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["OpenTeam 0.2.0 · Build 51"].exists)
    capture("mobile-update-settings-light", app)
    update.tap()
    XCTAssertTrue(update.exists)
    app.buttons["sheet-close"].tap()
    XCTAssertTrue(badge.waitForExistence(timeout: 5))
  }

  func testNoUpdateDoesNotShowABadgeOrNotice() {
    let app = launch(updateAvailable: false)
    XCTAssertFalse(app.buttons["mobile-update-badge"].exists)
    app.buttons["settings-button"].tap()
    XCTAssertTrue(app.buttons["account-settings"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["mobile-update-testflight"].exists)
  }

  func testDarkUpdateNotice() {
    let app = launch(updateAvailable: true, appearance: "dark")
    XCTAssertTrue(app.buttons["mobile-update-badge"].waitForExistence(timeout: 5))
    capture("mobile-update-home-dark", app)
    app.buttons["settings-button"].tap()
    XCTAssertTrue(app.buttons["mobile-update-testflight"].waitForExistence(timeout: 5))
    capture("mobile-update-settings-dark", app)
  }
}
