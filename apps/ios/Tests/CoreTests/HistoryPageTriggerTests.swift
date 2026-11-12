import XCTest
@testable import OpenTeamCore

final class HistoryPageTriggerTests: XCTestCase {
  func testOnlyLoadsInReadingDirectionAndNearActualEdge() {
    var trigger = HistoryPageTrigger()
    XCTAssertNil(trigger.update(firstVisible: 30, lastVisible: 40, count: 100,
      direction: 1, earlier: "1", later: "100"))
    XCTAssertNil(trigger.update(firstVisible: 0, lastVisible: 8, count: 100,
      direction: -1, earlier: "1", later: "100"))
    XCTAssertEqual(trigger.update(firstVisible: 5, lastVisible: 12, count: 100,
      direction: 1, earlier: "1", later: "100"), .earlier)
    XCTAssertEqual(trigger.update(firstVisible: 90, lastVisible: 95, count: 100,
      direction: -1, earlier: "1", later: "100"), .later)
  }
  func testDeduplicatesFailuresUntilLeavingEdge() {
    var trigger = HistoryPageTrigger()
    XCTAssertEqual(trigger.update(firstVisible: 0, lastVisible: 5, count: 100,
      direction: 1, earlier: "60", later: nil), .earlier)
    // Repeated scroll/layout callbacks and an in-flight request do not retry.
    for cursor in ["60", nil, "60"] as [String?] {
      XCTAssertNil(trigger.update(firstVisible: 0, lastVisible: 5, count: 100,
        direction: 1, earlier: cursor, later: nil))
    }
    XCTAssertNil(trigger.update(firstVisible: 20, lastVisible: 30, count: 100,
      direction: 1, earlier: "60", later: nil))
    XCTAssertEqual(trigger.update(firstVisible: 5, lastVisible: 12, count: 100,
      direction: 1, earlier: "60", later: nil), .earlier)
  }
  func testSuccessfulPageAllowsNextCursorButExhaustionStops() {
    var trigger = HistoryPageTrigger()
    for cursor in ["100", "160"] {
      XCTAssertEqual(trigger.update(firstVisible: 90, lastVisible: 99, count: 100,
        direction: -1, earlier: nil, later: cursor), .later)
      XCTAssertNil(trigger.update(firstVisible: 90, lastVisible: 99, count: 100,
        direction: -1, earlier: nil, later: cursor))
    }
    XCTAssertNil(trigger.update(firstVisible: 90, lastVisible: 99, count: 100,
      direction: -1, earlier: nil, later: nil))
  }
  func testInitialLayoutAndShortTranscriptsDoNotFetchBothDirections() {
    var trigger = HistoryPageTrigger()
    XCTAssertNil(trigger.update(firstVisible: 0, lastVisible: 3, count: 4,
      direction: 0, earlier: "10", later: "14"))
    XCTAssertEqual(trigger.update(firstVisible: 0, lastVisible: 3, count: 4,
      direction: -1, earlier: "10", later: "14"), .later)
    XCTAssertEqual(trigger.update(firstVisible: 0, lastVisible: 3, count: 4,
      direction: 1, earlier: "10", later: "14"), .earlier)
  }
}
