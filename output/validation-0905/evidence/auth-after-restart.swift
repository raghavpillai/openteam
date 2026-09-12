import XCTest
final class ValidationUITests: XCTestCase {
 func testAuthenticatedSendAfterBackendRestart() {
  let app=XCUIApplication(bundleIdentifier:"dev.openbot.mobile");app.launch()
  let row=app.buttons.matching(NSPredicate(format:"label BEGINSWITH %@","QA Alpha 0905.")).firstMatch
  XCTAssertTrue(row.waitForExistence(timeout:25));row.tap()
  let field=app.textViews.matching(NSPredicate(format:"label BEGINSWITH %@","Message ")).firstMatch
  XCTAssertTrue(field.waitForExistence(timeout:10));field.tap();field.typeText("QA_UI_SEND_0905_AFTER_RESTART")
  app.buttons["Send message"].tap()
  let reply=app.descendants(matching:.any).matching(NSPredicate(format:"label CONTAINS %@","QA_UI_REPLY_0905")).firstMatch
  XCTAssertTrue(reply.waitForExistence(timeout:40))
  let a=XCTAttachment(screenshot:app.screenshot());a.name="authenticated-after-restart";a.lifetime = .keepAlways;add(a)
 }
}
