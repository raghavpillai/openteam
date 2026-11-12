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
