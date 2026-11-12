import XCTest

@testable import OpenTeamCore

final class VoiceMemoGestureTests: XCTestCase {

  func testMessageAppendsTheTranscriptToTheDraft() {
    XCTAssertEqual(VoiceMemoText.message(draft: "", transcript: " Hello there \n"), "Hello there")
    XCTAssertEqual(VoiceMemoText.message(draft: "Draft intro.", transcript: "Hello"), "Draft intro. Hello")
    XCTAssertEqual(VoiceMemoText.message(draft: "Draft intro.  \n", transcript: "Hello"), "Draft intro. Hello")
    XCTAssertEqual(VoiceMemoText.message(draft: "  indented", transcript: "Hello"), "  indented Hello")
    XCTAssertEqual(VoiceMemoText.message(draft: "   ", transcript: "Hello"), "Hello")
    XCTAssertEqual(VoiceMemoText.message(draft: "Keep", transcript: "  "), "Keep")
  }
}
