import XCTest

/// Opt-in comparison against the separately installed React Native app.
/// Run with -only-testing:OpenTeamNativeUITests/ReferenceCaptureTests after starting Metro.
@MainActor
final class ReferenceCaptureTests: XCTestCase {
  func capture(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
  func testReferenceScreens() async throws {
    continueAfterFailure = false
    var reset = URLRequest(url: URL(string: "http://127.0.0.1:19997/__qa/reset")!)
    reset.httpMethod = "POST"
    _ = try await URLSession.shared.data(for: reset)
    let app = XCUIApplication(bundleIdentifier: "dev.openbot.mobile")
    app.launch()
    let research = app.descendants(matching: .any).matching(
      NSPredicate(format: "label BEGINSWITH %@", "Research.")
    ).firstMatch
    XCTAssertTrue(research.waitForExistence(timeout: 30))
    capture("reference-home-light", app)
    research.tap()
    let input = app.textViews["Ask Research"]
    XCTAssertTrue(input.waitForExistence(timeout: 10))
    capture("reference-chat-light", app)
    input.tap()
    input.typeText("Native keyboard parity")
    capture("reference-keyboard-short", app)
    input.typeText("\nSecond line\nThird line\nFourth line\nFifth line\nSixth line\nSeventh line")
    capture("reference-keyboard-multiline", app)
    app.buttons["Back"].tap()
    app.buttons["Open settings"].tap()
    XCTAssertTrue(app.buttons["Close settings"].waitForExistence(timeout: 10))
    capture("reference-settings-light", app)
  }
}
