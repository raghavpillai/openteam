import XCTest
@testable import OpenTeamCore

final class MessageBubblePaletteTests: XCTestCase {
  func testReferenceThemePairsAndNeutralFamilies() {
    let measured = [
      ("#a47952", "86592e", "8c5d31"),
      ("#f23d52", "c82532", "cf2b35"),
      ("#ff7a1a", "d2550a", "cd5309"),
      ("#ff9e12", "c2730b", "c8770c"),
      ("#10b972", "0d9655", "0e9f5a"),
      ("#27baae", "0d9381", "0e9886"),
      ("#4b8efb", "126fd4", "116dd2"),
      ("#925df2", "7442d1", "7845d7"),
      ("#ef479b", "c82779", "cf297e"),
    ]
    for (avatar, light, dark) in measured {
      XCTAssertEqual(MessageBubblePalette.colors(for: avatar)?.light, light)
      XCTAssertEqual(MessageBubblePalette.colors(for: avatar)?.dark, dark)
    }
    XCTAssertEqual(MessageBubblePalette.colors(for: "#4B8EFB")?.dark, "116dd2")
    XCTAssertEqual(MessageBubblePalette.colors(for: "#ff7b1a")?.dark, "cd5309")
    XCTAssertNil(MessageBubblePalette.colors(for: "#242424"))
    XCTAssertNil(MessageBubblePalette.colors(for: "#878787"))
    XCTAssertNil(MessageBubblePalette.colors(for: nil))
    XCTAssertNil(MessageBubblePalette.colors(for: "invalid"))
  }
}
