import XCTest

@testable import OpenTeamCore

final class NotificationReadTests: XCTestCase {
  func marker(_ message: String, _ activity: String, channel: String = "a")
    -> NotificationReadMarker
  {
    NotificationReadMarker(
      json: .object([
        "channelId": .string(channel), "lastReadSequence": .string(message),
        "lastReadNotificationSequence": .string(activity),
      ]))!
  }
  func push(
    _ kind: String = "message", message: String = "10", activity: String = "20",
    scope: String = "account", channel: String = "a"
  ) -> NativePush {
    NativePush(
      .object([
        "data": .object([
          "kind": .string(kind), "channelId": .string(channel), "notificationScope": .string(scope),
          "messageSequence": .string(message), "notificationSequence": .string(activity),
        ])
      ]))
  }
  func snapshot(_ message: String, _ activity: String, cursor: String, badge: Int) -> JSON {
    .object([
      "cursor": .string(cursor), "badgeCount": .number(Double(badge)),
      "readStates": .array([try! .encode(marker(message, activity))]),
    ])
  }
  func testDesktopReadRemovesOldMessagesButPreservesNewMessagesAndReactions() {
    var reads = NotificationReads(scope: "account")
    reads.merge(marker("10", "19"))
    XCTAssertTrue(reads.hasRead(push()))
    XCTAssertFalse(reads.hasRead(push(message: "11")))
    XCTAssertFalse(reads.hasRead(push("reaction", message: "1")))
    reads.merge(marker("10", "20"))
    XCTAssertTrue(reads.hasRead(push("reaction", message: "1")))
    XCTAssertFalse(reads.hasRead(push("reaction", activity: "21")))
  }
  func testOutOfOrderMarkersNeverRegressEitherCursor() {
    var reads = NotificationReads(scope: "account")
    reads.merge(marker("20", "10"))
    reads.merge(marker("10", "20"))
    reads.merge(marker("0", "0"))
    XCTAssertEqual(reads.markers["a"], marker("20", "20"))
    XCTAssertTrue(reads.hasRead(push("agent-needs-input", message: "", activity: "20")))
    XCTAssertFalse(reads.hasRead(push("agent-needs-input", message: "", activity: "21")))
  }
  func testScopesUnknownKindsMalformedCursorsAndOtherChatsStayIsolated() {
    var reads = NotificationReads(scope: "account")
    reads.merge(marker("100", "100"))
    XCTAssertFalse(reads.hasRead(push(scope: "another-account")))
    XCTAssertFalse(reads.hasRead(push(channel: "b")))
    XCTAssertFalse(reads.hasRead(push("unknown")))
    XCTAssertFalse(reads.hasRead(push("reaction", activity: "-1")))
    XCTAssertFalse(reads.hasRead(push(message: "bad", activity: "bad")))
    XCTAssertFalse(reads.hasRead(push(message: "bad", activity: "1")))
    XCTAssertNil(
      NotificationReadMarker(
        json: .object(["channelId": .string("a"), "lastReadSequence": .string("10")])))
  }
  func testLargeSequencesDoNotLosePrecisionOrUseLexicalOrder() {
    var reads = NotificationReads(scope: "account")
    reads.merge(marker("9223372036854775807", "00009"))
    XCTAssertTrue(reads.hasRead(push(message: "9223372036854775806")))
    XCTAssertFalse(reads.hasRead(push(message: "9223372036854775808")))
    XCTAssertFalse(reads.hasRead(push("reaction", activity: "10")))
    XCTAssertTrue(reads.hasRead(push("reaction", activity: "0009")))
  }
  func testCoalescedSyncSnapshotCatchesUpMultipleChatsAndPersists() throws {
    var reads = NotificationReads(scope: "account")
    let value: JSON = .object([
      "cursor": .string("100"), "badgeCount": .number(0),
      "readStates": .array([
        try! .encode(marker("10", "20")), try! .encode(marker("10", "20", channel: "b")),
      ]),
    ])
    XCTAssertTrue(reads.apply(snapshot: value))
    let restored = try JSONDecoder().decode(
      NotificationReads.self, from: JSONEncoder().encode(reads))
    XCTAssertTrue(restored.hasRead(push()))
    XCTAssertTrue(restored.hasRead(push(channel: "b")))
    XCTAssertEqual(restored.badgeCount, 0)
  }
  func testStaleSnapshotCannotRestoreBadgeAfterNewerReadOrEvent() {
    var reads = NotificationReads(scope: "account")
    XCTAssertTrue(reads.apply(snapshot: snapshot("10", "20", cursor: "100", badge: 1)))
    XCTAssertFalse(reads.apply(snapshot: snapshot("10", "20", cursor: "99", badge: 3)))
    XCTAssertEqual(reads.badgeCount, 1)
    reads.merge(marker("11", "21"))
    XCTAssertFalse(reads.apply(snapshot: snapshot("10", "20", cursor: "101", badge: 3)))
    XCTAssertTrue(reads.apply(snapshot: snapshot("11", "21", cursor: "102", badge: 0)))
    XCTAssertEqual(reads.badgeCount, 0)
    XCTAssertFalse(reads.apply(snapshot: .object([:])))
  }
}
