import XCTest

@testable import OpenTeamCore

final class InboxUnreadPositionTests: XCTestCase {
  private let rows = (0..<12).map { "row-\($0)" }

  func testVisibleUnreadRowsDoNotContribute() {
    let result = InboxUnreadPosition(orderedIDs: rows,
      visibleIDs: Set(rows[0...5]), unreadIDs: ["row-0", "row-3", "row-5"])
    XCTAssertEqual(result.above, [])
    XCTAssertEqual(result.below, [])
  }

  func testBothDirectionsCountConversationsAndChooseNearestInRenderedOrder() {
    let result = InboxUnreadPosition(orderedIDs: rows,
      visibleIDs: Set(rows[4...7]),
      unreadIDs: ["row-0", "row-3", "row-4", "row-7", "row-8", "row-11"])
    XCTAssertEqual(result.above, ["row-0", "row-3"])
    XCTAssertEqual(result.below, ["row-8", "row-11"])
    XCTAssertEqual(result.nearestAbove, "row-3")
    XCTAssertEqual(result.nearestBelow, "row-8")
  }

  func testPartiallyVisibleEdgeRowsAreExcludedWhenNativeVisibilityIncludesThem() {
    let result = InboxUnreadPosition(orderedIDs: rows,
      visibleIDs: Set(rows[3...8]), unreadIDs: ["row-2", "row-3", "row-8", "row-9"])
    XCTAssertEqual(result.above, ["row-2"])
    XCTAssertEqual(result.below, ["row-9"])
  }

  func testCollapsedAndFilteredRowsAndStaleVisibilityAreIgnored() {
    let result = InboxUnreadPosition(orderedIDs: ["row-1", "row-4", "row-9"],
      visibleIDs: ["row-4", "removed"], unreadIDs: Set(rows))
    XCTAssertEqual(result.above, ["row-1"])
    XCTAssertEqual(result.below, ["row-9"])
  }

  func testNoVisibleRowsDoesNotGuessADirection() {
    for visible: Set<String> in [[], ["removed"]] {
      let result = InboxUnreadPosition(orderedIDs: rows,
        visibleIDs: visible, unreadIDs: Set(rows))
      XCTAssertNil(result.nearestAbove)
      XCTAssertNil(result.nearestBelow)
    }
  }

  func testPinnedStripIsOneVerticalPosition() {
    let unread: Set<String> = ["pin-1", "pin-2", "row-1", "row-11"]
    let result = InboxUnreadPosition(orderedIDs: ["pin-1", "pin-2"] + rows,
      visibleIDs: ["pin-1", "pin-2", "row-0", "row-1"], unreadIDs: unread)
    XCTAssertEqual(result.above, [])
    XCTAssertEqual(result.below, ["row-11"])
    let afterScroll = InboxUnreadPosition(orderedIDs: ["pin-1", "pin-2"] + rows,
      visibleIDs: Set(rows[8...11]), unreadIDs: unread)
    XCTAssertEqual(afterScroll.above, ["pin-1", "pin-2", "row-1"])
    XCTAssertEqual(afterScroll.below, [])
  }
}
