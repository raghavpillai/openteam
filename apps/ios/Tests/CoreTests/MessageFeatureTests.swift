import XCTest
@testable import OpenTeamCore

final class MessageFeatureTests: XCTestCase {
  private func json(_ source: String) throws -> JSON { try JSONDecoder().decode(JSON.self, from: Data(source.utf8)) }
  func testFormReceiptProjectsOnlyKnownLabelsAndStatusesNeverValues() throws {
    let metadata = try json(#"{"cardState":"completed","form":{"fields":[{"id":"email","label":"Email"},{"id":"password","label":"Password"}]},"formReceipt":{"fields":[{"id":"email","status":"filled","value":"private@example.invalid"},{"id":"password","status":"held","value":"never-show-this"},{"id":"unrecognized","status":"filled"}]}}"#)
    let outcome = UserFormOutcome(metadata)
    XCTAssertTrue(outcome.needsRecovery)
    XCTAssertEqual(outcome.fields.map(\.label), ["Email", "Password"])
    XCTAssertEqual(outcome.fields.map(\.status), ["Filled", "Held for recovery"])
    XCTAssertFalse(outcome.summary.contains("never-show-this"))
    XCTAssertFalse(outcome.summary.contains("private@example.invalid"))
  }
}

final class HistoryWindowTests: XCTestCase {
  private func message(_ sequence: String) -> Message {
    Message(id: sequence, sequence: sequence, channelId: "chat", sender: "agent", content: sequence,
      metadata: .object([:]), createdAt: "2026-09-19T12:00:00Z")
  }
  func testDistantLatestUpdatesCannotBecomeAdjacentToOlderContext() {
    var window = HistoryWindow(messages: [message("100"), message("160")], hasEarlier: true, hasLater: true)
    XCTAssertFalse(window.contains(message("99")))
    XCTAssertTrue(window.contains(message("120")))
    XCTAssertFalse(window.contains(message("999")))
    window.extend([message("161"), message("220")], earlier: false, hasMore: true)
    XCTAssertTrue(window.contains(message("200")))
    XCTAssertFalse(window.contains(message("999")))
    window.extend([message("221"), message("999")], earlier: false, hasMore: false)
    XCTAssertTrue(window.contains(message("1000")), "Live updates can append after reaching the latest page")
  }
  func testThreadContextBeforeWindowIsNotShownAsAdjacentHistory() {
    var window = HistoryWindow(messages: [message("9007199254740992"), message("9007199254741000")], hasEarlier: true, hasLater: false)
    XCTAssertFalse(window.contains(message("1")))
    window.extend([message("9007199254740980")], earlier: true, hasMore: true)
    XCTAssertTrue(window.contains(message("9007199254740981")))
    XCTAssertEqual(window.lastSequence, "9007199254741000")
  }
}

final class StateWriterTests: XCTestCase {
  func testBackgroundSavesCannotOverwriteNewerDurableDraftAndSendCommit() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let disk = try DiskStore(directory: directory, scope: "test")
    let writer = StateWriter(disk: disk)
    for index in 0..<40 {
      var snapshot = SavedState()
      var draft = Draft(); draft.text = "Draft \(index)"
      snapshot.drafts["chat-a"] = draft
      writer.save(snapshot) { _ in }
    }
    var committed = SavedState()
    var draft = Draft(); draft.text = "Keep this in the other chat"; draft.replyTo = "original"
    committed.drafts["chat-b"] = draft
    committed.outbox = [PendingSend(channelId: "chat-a", input: SendInput(content: "Sent draft", clientId: "nonce"))]
    try writer.saveNow(committed)
    writer.drain()
    let restored = try disk.load()
    XCTAssertNil(restored.drafts["chat-a"])
    XCTAssertEqual(restored.drafts["chat-b"], draft)
    XCTAssertEqual(restored.outbox.map(\.id), ["nonce"])
  }
  func testDrainingBeforeReauthPreventsQueuedWritesFromRestoringClearedData() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let disk = try DiskStore(directory: directory, scope: "test")
    let writer = StateWriter(disk: disk)
    writer.save(SavedState()) { _ in }
    writer.drain()
    try disk.clear()
    XCTAssertFalse(FileManager.default.fileExists(atPath: disk.url.path))
  }
}
