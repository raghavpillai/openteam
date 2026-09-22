import XCTest

@MainActor final class SettingsNavigationUITests: XCTestCase {
  private let base = "http://127.0.0.1:19992"

  func testAccountRowOpensFromEmptySpaceInBothAppearances() async throws {
    try await checkRow(account: true)
  }

  func testPluginsRowOpensFromEmptySpaceInBothAppearances() async throws {
    try await checkRow(account: false)
  }

  private func checkRow(account: Bool) async throws {
    continueAfterFailure = false
    for appearance in ["dark", "light"] {
      var request = URLRequest(url: URL(string: base + "/__qa/reset")!)
      request.httpMethod = "POST"
      let (_, response) = try await URLSession.shared.data(for: request)
      XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
      let app = XCUIApplication()
      app.launchArguments = ["--ui-testing", "--server", base, "--appearance", appearance]
      app.launch()
      XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 15))
      app.buttons["settings-button"].tap()
      let row = account ? app.buttons["account-settings"] : app.buttons.containing(
        NSPredicate(format: "label BEGINSWITH %@", "Plugins")
      ).firstMatch
      XCTAssertTrue(row.waitForExistence(timeout: 8))
      capture("settings-" + appearance, app)
      // Actual finger coordinates: element.tap() alone can choose a hittable
      // text descendant and miss a dead region in the surrounding row.
      for x in [0.8, 0.5, 0.1, 0.95] {
        row.coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.5)).tap()
        let title = account ? "Account" : "Plugins"
        guard app.navigationBars[title].waitForExistence(timeout: 5) else {
          XCTFail("The entire \(title) row must navigate, including its blank space")
          return
        }
        if account {
          XCTAssertTrue(app.buttons["re-auth"].exists)
        } else {
          XCTAssertTrue(app.textFields["plugin-search"].waitForExistence(timeout: 5))
        }
        capture(title.lowercased() + "-" + appearance, app)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(row.waitForExistence(timeout: 5))
      }
      app.buttons["sheet-close"].tap()
      XCTAssertTrue(app.buttons["settings-button"].waitForExistence(timeout: 5))
      app.buttons["settings-button"].tap()
      XCTAssertTrue(row.waitForExistence(timeout: 5))
      app.terminate()
    }
  }

  private func capture(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
