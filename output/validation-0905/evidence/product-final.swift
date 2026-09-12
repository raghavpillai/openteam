import XCTest
final class ValidationUITests: XCTestCase {
 let app=XCUIApplication(bundleIdentifier:"dev.openbot.mobile")
 func tap(_ label:String) { let b=app.buttons.matching(NSPredicate(format:"label ==[c] %@",label)).firstMatch;XCTAssertTrue(b.waitForExistence(timeout:20),label);b.tap() }
 func capture(_ name:String) {print("VALIDATION_UI_TREE_\(name)\n"+app.debugDescription);let a=XCTAttachment(screenshot:app.screenshot());a.name=name;a.lifetime = .keepAlways;add(a)}
 func testNativeProductFlows() {
  app.launch()
  let stamp=String(Int(Date().timeIntervalSince1970)).suffix(5)
  let bot="QABot\(stamp)",group="QAGroup\(stamp)"
  tap("New bot or group");tap("New Bot")
  let name=app.textFields.firstMatch;XCTAssertTrue(name.waitForExistence(timeout:10));name.tap();XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout:10));for c in bot {name.typeText(String(c));usleep(70000)};XCTAssertEqual(name.value as? String,bot)
  tap("Create bot")
  let composer=app.textViews.matching(NSPredicate(format:"label BEGINSWITH %@","Message ")).firstMatch
  XCTAssertTrue(composer.waitForExistence(timeout:30));composer.tap();composer.typeText("QA_UI_SEND_0905")
  let send=app.buttons["Send message"];XCTAssertTrue(send.waitForExistence(timeout:10));XCTAssertLessThanOrEqual(send.frame.maxY,app.keyboards.firstMatch.frame.minY+1);capture("composer-above-keyboard");send.tap()
  let reply=app.descendants(matching:.any).matching(NSPredicate(format:"label CONTAINS %@","QA_UI_REPLY_0905")).firstMatch
  XCTAssertTrue(reply.waitForExistence(timeout:60));capture("native-bot-chat")
  tap("Back");tap("New bot or group");tap("New Channel")
  let groupName=app.textFields.firstMatch;XCTAssertTrue(groupName.waitForExistence(timeout:10));groupName.tap();for c in group {groupName.typeText(String(c));usleep(70000)};XCTAssertEqual(groupName.value as? String,group);groupName.typeText("\n")
  for label in ["Add QA Alpha 0905","Add QA Beta 0905"] {let row=app.descendants(matching:.any).matching(NSPredicate(format:"label == %@",label)).firstMatch;XCTAssertTrue(row.waitForExistence(timeout:10));row.tap()}
  tap("Create group")
  let groupComposer=app.textViews.matching(NSPredicate(format:"label BEGINSWITH %@","Message ")).firstMatch
  XCTAssertTrue(groupComposer.waitForExistence(timeout:30));groupComposer.tap();groupComposer.typeText("@all QA_GROUP_SEND_0905")
  tap("Send message")
  let groupReply=app.descendants(matching:.any).matching(NSPredicate(format:"label CONTAINS %@","QA_GROUP_REPLY_0905")).firstMatch
  XCTAssertTrue(groupReply.waitForExistence(timeout:60));capture("native-group-chat")
  tap("Back");tap("Search")
  let search=app.textFields.firstMatch;XCTAssertTrue(search.waitForExistence(timeout:10));search.tap();search.typeText(group)
  let result=app.buttons.matching(NSPredicate(format:"label CONTAINS %@",group)).firstMatch
  XCTAssertTrue(result.waitForExistence(timeout:25));capture("native-search")
  tap("Close search")
  let alpha=app.buttons.matching(NSPredicate(format:"label BEGINSWITH %@","QA Alpha 0905.")).firstMatch
  XCTAssertTrue(alpha.waitForExistence(timeout:15));alpha.tap();tap("Open shared computer")
  let screen=app.descendants(matching:.any).matching(NSPredicate(format:"label == %@","Interactive shared computer")).firstMatch
  XCTAssertTrue(screen.waitForExistence(timeout:30));tap("Computer controls")
  XCTAssertTrue(app.staticTexts["Connected"].waitForExistence(timeout:15));capture("native-linux-computer")
  tap("Back to conversation");tap("Back")
  print("VALIDATION_CREATED_BOT=\(bot)\nVALIDATION_CREATED_GROUP=\(group)")
 }
}
