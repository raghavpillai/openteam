import XCTest
@testable import OpenTeamCore

final class QuestionLifecycleTests: XCTestCase {
  private func row(_ id: String, user: Bool = false, metadata: JSON? = nil) -> Message {
    Message(id: id, sequence: id, channelId: "chat", sender: user ? "user" : "agent",
      senderBotId: user ? nil : "bot", content: user ? "Blue" : "Color?",
      metadata: metadata ?? .object(["type": .string("widget"), "widget": .object([
        "prompt": .string("Color?"), "options": .array([.object(["label": .string("Blue")])])])]),
      createdAt: "2026-11-01T12:00:00Z")
  }
  func testTypedAnswerDismissesWithoutRecordingStructuredAnswer() {
    let q = row("1"), user = row("2", user: true, metadata: .object(["type": .string("text")]))
    let projected = QuestionLifecycle.project([q, user])
    XCTAssertTrue(projected[0].metadata["widgetDismissed"].bool)
    XCTAssertEqual(projected[0].metadata["respondedValue"], .null)
    XCTAssertNil(QuestionLifecycle.current(projected))
    XCTAssertEqual(QuestionLifecycle.current([q])?.id, q.id)
    XCTAssertFalse(q.metadata["widgetDismissed"].bool)
    XCTAssertEqual(QuestionLifecycle.project(projected), projected)
  }
  func testOptimisticSendAndDefiniteFailureRestoreQuestion() {
    let q = row("1")
    var send = PendingSend(channelId: "chat", input: SendInput(content: "New topic", attachments: []))
    XCTAssertNil(QuestionLifecycle.current([q], pending: [send]))
    send.failure = "Rejected"
    XCTAssertEqual(QuestionLifecycle.current([q], pending: [send])?.id, q.id)
    send.deliveryUnconfirmed = true
    XCTAssertNil(QuestionLifecycle.current([q], pending: [send]))
  }
  func testHistoryNavigationAndFreshQuestionDoNotReopenOldCards() {
    var old = row("1")
    old.metadata["widgetDismissed"] = .bool(true)
    var answered = row("2")
    answered.metadata["respondedValue"] = .string("Blue")
    let fresh = row("3")
    let projected = QuestionLifecycle.project([old, answered, fresh])
    XCTAssertEqual(projected[1].metadata["respondedValue"], .string("Blue"))
    XCTAssertEqual(QuestionLifecycle.current(projected)?.id, fresh.id)
    XCTAssertEqual(QuestionLifecycle.project([old] + Array(projected.dropFirst())), projected)
  }
  func testStaleHistoryRetainsSettlementButReceivesOtherUpdates() {
    for settlement: JSON in [.object(["respondedValue": .string("Blue")]), .object(["widgetDismissed": .bool(true)])] {
      var held = row("1")
      for (key, value) in settlement.object { held.metadata[key] = value }
      var stale = row("1")
      stale.metadata["reactions"] = .array([.string("new")])
      let merged = MessageMerge.merge([held], [stale])
      XCTAssertNil(QuestionLifecycle.current(merged))
      XCTAssertEqual(merged[0].metadata["reactions"], stale.metadata["reactions"])
      for (key, value) in settlement.object { XCTAssertEqual(merged[0].metadata[key], value) }
    }
  }
  func testBranchAndApprovalAreIndependent() {
    let q = row("1")
    var branch = row("2")
    branch.metadata["branched"] = .bool(true)
    branch.metadata["questionScopeId"] = .string("thread")
    let user = row("3", user: true, metadata: .object([
      "type": .string("text"), "branched": .bool(true), "questionScopeId": .string("thread")]))
    let approval = row("4", metadata: .object(["type": .string("external-draft"), "cardState": .string("pending")]))
    let result = QuestionLifecycle.project([q, branch, user, approval])
    XCTAssertEqual(result[0], q)
    XCTAssertTrue(result[1].metadata["widgetDismissed"].bool)
    XCTAssertEqual(result[3], approval)
    XCTAssertEqual(QuestionLifecycle.current(result)?.id, q.id)
  }
  func testNewQuestionRetiresPredecessorBeforeItsUpdateArrives() {
    let older = row("1"), fresh = row("2")
    let projected = QuestionLifecycle.project([older, fresh])
    XCTAssertTrue(projected[0].metadata["widgetDismissed"].bool)
    XCTAssertEqual(projected[0].metadata["widgetDismissalReason"].string, "superseded")
    XCTAssertEqual(projected[1], fresh)
    XCTAssertEqual(QuestionLifecycle.current(projected)?.id, fresh.id)
    XCTAssertFalse(older.metadata["widgetDismissed"].bool)
  }
  func testReceiptSurvivesWindowReplacementAndStaleContext() {
    var receipts = QuestionReceiptCache()
    var answered = row("1")
    answered.metadata["respondedValue"] = .string("Blue")
    _ = receipts.merge([], [answered])
    _ = receipts.merge([], []) // A new context evicts the old visible window.
    var stale = row("1")
    stale.metadata["reactions"] = .array([.string("new")])
    let restored = receipts.merge([], [stale])
    XCTAssertEqual(restored[0].metadata["respondedValue"], .string("Blue"))
    XCTAssertEqual(restored[0].metadata["reactions"], stale.metadata["reactions"])
    XCTAssertNil(QuestionLifecycle.current(restored))
  }
  func testSeededDelayedDuplicatePagesNeverReopenReceipts() {
    for seed in 1...100 {
      var randomState = UInt32(seed)
      func random(_ n: UInt32) -> Int {
        randomState ^= randomState << 13; randomState ^= randomState >> 17; randomState ^= randomState << 5
        return Int(randomState % n)
      }
      var receipts = QuestionReceiptCache()
      var canonical: [String: JSON] = [:]
      var known: [String: JSON] = [:]
      var window: [Message] = []
      for step in 0..<80 {
        let id = String(random(12) + 1)
        var incoming = row(id)
        if random(3) == 0 {
          if canonical[id] == nil {
            canonical[id] = random(2) == 0 ? .object(["respondedValue": .string("Blue")])
              : .object(["widgetDismissed": .bool(true), "widgetDismissalReason": .string("dismissed")])
          }
          for (key, value) in canonical[id]!.object { incoming.metadata[key] = value }
          known[id] = canonical[id]
        }
        window = receipts.merge(random(3) == 0 ? [] : window, [incoming, incoming])
        for message in window {
          for (key, value) in known[message.id]?.object ?? [:] {
            XCTAssertEqual(message.metadata[key], value, "seed=\(seed) step=\(step)")
          }
        }
      }
      XCTAssertLessThanOrEqual(receipts.count, 500)
      XCTAssertLessThanOrEqual(receipts.bytes, 256 * 1024)
    }
  }
  func testReceiptBoundsAndChannelIsolation() {
    var receipts = QuestionReceiptCache(limit: 3, maxBytes: 1800)
    for i in 1...20 {
      var answered = row(String(i))
      answered.metadata["respondedValue"] = .string(String(repeating: "x", count: 100))
      receipts.observe([answered])
    }
    XCTAssertLessThanOrEqual(receipts.count, 3)
    XCTAssertLessThanOrEqual(receipts.bytes, 1800)
    var other = row("20"); other.channelId = "other"
    XCTAssertEqual(receipts.restore(other), other)
  }

}
