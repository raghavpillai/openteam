import XCTest
@testable import OpenTeamCore

final class ReplyPageTests: XCTestCase {
  private func message(_ id: String, reply: String? = nil, branch: Bool = false, sender: String = "user") -> Message {
    var metadata: [String: JSON] = [:]
    if let reply { metadata["replyTo"] = .string(reply) }
    if branch { metadata["branched"] = .bool(true) }
    return Message(id: id, sequence: id, channelId: "chat", sender: sender, content: id,
      metadata: .object(metadata), createdAt: "2026-09-21T12:00:00Z")
  }
  func testMainTimelineKeepsRepliesAndGroupsTheirContext() {
    let root = message("1", sender: "agent")
    let reply = message("2", reply: "1", branch: true)
    let response = message("3", reply: "1", branch: true, sender: "agent")
    let followup = message("4", reply: "1", branch: true, sender: "agent")
    let unrelated = message("5", sender: "agent")
    let resumed = message("6", reply: "1", branch: true, sender: "agent")
    let nested = message("7", reply: "3", branch: true)
    let timeline = MessageTimeline([root, reply, response, followup, unrelated, resumed, nested], includeBranched: true)
    XCTAssertEqual(timeline.entries.map(\.id), ["1", "2", "3", "4", "5", "6", "7"])
    XCTAssertEqual(timeline.entries.map(\.showsReplyContext), [false, true, false, false, false, true, true])
    XCTAssertEqual(ThreadProjection.messages(root: response, in: timeline.entries.map(\.message)).map(\.id), ["3", "7"])
  }
  func testOnlyRepliesAndSendsAfterCatchingUpAnimateIn() {
    var presentation = MessagePresentation()
    // The reader was not there for anything up to 22: the chat's page brought it.
    let live: (Message) -> Bool = { MessageMerge.less("22", $0.sequence) }
    _ = presentation.project(MessageTimeline([message("20")]), pending: [], animateNew: false, isArrival: live)
    let caughtUp = presentation.project(MessageTimeline(["20", "21", "22"].map { message($0) }),
      pending: [], animateNew: true, isArrival: live)
    XCTAssertTrue(caughtUp.allSatisfy { !$0.animatesArrival })
    XCTAssertEqual(presentation.arrivalRevision, 0)
    let timeline = MessageTimeline(["20", "21", "22", "23"].map { message($0) })
    let arrived = presentation.project(timeline, pending: [], animateNew: true, isArrival: live)
    XCTAssertEqual(arrived.map(\.animatesArrival), [false, false, false, true])
    XCTAssertEqual(presentation.arrivalRevision, 1)
    // The reader's own queued send always arrives, even when no reply is live.
    let send = PendingSend(channelId: "chat", input: SendInput(content: "Queued", clientId: "nonce"))
    let queued = presentation.project(timeline, pending: [send], animateNew: true, isArrival: { _ in false })
    XCTAssertEqual(queued.count, 5)
    XCTAssertTrue(queued[4].animatesArrival)
    XCTAssertEqual(presentation.arrivalRevision, 2)
  }
  func testQuestionDraftsKeepCardInputSeparateFromComposerText() throws {
    var draft = try JSONDecoder().decode(Draft.self, from: Data(#"{"text":"Unsent","attachments":[],"isFork":false}"#.utf8))
    XCTAssertNil(draft.widgetCustomAnswers)
    draft.widgetSelections = ["widget": ["primary"]]
    draft.widgetCustomAnswers = ["widget": "Gamma"]
    let restored = try JSONDecoder().decode(Draft.self, from: JSONEncoder().encode(draft))
    XCTAssertEqual(restored, draft)
    XCTAssertEqual(restored.text, "Unsent")
  }
  func testLostWidgetAcknowledgementMatchesOnlyItsOwnReceipt() {
    XCTAssertFalse(WidgetMutationReceipt.accepted(.object([:]), action: "widget-response", clientID: "request"))
    XCTAssertFalse(WidgetMutationReceipt.accepted(.null, action: "widget-dismiss", clientID: "request"))
    XCTAssertTrue(WidgetMutationReceipt.accepted(.object(["accepted": .bool(true)]), action: "widget-response", clientID: "request"))
    let result: JSON = .object(["accepted": .bool(false), "message": .object(["metadata": .object([
      "respondedValue": .string("alpha"), "widgetResponseClientId": .string("request")])])])
    XCTAssertTrue(WidgetMutationReceipt.accepted(result, action: "widget-response", clientID: "request", value: .string("alpha")))
    XCTAssertFalse(WidgetMutationReceipt.accepted(result, action: "widget-response", clientID: "another", value: .string("alpha")))
    XCTAssertFalse(WidgetMutationReceipt.accepted(result, action: "widget-response", clientID: "request", value: .string("beta")))
    XCTAssertFalse(WidgetMutationReceipt.accepted(result, action: "widget-dismiss", clientID: "request"))
  }
}
