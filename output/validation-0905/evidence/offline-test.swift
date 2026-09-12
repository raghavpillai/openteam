import XCTest
final class ValidationUITests: XCTestCase {
 let app=XCUIApplication(bundleIdentifier:"dev.openbot.mobile")
 func alpha() {let row=app.buttons.matching(NSPredicate(format:"label BEGINSWITH %@","QA Alpha 0905.")).firstMatch;XCTAssertTrue(row.waitForExistence(timeout:25));row.tap()}
 func capture(_ name:String) {print("VALIDATION_UI_TREE_\(name)\n"+app.debugDescription);let a=XCTAttachment(screenshot:app.screenshot());a.name=name;a.lifetime = .keepAlways;add(a)}
 func testOfflineQueueSurvivesRelaunch() {
  app.launch();alpha()
  let composer=app.textViews.matching(NSPredicate(format:"label BEGINSWITH %@","Message ")).firstMatch
  XCTAssertTrue(composer.waitForExistence(timeout:10));composer.tap();composer.typeText("QA_OFFLINE_SEND_0905")
  app.buttons["Send message"].tap()
  let pending=app.descendants(matching:.any).matching(NSPredicate(format:"label CONTAINS %@","QA_OFFLINE_SEND_0905")).firstMatch
  XCTAssertTrue(pending.waitForExistence(timeout:15));capture("offline-queued")
  app.terminate();app.launch();alpha()
  XCTAssertTrue(pending.waitForExistence(timeout:20));capture("offline-restored")
 }
}
