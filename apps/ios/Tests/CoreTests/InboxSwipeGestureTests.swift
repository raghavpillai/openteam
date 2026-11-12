import XCTest
@testable import OpenTeamCore

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
