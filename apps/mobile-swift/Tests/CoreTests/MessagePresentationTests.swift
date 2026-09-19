import XCTest

@testable import OpenTeamCore

final class MessagePresentationTests: XCTestCase {
  func message(
    _ id: String, _ sequence: String, client: String? = nil, at: String = "2026-09-19T12:00:00Z"
  ) -> Message {
    Message(
      id: id, clientId: client, sequence: sequence, channelId: "chat", sender: "user",
      content: "Message", metadata: .object([:]), createdAt: at)
  }
  func testAcknowledgmentKeepsIdentityAndDoesNotStartAnotherArrival() {
    var presentation = MessagePresentation()
    _ = presentation.project(MessageTimeline([]), pending: [], animateNew: false)
    let pending = PendingSend(
      channelId: "chat", input: SendInput(content: "Message", clientId: "nonce"))
    let queued = presentation.project(MessageTimeline([]), pending: [pending], animateNew: true)
    XCTAssertTrue(queued[0].animatesArrival)
    let revision = presentation.arrivalRevision
    let accepted = presentation.project(
      MessageTimeline([message("server-id", "2", client: "nonce")]), pending: [pending],
      animateNew: true)
    XCTAssertEqual(accepted.count, 1)
    XCTAssertEqual(accepted[0].id, queued[0].id)
    XCTAssertEqual(presentation.arrivalRevision, revision)
  }
  func testOpeningHistoryAndLoadingOlderPagesDoNotAnimate() {
    var presentation = MessagePresentation()
    let initial = presentation.project(
      MessageTimeline([message("newer", "20")]), pending: [], animateNew: false)
    XCTAssertFalse(initial[0].animatesArrival)
    let older = presentation.project(
      MessageTimeline([message("older", "10"), message("newer", "20")]), pending: [],
      animateNew: true)
    XCTAssertTrue(older.allSatisfy { !$0.animatesArrival })
    XCTAssertEqual(presentation.arrivalRevision, 0)
    let incoming = presentation.project(
      MessageTimeline([message("newer", "20"), message("arrival", "21")]), pending: [],
      animateNew: true)
    XCTAssertFalse(incoming[0].animatesArrival)
    XCTAssertTrue(incoming[1].animatesArrival)
    XCTAssertEqual(presentation.arrivalRevision, 1)
  }
  func testQueuedTimestampMatchesAcknowledgmentAfterLongGap() throws {
    var presentation = MessagePresentation()
    let earlier = message("earlier", "1")
    _ = presentation.project(MessageTimeline([earlier]), pending: [], animateNew: false)
    let accepted = message("accepted", "2", client: "nonce", at: "2026-09-19T12:20:00Z")
    var pending = PendingSend(
      channelId: "chat", input: SendInput(content: "Message", clientId: "nonce"))
    pending.createdAt = try XCTUnwrap(accepted.date)
    let queued = presentation.project(
      MessageTimeline([earlier]), pending: [pending], animateNew: true)
    let delivered = presentation.project(
      MessageTimeline([earlier, accepted]), pending: [], animateNew: true)
    XCTAssertEqual(queued.last?.timestamp, delivered.last?.timestamp)
    XCTAssertNotNil(queued.last?.timestamp)
  }
}
