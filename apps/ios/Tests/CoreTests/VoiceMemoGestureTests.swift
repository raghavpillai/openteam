import XCTest

@testable import OpenTeamCore

final class VoiceMemoGestureTests: XCTestCase {
  func testCancelTakesOverAQuarterOfTheBar() {
    let t = VoiceHoldThresholds()
    XCTAssertEqual(t.cancelDistance(barWidth: 342), 95.76, accuracy: 0.001)
    XCTAssertGreaterThan(t.cancelDistance(barWidth: 342) / 342, 0.25)
    XCTAssertEqual(t.cancelDistance(barWidth: 600), 168, accuracy: 0.001)
    // Narrow or unmeasured bars still need a deliberate slide.
    XCTAssertEqual(t.cancelDistance(barWidth: 200), 80)
    XCTAssertEqual(t.cancelDistance(barWidth: 0), 80)
  }

  func testSlidingLeftBuildsGraduallyAndArmsAtTheFullDistance() {
    var hold = VoiceHoldTracker(barWidth: 342)
    XCTAssertNil(hold.move(dx: -8, dy: 0))
    XCTAssertEqual(hold.axis, .undecided)
    XCTAssertNil(hold.move(dx: -40, dy: -5))
    XCTAssertEqual(hold.axis, .horizontal)
    XCTAssertEqual(hold.dy, 0, "the locked axis ignores vertical drift")
    XCTAssertEqual(hold.cancelProgress, 40 / 95.76, accuracy: 0.001)
    XCTAssertFalse(hold.cancelArmed)
    XCTAssertNil(hold.move(dx: -85, dy: -90), "upward travel cannot lock once the gesture is horizontal")
    XCTAssertFalse(hold.cancelArmed, "a quarter of the bar isn't far enough yet")
    XCTAssertNil(hold.move(dx: -96, dy: 0))
    XCTAssertTrue(hold.cancelArmed, "Release to Cancel at the full 95.76 pt")
    XCTAssertNil(hold.move(dx: -200, dy: 0), "cancel happens on release, never mid-gesture")
    XCTAssertEqual(hold.cancelProgress, 1)
    XCTAssertNil(hold.move(dx: -50, dy: 0))
    XCTAssertFalse(hold.cancelArmed, "sliding back disarms")
    XCTAssertNil(hold.resolved)
  }

  func testSlidingUpLocksAt70PointsAndIgnoresHorizontalTravel() {
    var hold = VoiceHoldTracker(barWidth: 342)
    XCTAssertNil(hold.move(dx: -3, dy: -12))
    XCTAssertEqual(hold.axis, .vertical)
    XCTAssertNil(hold.move(dx: -150, dy: -69), "a vertical gesture cannot arm cancel")
    XCTAssertEqual(hold.dx, 0)
    XCTAssertFalse(hold.cancelArmed)
    XCTAssertEqual(hold.lockProgress, 69 / 70, accuracy: 0.001)
    XCTAssertEqual(hold.move(dx: 0, dy: -70), .lock)
    XCTAssertEqual(hold.lockProgress, 1)
    XCTAssertNil(hold.move(dx: 0, dy: -90), "the lock fires once")
  }

  func testDriftRightOrDownNeverChoosesAnAxis() {
    var hold = VoiceHoldTracker(barWidth: 342)
    XCTAssertNil(hold.move(dx: 40, dy: 30))
    XCTAssertEqual(hold.axis, .undecided)
    XCTAssertEqual(hold.dx, 0)
    XCTAssertEqual(hold.dy, 0)
    XCTAssertFalse(hold.isSliding)
    XCTAssertEqual(hold.move(dx: 10, dy: -80), .lock, "the finger can still lock after drifting")
  }

  func testDominantDirectionWinsWhenBothExceedTheAxisLock() {
    var hold = VoiceHoldTracker(barWidth: 342)
    hold.move(dx: -14, dy: -11)
    XCTAssertEqual(hold.axis, .horizontal)
    var vertical = VoiceHoldTracker(barWidth: 342)
    vertical.move(dx: -11, dy: -14)
    XCTAssertEqual(vertical.axis, .vertical)
    XCTAssertTrue(vertical.isSliding)
  }

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

  func testDurationLabel() {
    XCTAssertEqual(VoiceMemoText.duration(0), "0:00")
    XCTAssertEqual(VoiceMemoText.duration(9.9), "0:09")
    XCTAssertEqual(VoiceMemoText.duration(72), "1:12")
    XCTAssertEqual(VoiceMemoText.duration(-1), "0:00")
  }

  func testLevelNormalisation() {
    XCTAssertEqual(VoiceLevel.normalized(decibels: -160), 0)
    XCTAssertEqual(VoiceLevel.normalized(decibels: -50), 0)
    XCTAssertEqual(VoiceLevel.normalized(decibels: -25), 0.5, accuracy: 0.0001)
    XCTAssertEqual(VoiceLevel.normalized(decibels: 0), 1)
    XCTAssertEqual(VoiceLevel.normalized(decibels: 6), 1)
    XCTAssertEqual(VoiceLevel.normalized(decibels: -.infinity), 0)
    XCTAssertEqual(VoiceLevel.normalized(decibels: .nan), 0)
  }

  func testProcessingSweepGathersThenEasesSideToSide() {
    let start = VoiceProcessingSweep.frame(elapsed: 0)
    XCTAssertEqual(start.gather, 0)
    XCTAssertEqual(start.offset, 0)
    XCTAssertEqual(start.heldLevel, 0.5)
    let gathered = VoiceProcessingSweep.frame(elapsed: 0.45)
    XCTAssertEqual(gathered.gather, 1, accuracy: 0.0001)
    // A quarter period after the start the beam is at its right edge and momentarily still.
    let edge = VoiceProcessingSweep.frame(elapsed: 2.2 / 4)
    XCTAssertEqual(edge.offset, 0.85, accuracy: 0.0001)
    XCTAssertEqual(edge.stretch, 0, accuracy: 0.0001)
    let other = VoiceProcessingSweep.frame(elapsed: 2.2 * 3 / 4)
    XCTAssertEqual(other.offset, -0.85, accuracy: 0.0001)
    let crossing = VoiceProcessingSweep.frame(elapsed: 2.2)
    XCTAssertEqual(crossing.offset, 0, accuracy: 0.0001)
    XCTAssertEqual(crossing.stretch, 1, accuracy: 0.0001, "the beam stretches while it moves fastest")
    let still = VoiceProcessingSweep.frame(elapsed: 3, reduceMotion: true)
    XCTAssertEqual(still.offset, 0)
    XCTAssertEqual(still.gather, 1)
  }
}
