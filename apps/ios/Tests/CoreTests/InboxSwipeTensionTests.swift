import XCTest
@testable import OpenTeamCore

final class InboxSwipeTensionTests: XCTestCase {
  func testSlowSwipesBuildAndReleaseStrengthInBothDirections() {
    for sign in [1.0, -1.0] {
      var feedback = InboxSwipeTensionFeedback()
      feedback.begin(leadingTarget: 100, trailingTarget: 100)
      let positions = [16.0, 32, 48, 62, 74, 84, 92, 98]
      let cues = positions.enumerated().compactMap { i, value in
        feedback.move(sign * value, at: Double(i) * 0.1)
      }
      XCTAssertEqual(cues, [0.12, 0.18, 0.26, 0.36, 0.48, 0.62, 0.78, 0.92])
      let retreat = [94.0, 88, 80, 70, 58, 44, 28].enumerated().compactMap { i, value in
        feedback.move(sign * value, at: 1 + Double(i) * 0.1)
      }
      XCTAssertEqual(retreat, [0.78, 0.62, 0.48, 0.36, 0.26, 0.18, 0.12])
      XCTAssertNil(feedback.move(0, at: 2))
    }
  }
  func testHoldAndTinyBoundaryJitterStayQuietButRetreatAndRecrossRespond() {
    var feedback = InboxSwipeTensionFeedback()
    feedback.begin(leadingTarget: 100, trailingTarget: 100)
    XCTAssertEqual(feedback.move(50, at: 0), 0.26)
    XCTAssertNil(feedback.move(50, at: 1))
    XCTAssertNil(feedback.move(47.9, at: 2))
    XCTAssertNil(feedback.move(48.1, at: 3))
    XCTAssertEqual(feedback.move(20, at: 4), 0.12)
    XCTAssertEqual(feedback.move(49, at: 5), 0.26)
  }
  func testFastSwipeCoalescesLevelsAndRateLimitsPulses() {
    var feedback = InboxSwipeTensionFeedback()
    feedback.begin(leadingTarget: 100, trailingTarget: 100)
    XCTAssertEqual(feedback.move(17, at: 0), 0.12)
    XCTAssertNil(feedback.move(35, at: 0.01))
    XCTAssertNil(feedback.move(50, at: 0.02))
    XCTAssertEqual(feedback.move(99, at: 0.06), 0.92)
    XCTAssertNil(feedback.move(100, at: 0.2))
    XCTAssertEqual(feedback.move(50, at: 0.3), 0.26)
  }
  func testDirectionReversalUsesTheCurrentDistanceOnEachSide() {
    var feedback = InboxSwipeTensionFeedback()
    feedback.begin(leadingTarget: 200, trailingTarget: 100)
    XCTAssertEqual(feedback.move(100, at: 0), 0.26)
    XCTAssertNil(feedback.move(0, at: 0.1))
    XCTAssertEqual(feedback.move(-16, at: 0.2), 0.12)
    XCTAssertEqual(feedback.move(-50, at: 0.3), 0.26)
    XCTAssertEqual(feedback.move(-20, at: 0.4), 0.12)
    XCTAssertEqual(feedback.move(40, at: 0.5), 0.12)
  }
  func testStartingAtAnOpenDetentSeedsFeedbackButAllowsWithdrawal() {
    var feedback = InboxSwipeTensionFeedback()
    feedback.begin(at: -76, leadingTarget: 148, trailingTarget: 148)
    XCTAssertNil(feedback.move(-76, at: 0))
    XCTAssertEqual(feedback.move(-40, at: 0.1), 0.12)
    XCTAssertEqual(feedback.move(-76, at: 0.2), 0.26)
  }
  func testActivationPopSuppressesAnAdjacentResistancePulse() {
    var feedback = InboxSwipeTensionFeedback()
    feedback.begin(leadingTarget: 100, trailingTarget: 100)
    XCTAssertEqual(feedback.move(99, at: 0), 0.92)
    feedback.quiet(at: 0.1)
    XCTAssertNil(feedback.move(80, at: 0.12))
    XCTAssertEqual(feedback.move(80, at: 0.16), 0.48)
  }
  func testResetCancelsFeedbackAndNextGestureStartsFresh() {
    var feedback = InboxSwipeTensionFeedback()
    feedback.begin(leadingTarget: 100, trailingTarget: 100)
    XCTAssertEqual(feedback.move(99, at: 0), 0.92)
    feedback.reset()
    XCTAssertNil(feedback.move(100, at: 1))
    feedback.begin(leadingTarget: 100, trailingTarget: 100)
    XCTAssertEqual(feedback.move(16, at: 2), 0.12)
  }
  func testTinySlowMovementsCanStillCrossAThreshold() {
    var feedback = InboxSwipeTensionFeedback()
    feedback.begin(leadingTarget: 100, trailingTarget: 100)
    var cues: [Double] = []
    for step in 1...200 {
      if let cue = feedback.move(Double(step) * 0.1, at: Double(step) * 0.01) { cues.append(cue) }
    }
    XCTAssertEqual(cues, [0.12])
  }
  func testInvalidCoordinatesOrTargetsCannotEmit() {
    var feedback = InboxSwipeTensionFeedback()
    XCTAssertNil(feedback.move(99, at: 0))
    feedback.begin(leadingTarget: 0, trailingTarget: 100)
    XCTAssertNil(feedback.move(99, at: 0))
    feedback.begin(leadingTarget: 100, trailingTarget: 100)
    XCTAssertNil(feedback.move(.nan, at: 1))
    XCTAssertNil(feedback.move(99, at: .infinity))
    XCTAssertEqual(feedback.move(99, at: 2), 0.92)
  }
}

