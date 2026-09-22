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
  func testFocusedOrdinaryRepliesDoNotChangeThreadMembership() {
    let root = message("1"), ordinary = message("2", reply: "1"), branch = message("3", reply: "1", branch: true)
    let unrelated = message("4", reply: "missing"), nested = message("5", reply: "2")
    let all = [nested, branch, unrelated, root, ordinary]
    XCTAssertEqual(ThreadProjection.messages(root: root, in: all).map(\.id), ["1", "3"])
    XCTAssertEqual(ThreadProjection.messages(root: root, in: all, includeInlineReplies: true).map(\.id), ["1", "2", "3", "5"])
    XCTAssertEqual(MessageTimeline(all).entries.map(\.id), ["5", "4", "1", "2"])
    XCTAssertEqual(MessageTimeline([root, branch], includeBranched: true).entries.map(\.id), ["1", "3"])
    XCTAssertEqual(ThreadProjection.replyCounts(in: all), ["1": 1])
  }
  func testMainTimelineGroupsServerForkResponsesUnderTheUserReply() {
    let root = message("1", sender: "agent")
    let reply = message("2", reply: "1", branch: true)
    // The live server inherits the triggering USER message's ID, not the
    // original root, when the bot answers a forked delivery.
    let response = message("3", reply: "2", branch: true, sender: "agent")
    let followup = message("4", reply: "2", branch: true, sender: "agent")
    let continued = message("5", reply: "4", branch: true, sender: "agent")
    let unrelated = message("6", sender: "agent")
    let resumed = message("7", reply: "2", branch: true, sender: "agent")
    let nested = message("8", reply: "3", branch: true)
    let all = [root, reply, response, followup, continued, unrelated, resumed, nested]
    let timeline = MessageTimeline(all, includeBranched: true)
    XCTAssertEqual(timeline.entries.map(\.showsReplyContext), [false, true, false, false, false, false, true, true])
    XCTAssertEqual(ThreadProjection.messages(root: root, in: all).map(\.id), ["1", "2", "3", "4", "5", "7", "8"])
  }
  func testBrokenAndCyclicReplyChainsAreExcluded() {
    let root = message("root")
    let all = [root, message("a", reply: "b"), message("b", reply: "a"), message("orphan", reply: "missing")]
    XCTAssertEqual(ThreadProjection.messages(root: root, in: all, includeInlineReplies: true).map(\.id), ["root"])
  }
  func testExistingDraftsDecodeAndCustomAnswerRetryIdentityPersists() throws {
    let old = Data(#"{"text":"Unsent","attachments":[],"isFork":false}"#.utf8)
    var draft = try JSONDecoder().decode(Draft.self, from: old)
    XCTAssertNil(draft.widgetResponse)
    draft.widgetSelections = ["widget": ["primary"]]
    draft.widgetResponse = WidgetComposerResponse(messageID: "widget", value: "primary\nGamma", clientID: "stable-id")
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
