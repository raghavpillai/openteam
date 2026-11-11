import XCTest

@MainActor extension XCUIApplication {
  /// Chat navigation uses UIKit's native BackButton on current iOS builds.
  /// Keep the explicit identifier for layouts that still render a custom back.
  var chatBackButton: XCUIElement {
    buttons.matching(NSPredicate(format: "identifier IN {'chat-back', 'BackButton'}")).firstMatch
  }
}
