import XCTest

@testable import OpenTeamCore

final class VoiceMemoGestureTests: XCTestCase {
  func testTapsAndShortHoldsLockLongHoldsSendArmedReleasesCancel() {
    let t = VoiceHoldThresholds()
    XCTAssertEqual(t.release(heldFor: nil, cancelArmed: false), .lock, "a tap records hands-free")
    XCTAssertEqual(t.release(heldFor: 0.2, cancelArmed: false), .lock)
    XCTAssertEqual(t.release(heldFor: 0.499, cancelArmed: false), .lock)
    XCTAssertEqual(t.release(heldFor: 0.5, cancelArmed: false), .send)
    XCTAssertEqual(t.release(heldFor: 12, cancelArmed: false), .send)
    XCTAssertEqual(t.release(heldFor: 12, cancelArmed: true), .cancel)
    XCTAssertEqual(t.release(heldFor: 0.3, cancelArmed: true), .cancel)
    XCTAssertEqual(t.holdDelay, 0.18)
    XCTAssertEqual(t.cancelArm, 1, "Release to Cancel only at the full slide")
  }

  func testMessageAppendsTheTranscriptToTheDraft() {
    XCTAssertEqual(VoiceMemoText.message(draft: "", transcript: " Hello there \n"), "Hello there")
    XCTAssertEqual(VoiceMemoText.message(draft: "Draft intro.", transcript: "Hello"), "Draft intro. Hello")
    XCTAssertEqual(VoiceMemoText.message(draft: "Draft intro.  \n", transcript: "Hello"), "Draft intro. Hello")
    XCTAssertEqual(VoiceMemoText.message(draft: "  indented", transcript: "Hello"), "  indented Hello")
    XCTAssertEqual(VoiceMemoText.message(draft: "   ", transcript: "Hello"), "Hello")
    XCTAssertEqual(VoiceMemoText.message(draft: "Keep", transcript: "  "), "Keep")
  }
}
