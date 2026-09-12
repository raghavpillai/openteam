import XCTest
final class ValidationUITests: XCTestCase {
 func testLiveChatShellDelivery() {
  let app = XCUIApplication(bundleIdentifier: "dev.openbot.mobile")
  app.launch()
  let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "QA Alpha 0905.")).firstMatch
  XCTAssertTrue(row.waitForExistence(timeout: 25)); row.tap()
  let composer = app.textViews.matching(NSPredicate(format: "label BEGINSWITH %@", "Message ")).firstMatch
  XCTAssertTrue(composer.waitForExistence(timeout: 15)); composer.tap()
  composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: (composer.value as? String ?? "").count))
  composer.typeText("QA_SHELL_0905: verify terminal output and delivery")
  let send = app.buttons["Send message"]
  XCTAssertTrue(send.waitForExistence(timeout: 5))
  let keyboard=app.keyboards.firstMatch
  XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
  XCTAssertLessThanOrEqual(send.frame.maxY, keyboard.frame.minY + 1, "Send must remain above the keyboard")
  send.tap()
  let reply = app.descendants(matching: .any).matching(NSPredicate(format:"label CONTAINS %@", "QA_SHELL_OK_0905: terminal execution")).firstMatch
  XCTAssertTrue(reply.waitForExistence(timeout: 60))
  print("VALIDATION_UI_TREE\n" + app.debugDescription)
  let screenshot=XCTAttachment(screenshot:app.screenshot());screenshot.lifetime = .keepAlways;add(screenshot)
 }
}
