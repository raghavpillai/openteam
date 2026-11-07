import XCTest
@testable import OpenTeamNative

@MainActor
final class NotificationOpeningTests: SystemIntentFixture {
  private func connectedStore() async throws -> AppStore {
    _ = try await API(server: server).request("/__qa/scene", method: "POST",
      body: .object(["scene": .string("history-pages")]))
    let store = AppStore()
    store.server = server
    await store.connect(username: "", password: "")
    XCTAssertEqual(store.phase, .ready)
    return store
  }
  private func control(_ failures: JSON) async throws {
    _ = try await API(server: server).request("/__qa/control", method: "POST",
      body: .object(["failures": failures]))
  }
  private func requests() async throws -> [JSON] {
    try await API(server: server).request("/__qa/state")["requests"].array
  }
  private func waitForRequest(_ path: String) async throws {
    for _ in 0..<50 {
      if try await requests().contains(where: { $0["path"].string == path }) { return }
      try await Task.sleep(for: .milliseconds(20))
    }
    XCTFail("Request was not started: \(path)")
  }
  func testCachedNotificationTargetOpensWithoutWaitingForTheNetwork() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    await store.loadHistory("visual-chat")
    let target = try XCTUnwrap(store.messages("visual-chat").last)
    let before = try await requests().count
    try await control(.object([
      "GET /api/v0/channels/visual-chat/history": .object(["status": .number(503), "count": .number(100)]),
      "GET /api/v0/channel-messages/*": .object(["status": .number(503), "count": .number(100)]),
    ]))
    let started = ContinuousClock.now
    await store.openNotification("visual-chat", messageID: target.id, sequence: target.sequence)
    XCTAssertLessThan(started.duration(to: .now), .milliseconds(200))
    XCTAssertEqual(store.focusedMessage, target.id)
    XCTAssertEqual(store.navigation, ["visual-chat"])
    let after = try await requests().count
    XCTAssertEqual(after, before)
    XCTAssertNil(store.error)
  }
  func testLegacyNotificationReplacesAnOlderSearchWindow() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    let loaded = await store.loadContext("visual-chat", messageID: "visual-message-visual-chat-90")
    XCTAssertTrue(loaded)
    store.navigation = ["visual-chat"]
    XCTAssertTrue(store.historyWindows["visual-chat"]?.hasLater == true)
    await store.openNotification("visual-chat", messageID: nil, sequence: "180")
    XCTAssertEqual(store.focusedMessage, "visual-message-visual-chat-180")
    XCTAssertTrue(store.visibleMessages("visual-chat").contains { $0.sequence == "180" })
    XCTAssertFalse(store.historyWindows["visual-chat"]?.hasLater == true)
  }
  func testMessageIdentityOpensAnAlertOutsideTheLatestSixtyMessages() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    await store.loadHistory("visual-chat")
    XCTAssertFalse(store.visibleMessages("visual-chat").contains { $0.sequence == "25" })
    await store.openNotification("visual-chat", messageID: "visual-message-visual-chat-25", sequence: "25")
    XCTAssertEqual(store.focusedMessage, "visual-message-visual-chat-25")
    XCTAssertTrue(store.visibleMessages("visual-chat").contains { $0.sequence == "25" })
    XCTAssertTrue(store.historyWindows["visual-chat"]?.hasLater == true)
  }
  func testAnOlderInFlightPageDoesNotForgetANewerNotification() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    await store.loadHistory("visual-chat")
    let api = try API(server: server)
    let oldPage = try await api.request("/api/v0/channels/visual-chat/history")
    try await control(.object([
      "GET /api/v0/channels/visual-chat/history": .object([
        "status": .number(200), "body": oldPage, "delayMs": .number(300), "count": .number(1),
      ]),
    ]))
    let read = Task { await store.loadHistory("visual-chat") }
    try await Task.sleep(for: .milliseconds(50))
    store.noteNotified("visual-chat", sequence: "181")
    await read.value
    XCTAssertTrue(store.transcriptBehind("visual-chat"), "An old response must retain the newer announced sequence")
  }
  func testLegacyAlertResolvesItsSequenceOutsideTheLatestPage() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    await store.loadHistory("visual-chat")
    await store.openNotification("visual-chat", messageID: nil, sequence: "25")
    XCTAssertEqual(store.focusedMessage, "visual-message-visual-chat-25")
    XCTAssertTrue(store.visibleMessages("visual-chat").contains { $0.sequence == "25" })
    let requests = try await requests()
    XCTAssertTrue(requests.contains {
      $0["path"].string.hasSuffix("/history") && $0["query"].string.contains("before=26")
    })
  }
  func testNewerNotificationWinsWhenContextResponsesFinishOutOfOrder() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    let oldID = "visual-message-visual-chat-25"
    let newID = "visual-message-visual-chat-150"
    let path = "/api/v0/channel-messages/\(oldID)/context"
    try await control(.object(["GET " + path: .object(["delayMs": .number(400), "count": .number(1)])]))
    let old = Task { await store.openNotification("visual-chat", messageID: oldID, sequence: "25") }
    try await waitForRequest(path)
    await store.openNotification("visual-chat", messageID: newID, sequence: "150")
    await old.value
    XCTAssertEqual(store.focusedMessage, newID)
    XCTAssertTrue(store.visibleMessages("visual-chat").contains { $0.id == newID })
    XCTAssertFalse(store.visibleMessages("visual-chat").contains { $0.id == oldID })
  }
  func testSlowNotificationContextCannotOverrideAnotherConversation() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    let target = "visual-message-visual-chat-25"
    let path = "/api/v0/channel-messages/\(target)/context"
    try await control(.object(["GET " + path: .object(["delayMs": .number(400), "count": .number(1)])]))
    let opening = Task { await store.openNotification("visual-chat", messageID: target, sequence: "25") }
    try await waitForRequest(path)
    XCTAssertNotNil(store.openingNotification)
    store.navigation = ["another-conversation"]
    await opening.value
    XCTAssertEqual(store.navigation, ["another-conversation"])
    XCTAssertNil(store.openingNotification)
    XCTAssertNil(store.histories["visual-chat"], "A superseded response must not install an old context window")
  }
  func testNotificationContextFailureShowsAnErrorAndCanBeRetried() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    let target = "visual-message-visual-chat-25"
    try await control(.object([
      "GET /api/v0/channel-messages/\(target)/context": .object(["status": .number(503), "count": .number(1)]),
    ]))
    await store.openNotification("visual-chat", messageID: target, sequence: "25")
    XCTAssertNotNil(store.error)
    XCTAssertNil(store.openingNotification)
    XCTAssertTrue(store.navigation.isEmpty)
    store.error = nil
    await store.openNotification("visual-chat", messageID: target, sequence: "25")
    XCTAssertEqual(store.focusedMessage, target)
    XCTAssertEqual(store.navigation, ["visual-chat"])
  }
}
