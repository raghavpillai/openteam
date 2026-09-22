import XCTest

@testable import OpenTeamCore

final class GroupAvatarLayoutTests: XCTestCase {
  func testPairIsDiagonalInListAndHorizontalInHeader() {
    let list = GroupAvatarLayout(count: 2, size: 48, style: .cluster)
    XCTAssertGreaterThan(list.slots[1].x, list.slots[0].x)
    XCTAssertGreaterThan(list.slots[1].y, list.slots[0].y)
    XCTAssertNil(list.counter)
    let header = GroupAvatarLayout(count: 2, size: 27, style: .inline)
    XCTAssertEqual(header.slots.map(\.y), [0, 0])
    XCTAssertEqual(header.width, 45)
  }
  func testOverflowCountsEveryMemberAfterTheVisibleThree() {
    for count in [3, 4, 5, 6, 12, 103] {
      for style in [GroupAvatarLayout.Style.cluster, .inline] {
        let layout = GroupAvatarLayout(count: count, size: 48, style: style, counterWidth: 50)
        XCTAssertEqual(layout.slots.count, 3)
        XCTAssertEqual(layout.overflow, count - 3)
        XCTAssertEqual(layout.counter == nil, count == 3)
        if let counter = layout.counter {
          XCTAssertGreaterThanOrEqual(layout.width, counter.x + 50)
        }
      }
    }
  }
  func testEmptyAndSingleMemberDoNotInventAnOverflow() {
    for count in [0, 1] {
      let layout = GroupAvatarLayout(count: count, size: 48, style: .cluster)
      XCTAssertEqual(layout.slots.count, count)
      XCTAssertEqual(layout.memberSize, 48)
      XCTAssertEqual(layout.width, 48)
      XCTAssertEqual(layout.overflow, 0)
      XCTAssertNil(layout.counter)
    }
  }
}