final class InboxSwipeGestureTests: XCTestCase {
  func testBothSidesFollowTheFingerBeyondTheOldPinStopAtEveryWidth() {
    for width in [200.0, 371, 700] {
      for sign in [1.0, -1.0] {
        var swipe = InboxSwipeGesture()
        swipe.begin(at: 0, width: width)
        for distance in [20.0, 76, 120, width * 0.9, width] {
          _ = swipe.move(to: sign * distance)
          XCTAssertEqual(swipe.offset, sign * distance, accuracy: 0.001)
        }
        _ = swipe.move(to: sign * (width + 100))
        XCTAssertEqual(swipe.offset, sign * (width + 22), accuracy: 0.001)
      }
    }
  }
  func testArmHoldRetreatAndRecrossProduceOnePopPerDeliberateCrossing() {
    for sign in [1.0, -1.0] {
      var swipe = InboxSwipeGesture()
      swipe.begin(at: 0, width: 371)
      XCTAssertFalse(swipe.move(to: sign * (swipe.activationDistance - 1)))
      XCTAssertTrue(swipe.move(to: sign * swipe.activationDistance))
      XCTAssertFalse(swipe.move(to: sign * swipe.activationDistance))
      XCTAssertFalse(swipe.move(to: sign * (swipe.activationDistance - 2)))
      XCTAssertFalse(swipe.move(to: sign * (swipe.resetDistance + 1)))
      XCTAssertNotNil(swipe.armed)
      XCTAssertFalse(swipe.move(to: sign * (swipe.resetDistance - 1)))
      XCTAssertNil(swipe.armed)
      XCTAssertTrue(swipe.move(to: sign * swipe.activationDistance))
    }
  }
  func testOnlyTheArmedSideCommitsAndNeverBeforeRelease() {
    for (sign, side) in [(1.0, InboxSwipeGesture.Side.unread), (-1.0, .pin)] {
      var swipe = InboxSwipeGesture()
      swipe.begin(at: 0, width: 371)
      XCTAssertTrue(swipe.move(to: sign * 180))
      XCTAssertEqual(swipe.armed, side)
      XCTAssertEqual(swipe.release(velocity: 0, cancelled: false), .commit(side))
    }
  }
  func testRetreatBelowResetCancelsCommandEvenAfterItPopped() {
    var swipe = InboxSwipeGesture()
    swipe.begin(at: 0, width: 371)
    _ = swipe.move(to: 200)
    _ = swipe.move(to: 70)
    XCTAssertNil(swipe.armed)
    XCTAssertEqual(swipe.release(velocity: 0, cancelled: false), .settle(76))
    _ = swipe.move(to: 0)
    XCTAssertEqual(swipe.release(velocity: 0, cancelled: false), .settle(0))
  }
  func testDirectReversalDisarmsFirstCommandAndArmsOnlyOppositeCommand() {
    var swipe = InboxSwipeGesture()
    swipe.begin(at: 0, width: 371)
    XCTAssertTrue(swipe.move(to: 180))
    XCTAssertTrue(swipe.move(to: -180))
    XCTAssertEqual(swipe.release(velocity: 0, cancelled: false), .commit(.pin))
  }
  func testVelocityCanRevealButCannotTriggerAnUncrossedCommandOrOppositeSide() {
    var swipe = InboxSwipeGesture()
    swipe.begin(at: 0, width: 371)
    _ = swipe.move(to: -40)
    XCTAssertEqual(swipe.release(velocity: -2000, cancelled: false), .settle(-76))
    XCTAssertEqual(swipe.release(velocity: 2000, cancelled: false), .settle(0))
    _ = swipe.move(to: 4)
    XCTAssertEqual(swipe.release(velocity: 2000, cancelled: false), .settle(0))
  }
  func testCancellationRestoresTheOriginalDetentEvenWhenArmed() {
    var swipe = InboxSwipeGesture()
    swipe.begin(at: -76, width: 371)
    _ = swipe.move(to: -200)
    XCTAssertEqual(swipe.release(velocity: -900, cancelled: true), .settle(-76))
    swipe.reset()
    XCTAssertNil(swipe.armed)
    XCTAssertEqual(swipe.distance, 0)
    swipe.begin(at: 0, width: 200)
    _ = swipe.move(to: 180)
    XCTAssertEqual(swipe.release(velocity: 900, cancelled: true), .settle(0))
  }
  func testInvalidInputCannotArmOrFling() {
    var swipe = InboxSwipeGesture()
    swipe.begin(at: .nan, width: .infinity)
    XCTAssertFalse(swipe.move(to: .nan))
    XCTAssertNil(swipe.armed)
    XCTAssertTrue(swipe.activationDistance.isFinite)
    _ = swipe.move(to: 50)
    XCTAssertEqual(swipe.release(velocity: .nan, cancelled: false), .settle(76))
  }
}
