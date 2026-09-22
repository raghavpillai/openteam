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

  func testGroupingSeparatesSpeakersIdleGapsAndEvents() {
    var presentation = MessagePresentation()
    var first = message("first", "1")
    first.sender = "agent"
    first.senderBotId = "bot-a"
    var second = first
    second.id = "second"
    second.sequence = "2"
    var differentBot = second
    differentBot.id = "different-bot"
    differentBot.sequence = "3"
    differentBot.senderBotId = "bot-b"
    var afterGap = differentBot
    afterGap.id = "after-gap"
    afterGap.sequence = "4"
    afterGap.createdAt = "2026-09-19T12:20:00Z"
    var event = afterGap
    event.id = "event"
    event.sequence = "5"
    event.metadata = .object(["event": .object(["type": .string("name-changed")])])
    var afterEvent = afterGap
    afterEvent.id = "after-event"
    afterEvent.sequence = "6"
    let rows = presentation.project(
      MessageTimeline([first, second, differentBot, afterGap, event, afterEvent]),
      pending: [], animateNew: false)
    XCTAssertEqual(rows.map(\.groupsWithPrevious), [false, true, false, false, false, false])
  }

  func testPendingAndAcceptedMessagesKeepTheSameSpeakerSpacing() throws {
    var presentation = MessagePresentation()
    let earlier = message("earlier", "1")
    var pending = PendingSend(
      channelId: "chat", input: SendInput(content: "Message", clientId: "nonce"))
    pending.createdAt = try XCTUnwrap(earlier.date)
    let queued = presentation.project(
      MessageTimeline([earlier]), pending: [pending], animateNew: true)
    let accepted = presentation.project(
      MessageTimeline([earlier, message("accepted", "2", client: "nonce")]),
      pending: [], animateNew: true)
    XCTAssertTrue(queued[1].groupsWithPrevious)
    XCTAssertEqual(queued[1].groupsWithPrevious, accepted[1].groupsWithPrevious)
  }
}
