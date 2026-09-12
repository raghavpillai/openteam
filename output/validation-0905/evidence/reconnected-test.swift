import XCTest
final class ValidationUITests: XCTestCase {
 func testQueuedDeliveryReconcilesAfterReconnect() {
  let app=XCUIApplication(bundleIdentifier:"dev.openbot.mobile");app.launch()
  let row=app.buttons.matching(NSPredicate(format:"label BEGINSWITH %@","QA Alpha 0905.")).firstMatch
  XCTAssertTrue(row.waitForExistence(timeout:25));row.tap()
  let reply=app.descendants(matching:.any).matching(NSPredicate(format:"label CONTAINS %@","QA_OFFLINE_REPLY_0905")).firstMatch
  XCTAssertTrue(reply.waitForExistence(timeout:45))
  let a=XCTAttachment(screenshot:app.screenshot());a.name="offline-reconnected";a.lifetime = .keepAlways;add(a)
 }
}
