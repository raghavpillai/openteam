import XCTest
@testable import OpenTeamNative

@MainActor
final class NotificationOpeningTests: SystemIntentFixture {
  /// 180 messages in `visual-chat`; only the latest 60 are in the first page.
  private func pagedStore() async throws -> AppStore {
    try await scene("history-pages")
    let store = try await connectedStore()
    XCTAssertFalse(store.launchComplete, "This fixture must not start automatic event polling")
    return store
  }
  private func fail(_ failures: JSON) async throws { try await control(.object(["failures": failures])) }
  private func waitForRequest(_ path: String, query: String? = nil, after count: Int = 0) async throws {
    for _ in 0..<50 {
      if try await requests().dropFirst(count).contains(where: {
        $0["path"].string == path && (query == nil || $0["query"].string.contains(query!))
      }) { return }
      try await Task.sleep(for: .milliseconds(20))
    }
    throw APIError("Request was not started: \(path)")
  }
  func testCachedNotificationTargetOpensWithoutWaitingForTheNetwork() async throws {
    let store = try await pagedStore()
    defer { store.beginReauthentication() }
    await store.loadHistory("visual-chat")
    let target = try XCTUnwrap(store.messages("visual-chat").last)
    let before = try await requests().filter {
      $0["path"].string.hasSuffix("/history") || $0["path"].string.hasSuffix("/context")
    }.count
    try await fail(.object([
      "GET /api/v0/channels/visual-chat/history": .object(["status": .number(503), "count": .number(100)]),
      "GET /api/v0/channel-messages/*": .object(["status": .number(503), "count": .number(100)]),
    ]))
    let started = ContinuousClock.now
    await store.openNotification("visual-chat", messageID: target.id, sequence: target.sequence)
    XCTAssertLessThan(started.duration(to: .now), .milliseconds(200))
    XCTAssertEqual(store.focusedMessage, target.id)
    XCTAssertEqual(store.navigation, ["visual-chat"])
    let after = try await requests().filter {
      $0["path"].string.hasSuffix("/history") || $0["path"].string.hasSuffix("/context")
    }.count
    XCTAssertEqual(after, before)
    XCTAssertNil(store.error)
  }
  func testMessageIdentityOpensAnAlertOutsideTheLatestSixtyMessages() async throws {
    let store = try await pagedStore()
    defer { store.beginReauthentication() }
    await store.loadHistory("visual-chat")
    XCTAssertFalse(store.visibleMessages("visual-chat").contains { $0.sequence == "25" })
    await store.openNotification("visual-chat", messageID: "visual-message-visual-chat-25", sequence: "25")
    XCTAssertEqual(store.focusedMessage, "visual-message-visual-chat-25")
    XCTAssertTrue(store.visibleMessages("visual-chat").contains { $0.sequence == "25" })
    XCTAssertTrue(store.historyWindows["visual-chat"]?.hasLater == true)
  }
  func testNewerNotificationWinsWhenContextResponsesFinishOutOfOrder() async throws {
    let store = try await pagedStore()
    defer { store.beginReauthentication() }
    let oldID = "visual-message-visual-chat-25"
    let newID = "visual-message-visual-chat-150"
    let path = "/api/v0/channel-messages/\(oldID)/context"
    try await fail(.object(["GET " + path: .object(["delayMs": .number(400), "count": .number(1)])]))
    let old = Task { await store.openNotification("visual-chat", messageID: oldID, sequence: "25") }
    try await waitForRequest(path)
    await store.openNotification("visual-chat", messageID: newID, sequence: "150")
    await old.value
    XCTAssertEqual(store.focusedMessage, newID)
    XCTAssertTrue(store.visibleMessages("visual-chat").contains { $0.id == newID })
    XCTAssertFalse(store.visibleMessages("visual-chat").contains { $0.id == oldID })
  }
  func testSlowNotificationContextCannotOverrideAnotherConversation() async throws {
    let store = try await pagedStore()
    defer { store.beginReauthentication() }
    let target = "visual-message-visual-chat-25"
    let path = "/api/v0/channel-messages/\(target)/context"
    try await fail(.object(["GET " + path: .object(["delayMs": .number(400), "count": .number(1)])]))
    let opening = Task { await store.openNotification("visual-chat", messageID: target, sequence: "25") }
    try await waitForRequest(path)
    XCTAssertNotNil(store.openingNotification)
    store.navigation = ["another-conversation"]
    await opening.value
    XCTAssertEqual(store.navigation, ["another-conversation"])
    XCTAssertNil(store.openingNotification)
    XCTAssertNil(store.histories["visual-chat"], "A superseded response must not install an old context window")
  }
}
