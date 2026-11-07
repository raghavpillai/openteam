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
    XCTAssertFalse(store.launchComplete, "This fixture must not start automatic event polling")
    return store
  }
  private func control(_ failures: JSON) async throws {
    _ = try await API(server: server).request("/__qa/control", method: "POST",
      body: .object(["failures": failures]))
  }
  private func requests() async throws -> [JSON] {
    try await API(server: server).request("/__qa/state")["requests"].array
  }
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
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    await store.loadHistory("visual-chat")
    let target = try XCTUnwrap(store.messages("visual-chat").last)
    let before = try await requests().filter {
      $0["path"].string.hasSuffix("/history") || $0["path"].string.hasSuffix("/context")
    }.count
    try await control(.object([
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
  func testRestoredOlderCacheGetsItsContextBeforeLatestReconciliation() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    await store.loadHistory("visual-chat")
    let target = "visual-message-visual-chat-25"
    let loaded = await store.loadContext("visual-chat", messageID: target)
    XCTAssertTrue(loaded)
    // Restart restores saved rows and loaded-channel markers, without the
    // in-memory context bounds. A latest-page install could otherwise drop 25.
    store.histories = [:]
    store.historyWindows = [:]
    XCTAssertTrue(store.hasCachedHistory("visual-chat"))
    await store.openNotification("visual-chat", messageID: target, sequence: "25")
    XCTAssertEqual(store.focusedMessage, target)
    XCTAssertTrue(store.historyWindows["visual-chat"]?.hasLater == true)
    await store.loadHistory("visual-chat")
    XCTAssertTrue(store.visibleMessages("visual-chat").contains { $0.id == target })
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
  private let historyPath = "/api/v0/channels/visual-chat/history"
  private func contextPath(_ sequence: Int) -> String {
    "/api/v0/channel-messages/visual-message-visual-chat-\(sequence)/context"
  }
  private func delay(_ path: String, status: Int? = nil) async throws {
    var response: [String: JSON] = ["delayMs": .number(1000), "count": .number(1)]
    if let status { response["status"] = .number(Double(status)) }
    try await control(.object(["GET " + path: .object(response)]))
  }
  private func assertPreserved(_ store: AppStore, window: HistoryWindow?, rows: [Message],
    cursor: String?, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(store.historyWindows["visual-chat"], window, file: file, line: line)
    XCTAssertEqual(store.messages("visual-chat"), rows, file: file, line: line)
    XCTAssertEqual(store.histories["visual-chat"]?.beforeSequence, cursor, file: file, line: line)
    XCTAssertFalse(store.visibleMessages("visual-chat").isEmpty, file: file, line: line)
    XCTAssertFalse(store.historyLoadFailures.contains("visual-chat"), file: file, line: line)
    XCTAssertEqual(store.phase, .ready, file: file, line: line)
    XCTAssertNil(store.error, file: file, line: line)
  }
  private func olderPageReplacedByNotification(status: Int? = nil) async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    await store.loadHistory("visual-chat")
    XCTAssertEqual(store.histories["visual-chat"]?.beforeSequence, "121")
    let count = try await requests().count
    try await delay(historyPath, status: status)
    let older = Task { await store.loadHistory("visual-chat", older: true) }
    try await waitForRequest(historyPath, query: "before=121", after: count)
    await store.openNotification("visual-chat", messageID: "visual-message-visual-chat-25", sequence: "25")
    let window = store.historyWindows["visual-chat"]
    let rows = store.messages("visual-chat")
    let cursor = store.histories["visual-chat"]?.beforeSequence
    XCTAssertEqual(store.focusedMessage, "visual-message-visual-chat-25")
    XCTAssertTrue(store.busy.contains("history-visual-chat"), "The older response must still be delayed")
    await older.value
    assertPreserved(store, window: window, rows: rows, cursor: cursor)
    XCTAssertEqual(store.focusedMessage, "visual-message-visual-chat-25")
    XCTAssertTrue(store.visibleMessages("visual-chat").contains { $0.sequence == "25" })
    XCTAssertFalse(store.busy.contains("history-visual-chat"))
    // The replacement window can immediately page using its own cursor.
    await store.loadLater("visual-chat")
    XCTAssertTrue(store.visibleMessages("visual-chat").contains { $0.sequence == "105" })
  }
  func testOlderPageCannotMutateANotificationReplacement() async throws {
    try await olderPageReplacedByNotification()
  }
  func testStaleOlderPageErrorCannotSignOutTheReplacementContext() async throws {
    try await olderPageReplacedByNotification(status: 401)
  }
  private func laterPageReplacedByLatest(status: Int? = nil) async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    let loaded = await store.loadContext("visual-chat", messageID: "visual-message-visual-chat-25")
    XCTAssertTrue(loaded)
    let count = try await requests().count
    try await delay(contextPath(45), status: status)
    let later = Task { await store.loadLater("visual-chat") }
    try await waitForRequest(contextPath(45), query: "direction=after", after: count)
    let latest = await store.loadLatest("visual-chat")
    XCTAssertTrue(latest)
    let window = store.historyWindows["visual-chat"]
    let rows = store.messages("visual-chat")
    let cursor = store.histories["visual-chat"]?.beforeSequence
    XCTAssertTrue(store.busy.contains("later-visual-chat"), "The later response must still be delayed")
    await later.value
    assertPreserved(store, window: window, rows: rows, cursor: cursor)
    XCTAssertEqual(store.visibleMessages("visual-chat").last?.sequence, "180")
    XCTAssertFalse(store.busy.contains("later-visual-chat"))
  }
  func testLaterPageCannotMutateALatestReplacement() async throws {
    try await laterPageReplacedByLatest()
  }
  func testStaleLaterPageErrorDoesNotSurfaceInTheLatestWindow() async throws {
    try await laterPageReplacedByLatest(status: 503)
  }
  func testStaleLatestRefreshErrorDoesNotMarkTheNewContextAsFailed() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    await store.loadHistory("visual-chat")
    let count = try await requests().count
    try await delay(historyPath, status: 503)
    let refresh = Task { await store.loadHistory("visual-chat") }
    try await waitForRequest(historyPath, after: count)
    let loaded = await store.loadContext("visual-chat", messageID: "visual-message-visual-chat-25")
    XCTAssertTrue(loaded)
    let window = store.historyWindows["visual-chat"]
    let rows = store.messages("visual-chat")
    let cursor = store.histories["visual-chat"]?.beforeSequence
    await refresh.value
    assertPreserved(store, window: window, rows: rows, cursor: cursor)
  }
  func testOlderAndLaterPagesCanFinishOnTheSameWindow() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    let loaded = await store.loadContext("visual-chat", messageID: "visual-message-visual-chat-90")
    XCTAssertTrue(loaded)
    let count = try await requests().count
    try await delay(historyPath)
    let older = Task { await store.loadHistory("visual-chat", older: true) }
    try await waitForRequest(historyPath, query: "before=70", after: count)
    await store.loadLater("visual-chat")
    XCTAssertEqual(store.visibleMessages("visual-chat").last?.sequence, "170")
    await older.value
    XCTAssertEqual(store.visibleMessages("visual-chat").first?.sequence, "10")
    XCTAssertEqual(store.visibleMessages("visual-chat").last?.sequence, "170")
    XCTAssertEqual(store.histories["visual-chat"]?.beforeSequence, "10")
    XCTAssertTrue(store.historyWindows["visual-chat"]?.hasLater == true)
    XCTAssertNil(store.error)
  }
  func testFailedPagesKeepTheirCursorsForSameWindowRetry() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    let loaded = await store.loadContext("visual-chat", messageID: "visual-message-visual-chat-90")
    XCTAssertTrue(loaded)
    try await control(.object(["GET " + historyPath: .object(["status": .number(503), "count": .number(1)])]))
    await store.loadHistory("visual-chat", older: true)
    XCTAssertEqual(store.histories["visual-chat"]?.beforeSequence, "70")
    XCTAssertFalse(store.historyLoadFailures.contains("visual-chat"))
    await store.loadHistory("visual-chat", older: true)
    XCTAssertEqual(store.visibleMessages("visual-chat").first?.sequence, "10")
    try await control(.object(["GET " + contextPath(110): .object(["status": .number(503), "count": .number(1)])]))
    await store.loadLater("visual-chat")
    XCTAssertNotNil(store.error)
    XCTAssertEqual(store.visibleMessages("visual-chat").last?.sequence, "110")
    store.error = nil
    await store.loadLater("visual-chat")
    XCTAssertEqual(store.visibleMessages("visual-chat").last?.sequence, "170")
    XCTAssertNil(store.error)
  }
  func testSlowLatestCannotReplaceANewerNotificationContext() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    let loaded = await store.loadContext("visual-chat", messageID: "visual-message-visual-chat-90")
    XCTAssertTrue(loaded)
    let count = try await requests().count
    try await delay(historyPath)
    let latest = Task { await store.loadLatest("visual-chat") }
    try await waitForRequest(historyPath, after: count)
    await store.openNotification("visual-chat", messageID: "visual-message-visual-chat-25", sequence: "25")
    let window = store.historyWindows["visual-chat"]
    let rows = store.messages("visual-chat")
    let cursor = store.histories["visual-chat"]?.beforeSequence
    let accepted = await latest.value
    XCTAssertFalse(accepted, "The Latest caller must skip its obsolete bottom scroll")
    assertPreserved(store, window: window, rows: rows, cursor: cursor)
    XCTAssertEqual(store.focusedMessage, "visual-message-visual-chat-25")
  }
  func testSlowOrdinaryOpenCannotReplaceANewerNotificationContext() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    let count = try await requests().count
    try await delay(contextPath(90))
    let search = Task { await store.open("visual-chat", messageID: "visual-message-visual-chat-90") }
    try await waitForRequest(contextPath(90), after: count)
    await store.openNotification("visual-chat", messageID: "visual-message-visual-chat-25", sequence: "25")
    let window = store.historyWindows["visual-chat"]
    let rows = store.messages("visual-chat")
    let cursor = store.histories["visual-chat"]?.beforeSequence
    await search.value
    assertPreserved(store, window: window, rows: rows, cursor: cursor)
    XCTAssertEqual(store.focusedMessage, "visual-message-visual-chat-25")
    XCTAssertEqual(store.navigation, ["visual-chat"])
  }

  func testSlowContextCannotReplaceANewerLatestRequestWithoutNavigationChanging() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    let count = try await requests().count
    try await delay(contextPath(25))
    let context = Task { await store.loadContext("visual-chat", messageID: "visual-message-visual-chat-25") }
    try await waitForRequest(contextPath(25), after: count)
    let latest = await store.loadLatest("visual-chat")
    XCTAssertTrue(latest)
    let window = store.historyWindows["visual-chat"]
    let rows = store.messages("visual-chat")
    let cursor = store.histories["visual-chat"]?.beforeSequence
    let accepted = await context.value
    XCTAssertFalse(accepted)
    assertPreserved(store, window: window, rows: rows, cursor: cursor)
    XCTAssertEqual(store.visibleMessages("visual-chat").first?.sequence, "121")
    XCTAssertEqual(store.visibleMessages("visual-chat").last?.sequence, "180")
    XCTAssertTrue(store.navigation.isEmpty)
  }

}
