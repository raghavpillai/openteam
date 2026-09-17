import XCTest

@testable import OpenTeamCore

final class HapticFeedbackTests: XCTestCase {
  func testAppFeedbackRequiresBothPreferenceAndForeground() {
    XCTAssertFalse(HapticPolicy.allows(enabled: false, active: true))
    XCTAssertFalse(HapticPolicy.allows(enabled: true, active: false))
    XCTAssertFalse(HapticPolicy.allows(enabled: false, active: false))
    XCTAssertTrue(HapticPolicy.allows(enabled: true, active: true))
  }
  func testScrollCoordinatesIncludeTopSafeAreaOnlyOnce() {
    // Measured iOS 26 floating bars: 118 top / 78 bottom, 760 usable viewport.
    XCTAssertEqual(
      ScrollEdgeFeedback.remaining(content: 934, viewport: 760, offset: -118, topInset: 118), 174)
    XCTAssertEqual(
      ScrollEdgeFeedback.remaining(content: 934, viewport: 760, offset: 56, topInset: 118), 0)
    XCTAssertEqual(
      ScrollEdgeFeedback.remaining(content: 934, viewport: 760, offset: 70, topInset: 118), -14)
    XCTAssertEqual(
      ScrollEdgeFeedback.remaining(content: 934, viewport: 760, offset: -130, topInset: 118), 174)
  }
  func testReplyThresholdHysteresisAndOnePulsePerGesture() {
    var swipe = ReplySwipeFeedback()
    XCTAssertFalse(swipe.move(51))
    XCTAssertTrue(swipe.move(52))
    XCTAssertFalse(swipe.move(90))
    XCTAssertFalse(swipe.move(43))
    let result = swipe.release(43, velocity: 0)
    XCTAssertTrue(result.open)
    XCTAssertFalse(result.signal)
    XCTAssertTrue(swipe.move(52))
    XCTAssertFalse(swipe.move(39))
    XCTAssertFalse(swipe.release(39, velocity: 0).open)
  }
  func testFastReplySignalsAtReleaseAndCancelledGestureResets() {
    var swipe = ReplySwipeFeedback()
    XCTAssertFalse(swipe.move(30))
    let fast = swipe.release(30, velocity: 650)
    XCTAssertTrue(fast.open)
    XCTAssertTrue(fast.signal)
    XCTAssertFalse(swipe.release(23, velocity: 900).open)
    XCTAssertFalse(swipe.release(30, velocity: 649).open)
    XCTAssertTrue(swipe.move(52))
    swipe.reset()
    XCTAssertFalse(swipe.release(0, velocity: 0).open)
    XCTAssertTrue(swipe.move(52))
  }
  func testScrollFeedbackExcludesLayoutJitterShortContentAndRepeats() {
    var scroll = ScrollEdgeFeedback()
    XCTAssertFalse(scroll.observe(remaining: 100, scrollable: true))
    XCTAssertFalse(scroll.observe(remaining: 0, scrollable: true))
    scroll.begin()
    XCTAssertFalse(scroll.observe(remaining: 23, scrollable: true))
    XCTAssertFalse(scroll.observe(remaining: 0, scrollable: true))
    XCTAssertFalse(scroll.observe(remaining: 24, scrollable: true))
    XCTAssertFalse(scroll.observe(remaining: 3, scrollable: true))
    XCTAssertTrue(scroll.observe(remaining: 2, scrollable: true))
    XCTAssertFalse(scroll.observe(remaining: -10, scrollable: true))
    scroll.end()
    XCTAssertFalse(scroll.observe(remaining: 0, scrollable: true))
    scroll.begin()
    XCTAssertFalse(scroll.observe(remaining: 30, scrollable: false))
    XCTAssertFalse(scroll.observe(remaining: 0, scrollable: false))
    XCTAssertFalse(scroll.observe(remaining: 30, scrollable: true))
    XCTAssertTrue(scroll.observe(remaining: 0, scrollable: true))
  }
}
