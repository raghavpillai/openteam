import XCTest
@testable import OpenTeamNative

@MainActor
final class UnreadResponseTests: SystemIntentFixture {
  private let channelID = "visual-chat"
  private let readPath = "/api/v0/channels/visual-chat/read"
  private let sidebarPath = "/api/v0/settings/sidebar"
  private var bootstrap: JSON = .null

  /// Serves the edited `bootstrap` plus any extra injected responses.
  private func serve(_ failures: [String: JSON] = [:]) async throws {
    var next = failures
    next["GET /api/v0/client-bootstrap"] = .object([
      "status": .number(200), "body": bootstrap, "count": .number(1000),
    ])
    try await control(.object(["failures": .object(next)]))
  }
  private func readyStore() async throws -> AppStore {
    try await scene("history-pages")
    bootstrap = try await API(server: server).request("/api/v0/client-bootstrap")
    updateBootstrap(message: "180", activity: "500", readMessage: "179", readActivity: "499", unread: 1)
    try await serve()
    let store = try await connectedStore()
    await store.loadHistory(channelID)
    store.activeChannel = channelID
    return store
  }
  private func updateBootstrap(message: String, activity: String,
    readMessage: String, readActivity: String, unread: Int) {
    var channels = bootstrap["channels"].array
    let index = channels.firstIndex { $0["id"].string == channelID }!
    channels[index]["unreadCount"] = .number(Double(unread))
    channels[index]["notificationState"] = .object([
      "lastReadSequence": .string(readMessage),
      "lastReadNotificationSequence": .string(readActivity),
      "notificationCursor": .string(activity),
    ])
    bootstrap["channels"] = .array(channels)
    var messages = bootstrap["latestMessages"].array
    var latest = messages.removeLast()
    latest["id"] = .string("visual-message-visual-chat-" + message)
    latest["sequence"] = .string(message)
    messages.append(latest)
    bootstrap["latestMessages"] = .array(messages)
  }
  private func ack(message: String = "180", activity: String = "500", unread: Int = 0,
    delay: Int = 0) -> JSON {
    .object([
      "status": .number(200), "count": .number(1), "delayMs": .number(Double(delay)),
      "body": .object([
        "channelId": .string(channelID), "lastReadSequence": .string(message),
        "lastReadNotificationSequence": .string(activity), "unreadCount": .number(Double(unread)),
      ]),
    ])
  }
  private func requestCount(_ path: String, method: String) async throws -> Int {
    try await requests().filter {
      $0["path"].string == path && $0["method"].string == method
    }.count
  }
  private func waitForRequest(_ path: String, method: String, after count: Int) async throws {
    for _ in 0..<100 {
      if try await requestCount(path, method: method) > count { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("Request barrier was not reached for \(method) \(path)")
    throw APIError("Missing fixture request")
  }
  private func assertManualUnread(_ store: AppStore, file: StaticString = #filePath,
    line: UInt = #line) async throws {
    XCTAssertTrue(store.sidebar["unreadIds"].array.contains(.string(channelID)), file: file, line: line)
    let persisted = try await fixtureState()["settings"]
    XCTAssertTrue(persisted["unreadIds"].array.contains(.string(channelID)), file: file, line: line)
  }

  func testDelayedReadAckPreservesNewerMessageUnread() async throws {
    let store = try await readyStore()
    defer { store.beginReauthentication() }
    let count = try await requestCount(readPath, method: "POST")
    try await serve(["POST " + readPath: ack(delay: 3000)])
    var completed = false
    let read = Task {
      let accepted = await store.markRead(channelID, through: "180", throughNotificationSequence: "500")
      completed = true
      return accepted
    }
    try await waitForRequest(readPath, method: "POST", after: count)
    updateBootstrap(message: "181", activity: "500", readMessage: "180", readActivity: "500", unread: 1)
    try await serve()
    let refreshed = await store.refresh()
    XCTAssertTrue(refreshed)
    XCTAssertEqual(store.latestMessage(channelID)?.sequence, "181")
    XCTAssertFalse(completed, "The newer bootstrap must be installed before the captured ACK is released")
    let accepted = await read.value
    XCTAssertTrue(accepted)
    XCTAssertEqual(store.channel(channelID)?.unreadCount, 1)
    XCTAssertEqual(store.channel(channelID)?.notificationState?["lastReadSequence"].string, "180")
  }

  func testDelayedReadAckPreservesNewerExplicitMarkUnread() async throws {
    let store = try await readyStore()
    defer { store.beginReauthentication() }
    let count = try await requestCount(readPath, method: "POST")
    try await serve(["POST " + readPath: ack(delay: 3000)])
    var completed = false
    let read = Task {
      let accepted = await store.markRead(channelID, through: "180", throughNotificationSequence: "500")
      completed = true
      return accepted
    }
    try await waitForRequest(readPath, method: "POST", after: count)
    await store.markUnread(channelID)
    try await assertManualUnread(store)
    XCTAssertFalse(completed)
    let patches = try await requestCount(sidebarPath, method: "PATCH")
    _ = await read.value
    try await assertManualUnread(store)
    let after = try await requestCount(sidebarPath, method: "PATCH")
    XCTAssertEqual(after, patches, "The old ACK must not send a clear after the newer manual write")
  }

  func testConcurrentNewReadAckWinsOverDelayedOldAck() async throws {
    let store = try await readyStore()
    defer { store.beginReauthentication() }
    let count = try await requestCount(readPath, method: "POST")
    try await serve(["POST " + readPath: ack(unread: 1, delay: 3000)])
    var completed = false
    let old = Task {
      let accepted = await store.markRead(channelID, through: "180", throughNotificationSequence: "500")
      completed = true
      return accepted
    }
    try await waitForRequest(readPath, method: "POST", after: count)
    updateBootstrap(message: "181", activity: "501", readMessage: "180", readActivity: "500", unread: 1)
    try await serve(["POST " + readPath: ack(message: "181", activity: "501")])
    _ = await store.refresh()
    let accepted = await store.markRead(channelID, through: "181", throughNotificationSequence: "501")
    XCTAssertTrue(accepted)
    XCTAssertFalse(completed)
    _ = await old.value
    XCTAssertEqual(store.channel(channelID)?.unreadCount, 0)
    XCTAssertEqual(store.channel(channelID)?.notificationState?["lastReadSequence"].string, "181")
    XCTAssertEqual(store.channel(channelID)?.notificationState?["lastReadNotificationSequence"].string, "501")
  }

  func testAccountChangeRejectsDelayedReadAck() async throws {
    let store = try await readyStore()
    let count = try await requestCount(readPath, method: "POST")
    try await serve(["POST " + readPath: ack(delay: 3000)])
    let read = Task {
      await store.markRead(channelID, through: "180", throughNotificationSequence: "500")
    }
    try await waitForRequest(readPath, method: "POST", after: count)
    store.beginReauthentication()
    let accepted = await read.value
    XCTAssertFalse(accepted)
    XCTAssertNotEqual(store.phase, .ready)
    let patches = try await requestCount(sidebarPath, method: "PATCH")
    XCTAssertEqual(patches, 0)
  }

}
