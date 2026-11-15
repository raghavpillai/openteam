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
    for _ in 0..<150 {
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
  /// Starts the event loop as launch does and waits until it is listening.
  private func watch(_ store: AppStore) async throws {
    let count = try await requests().count
    store.finishLaunch()
    try await waitForRequest("/api/v0/events/poll", after: count)
  }
  /// A reply from the chat's bot, announced by a live event and read by the event loop.
  private func reply(_ text: String, into store: AppStore) async throws -> Message {
    _ = try await API(server: server).request("/__qa/push-message", method: "POST",
      body: .object(["channelId": .string("visual-chat"), "content": .string(text)]))
    for _ in 0..<100 where !store.messages("visual-chat").contains(where: { $0.content == text }) {
      try await Task.sleep(for: .milliseconds(50))
    }
    return try XCTUnwrap(store.messages("visual-chat").first { $0.content == text })
  }
  /// An opening that fetched the chat's newest page has caught up, so the next reply arrives live.
  private func assertFirstReplyAfterFetchedOpeningArrivesLive(viaNotification: Bool) async throws {
    let store = try await pagedStore()
    defer { store.beginReauthentication() }
    try await watch(store)
    if viaNotification {
      await store.openNotification("visual-chat", messageID: "visual-message-visual-chat-180", sequence: "180")
      XCTAssertEqual(store.focusedMessage, "visual-message-visual-chat-180")
    } else {
      await store.open("visual-chat", messageID: "visual-message-visual-chat-180")
    }
    XCTAssertEqual(store.navigation, ["visual-chat"])
    XCTAssertFalse(store.historyWindows["visual-chat"]?.hasLater == true)
    // The chat's view marks it active when it appears; it skips the latest-page
    // read because the opening already fetched this page.
    store.activeChannel = "visual-chat"
    let first = try await reply("First reply after a fetched opening", into: store)
    XCTAssertTrue(store.arrivedLive(first), "The opening had caught up; this reply arrived in front of the reader")
  }
  func testFirstReplyAfterAnOpeningThatFetchedItsPageArrivesLive() async throws {
    try await assertFirstReplyAfterFetchedOpeningArrivesLive(viaNotification: false)
  }
  func testFirstReplyAfterANotificationThatFetchedItsPageArrivesLive() async throws {
    try await assertFirstReplyAfterFetchedOpeningArrivesLive(viaNotification: true)
  }
  func testCachedNotificationTargetCatchesUpBeforeRepliesArriveLive() async throws {
    let store = try await pagedStore()
    defer { store.beginReauthentication() }
    await store.loadHistory("visual-chat")
    let target = try XCTUnwrap(store.messages("visual-chat").last)
    try await watch(store)
    let fetches = { try await self.requests().filter {
      $0["path"].string.hasSuffix("/history") || $0["path"].string.hasSuffix("/context") }.count }
    let before = try await fetches()
    await store.openNotification("visual-chat", messageID: target.id, sequence: target.sequence)
    let after = try await fetches()
    XCTAssertEqual(after, before, "A cached, visible target opens without a fetch")
    store.activeChannel = "visual-chat"
    // Nothing verified this transcript since it was saved, so its first read is
    // a catch-up: a reply it brings is placed without an entrance.
    let first = try await reply("Read by the first sync after a cached opening", into: store)
    XCTAssertFalse(store.arrivedLive(first))
    let second = try await reply("Arrives once the chat has caught up", into: store)
    XCTAssertTrue(store.arrivedLive(second))
  }
}
