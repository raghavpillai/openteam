import XCTest
@testable import OpenTeamNative

@MainActor
final class UnreadResponseTests: SystemIntentFixture {
  private let channelID = "visual-chat"
  private let readPath = "/api/v0/channels/visual-chat/read"
  private let sidebarPath = "/api/v0/settings/sidebar"
  private var bootstrap: JSON = .null

  private func control(_ failures: [String: JSON] = [:]) async throws {
    var next = failures
    next["GET /api/v0/client-bootstrap"] = .object([
      "status": .number(200), "body": bootstrap, "count": .number(1000),
    ])
    _ = try await API(server: server).request("/__qa/control", method: "POST",
      body: .object(["failures": .object(next)]))
  }
  private func connectedStore() async throws -> AppStore {
    let api = try API(server: server)
    _ = try await api.request("/__qa/scene", method: "POST",
      body: .object(["scene": .string("history-pages")]))
    bootstrap = try await api.request("/api/v0/client-bootstrap")
    updateBootstrap(message: "180", activity: "500", readMessage: "179", readActivity: "499", unread: 1)
    try await control()
    let store = AppStore()
    store.server = server
    await store.connect(username: "", password: "")
    XCTAssertEqual(store.phase, .ready)
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
    try await API(server: server).request("/__qa/state")["requests"].array.filter {
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
  private func markUnread(_ store: AppStore, id: String? = nil) async {
    await store.markUnread(id ?? channelID)
  }
  private func assertManualUnread(_ store: AppStore, file: StaticString = #filePath,
    line: UInt = #line) async throws {
    XCTAssertTrue(store.sidebar["unreadIds"].array.contains(.string(channelID)), file: file, line: line)
    let persisted = try await API(server: server).request("/__qa/state")["settings"]
    XCTAssertTrue(persisted["unreadIds"].array.contains(.string(channelID)), file: file, line: line)
  }

  func testDelayedReadAckPreservesNewerMessageUnread() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    let count = try await requestCount(readPath, method: "POST")
    try await control(["POST " + readPath: ack(delay: 3000)])
    var completed = false
    let read = Task {
      let accepted = await store.markRead(channelID, through: "180", throughNotificationSequence: "500")
      completed = true
      return accepted
    }
    try await waitForRequest(readPath, method: "POST", after: count)
    updateBootstrap(message: "181", activity: "500", readMessage: "180", readActivity: "500", unread: 1)
    try await control()
    let refreshed = await store.refresh()
    XCTAssertTrue(refreshed)
    XCTAssertEqual(store.latestMessage(channelID)?.sequence, "181")
    XCTAssertFalse(completed, "The newer bootstrap must be installed before the captured ACK is released")
    let accepted = await read.value
    XCTAssertTrue(accepted)
    XCTAssertEqual(store.channel(channelID)?.unreadCount, 1)
    XCTAssertEqual(store.channel(channelID)?.notificationState?["lastReadSequence"].string, "180")
  }

  func testDelayedReadAckPreservesNewerActivityUnread() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    let count = try await requestCount(readPath, method: "POST")
    try await control(["POST " + readPath: ack(delay: 3000)])
    var completed = false
    let read = Task {
      let accepted = await store.markRead(channelID, through: "180", throughNotificationSequence: "500")
      completed = true
      return accepted
    }
    try await waitForRequest(readPath, method: "POST", after: count)
    updateBootstrap(message: "180", activity: "501", readMessage: "180", readActivity: "500", unread: 1)
    try await control()
    let refreshed = await store.refresh()
    XCTAssertTrue(refreshed)
    XCTAssertFalse(completed)
    let accepted = await read.value
    XCTAssertTrue(accepted)
    XCTAssertEqual(store.channel(channelID)?.unreadCount, 1)
    XCTAssertEqual(store.channel(channelID)?.notificationState?["notificationCursor"].string, "501")
    XCTAssertEqual(store.channel(channelID)?.notificationState?["lastReadNotificationSequence"].string, "500")
  }

  func testDelayedReadAckPreservesNewerExplicitMarkUnread() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    let count = try await requestCount(readPath, method: "POST")
    try await control(["POST " + readPath: ack(delay: 3000)])
    var completed = false
    let read = Task {
      let accepted = await store.markRead(channelID, through: "180", throughNotificationSequence: "500")
      completed = true
      return accepted
    }
    try await waitForRequest(readPath, method: "POST", after: count)
    await markUnread(store)
    try await assertManualUnread(store)
    XCTAssertFalse(completed)
    let patches = try await requestCount(sidebarPath, method: "PATCH")
    _ = await read.value
    try await assertManualUnread(store)
    let after = try await requestCount(sidebarPath, method: "PATCH")
    XCTAssertEqual(after, patches, "The old ACK must not send a clear after the newer manual write")
  }

  func testStableFrontierAcceptsReadAckAndAdvancesBothCursors() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    try await control()
    let accepted = await store.markRead(channelID, through: "180", throughNotificationSequence: "500")
    XCTAssertTrue(accepted)
    XCTAssertEqual(store.channel(channelID)?.unreadCount, 0)
    XCTAssertEqual(store.channel(channelID)?.notificationState?["lastReadSequence"].string, "180")
    XCTAssertEqual(store.channel(channelID)?.notificationState?["lastReadNotificationSequence"].string, "500")
    let persisted = try await API(server: server).request("/__qa/state")["channels"].array
      .first { $0["id"].string == channelID }
    XCTAssertEqual(persisted?["notificationState"]["lastReadSequence"].string, "180",
      "The fixture must receive the requested message read cursor")
  }

  func testOlderHistoryReadAcceptsAccurateCountOnStableFrontier() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    updateBootstrap(message: "180", activity: "500", readMessage: "24", readActivity: "499", unread: 156)
    try await control()
    _ = await store.refresh()
    let loaded = await store.loadContext(channelID, messageID: "visual-message-visual-chat-25")
    XCTAssertTrue(loaded)
    try await control(["POST " + readPath: ack(message: "25", activity: "500", unread: 155)])
    let accepted = await store.markRead(channelID, through: "25", throughNotificationSequence: "500")
    XCTAssertTrue(accepted)
    XCTAssertEqual(store.channel(channelID)?.unreadCount, 155)
    XCTAssertEqual(store.channel(channelID)?.notificationState?["lastReadSequence"].string, "25")
  }

  func testConcurrentNewReadAckWinsOverDelayedOldAck() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    let count = try await requestCount(readPath, method: "POST")
    try await control(["POST " + readPath: ack(unread: 1, delay: 3000)])
    var completed = false
    let old = Task {
      let accepted = await store.markRead(channelID, through: "180", throughNotificationSequence: "500")
      completed = true
      return accepted
    }
    try await waitForRequest(readPath, method: "POST", after: count)
    updateBootstrap(message: "181", activity: "501", readMessage: "180", readActivity: "500", unread: 1)
    try await control(["POST " + readPath: ack(message: "181", activity: "501")])
    _ = await store.refresh()
    let accepted = await store.markRead(channelID, through: "181", throughNotificationSequence: "501")
    XCTAssertTrue(accepted)
    XCTAssertFalse(completed)
    _ = await old.value
    XCTAssertEqual(store.channel(channelID)?.unreadCount, 0)
    XCTAssertEqual(store.channel(channelID)?.notificationState?["lastReadSequence"].string, "181")
    XCTAssertEqual(store.channel(channelID)?.notificationState?["lastReadNotificationSequence"].string, "501")
  }

  func testMarkUnreadWaitsForAnAlreadySubmittedReadClear() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    await markUnread(store)
    let count = try await requestCount(sidebarPath, method: "PATCH")
    try await control([
      "POST " + readPath: ack(),
      "PATCH " + sidebarPath: .object(["delayMs": .number(3000), "count": .number(1)]),
    ])
    let read = Task {
      await store.markRead(channelID, through: "180", throughNotificationSequence: "500")
    }
    try await waitForRequest(sidebarPath, method: "PATCH", after: count)
    XCTAssertTrue(store.sidebar["unreadIds"].array.contains(.string(channelID)))
    // This starts after the clear reached the server, while its response is held.
    // Server-side persistence catches an implementation that only ignores the
    // stale response but still allows the older PATCH to overtake the new write.
    await markUnread(store)
    _ = await read.value
    try await assertManualUnread(store)
    let after = try await requestCount(sidebarPath, method: "PATCH")
    XCTAssertEqual(after, count + 2)
  }

  func testFailedReadClearDoesNotBlockTheNewerMarkUnread() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    await markUnread(store)
    let count = try await requestCount(sidebarPath, method: "PATCH")
    try await control([
      "POST " + readPath: ack(),
      "PATCH " + sidebarPath: .object([
        "delayMs": .number(3000), "status": .number(503), "count": .number(1),
      ]),
    ])
    let read = Task {
      await store.markRead(channelID, through: "180", throughNotificationSequence: "500")
    }
    try await waitForRequest(sidebarPath, method: "PATCH", after: count)
    XCTAssertTrue(store.sidebar["unreadIds"].array.contains(.string(channelID)))
    await markUnread(store)
    _ = await read.value
    try await assertManualUnread(store)
    let after = try await requestCount(sidebarPath, method: "PATCH")
    XCTAssertEqual(after, count + 2)
  }

  func testFailedManualUnreadCanBeRetried() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    try await control([
      "PATCH " + sidebarPath: .object([
        "status": .number(400), "message": .string("Unread save rejected"), "count": .number(1),
      ]),
    ])
    await markUnread(store)
    XCTAssertFalse(store.sidebar["unreadIds"].array.contains(.string(channelID)))
    XCTAssertNotNil(store.error)
    try await control()
    await markUnread(store)
    try await assertManualUnread(store)
  }

  func testAccountChangeRejectsDelayedReadAck() async throws {
    let store = try await connectedStore()
    let count = try await requestCount(readPath, method: "POST")
    try await control(["POST " + readPath: ack(delay: 3000)])
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

  func testCancelledReadCannotClearManualUnread() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    await markUnread(store)
    let count = try await requestCount(readPath, method: "POST")
    let patches = try await requestCount(sidebarPath, method: "PATCH")
    try await control(["POST " + readPath: ack(delay: 3000)])
    let read = Task {
      await store.markRead(channelID, through: "180", throughNotificationSequence: "500")
    }
    try await waitForRequest(readPath, method: "POST", after: count)
    read.cancel()
    let accepted = await read.value
    XCTAssertFalse(accepted)
    try await assertManualUnread(store)
    let after = try await requestCount(sidebarPath, method: "PATCH")
    XCTAssertEqual(after, patches)
  }

  func testQueuedPinActionsPreserveBothPins() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    let count = try await requestCount(sidebarPath, method: "PATCH")
    try await control([
      "PATCH " + sidebarPath: .object(["delayMs": .number(3000), "count": .number(1)]),
    ])
    let first = Task { await store.togglePin("queued-pin-a") }
    try await waitForRequest(sidebarPath, method: "PATCH", after: count)
    XCTAssertFalse(store.pins.contains("queued-pin-a"), "The second body must be captured from the old sidebar")
    await store.togglePin("queued-pin-b")
    await first.value
    XCTAssertEqual(store.pins, ["queued-pin-a", "queued-pin-b"])
    let persisted = try await API(server: server).request("/__qa/state")["settings"]
    XCTAssertEqual(persisted["pinnedIds"].array.map(\.string), store.pins)
  }

  func testQueuedMarkUnreadPreservesTheEarlierPin() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    let count = try await requestCount(sidebarPath, method: "PATCH")
    try await control([
      "PATCH " + sidebarPath: .object(["delayMs": .number(3000), "count": .number(1)]),
    ])
    let pin = Task { await store.togglePin("queued-pin-a") }
    try await waitForRequest(sidebarPath, method: "PATCH", after: count)
    XCTAssertFalse(store.pins.contains("queued-pin-a"), "The second body must be captured from the old sidebar")
    await markUnread(store)
    await pin.value
    XCTAssertEqual(store.pins, ["queued-pin-a"])
    try await assertManualUnread(store)
    let persisted = try await API(server: server).request("/__qa/state")["settings"]
    XCTAssertEqual(persisted["pinnedIds"].array, [.string("queued-pin-a")])
  }

  func testQueuedSectionRenamePreservesCollapseAndConversationOrder() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    var initial = store.sidebar
    initial["sections"] = .array([.object([
      "id": .string("section-a"), "name": .string("Initial"), "collapsed": .bool(false),
    ])])
    initial["channelOrderByGroup"]["unassigned"] = .array([.string("a"), .string("b")])
    if let saved = await store.mutate(sidebarPath, method: "PATCH", body: initial) {
      store.sidebar = saved
    }
    let count = try await requestCount(sidebarPath, method: "PATCH")
    try await control([
      "PATCH " + sidebarPath: .object(["delayMs": .number(3000), "count": .number(1)]),
    ])
    var collapsed = store.sidebar
    var sections = collapsed["sections"].array
    sections[0]["collapsed"] = .bool(true)
    collapsed["sections"] = .array(sections)
    collapsed["channelOrderByGroup"]["unassigned"] = .array([.string("b"), .string("a")])
    let firstBody = collapsed
    let first = Task {
      if let saved = await store.mutate(sidebarPath, method: "PATCH", body: firstBody) {
        store.sidebar = saved
      }
    }
    try await waitForRequest(sidebarPath, method: "PATCH", after: count)
    var renamed = store.sidebar
    XCTAssertEqual(renamed["sections"].array.first?["collapsed"].bool, false)
    XCTAssertEqual(renamed["channelOrderByGroup"]["unassigned"].array, [.string("a"), .string("b")])
    sections = renamed["sections"].array
    sections[0]["name"] = .string("Renamed")
    renamed["sections"] = .array(sections)
    if let saved = await store.mutate(sidebarPath, method: "PATCH", body: renamed) {
      store.sidebar = saved
    }
    await first.value
    let persisted = try await API(server: server).request("/__qa/state")["settings"]
    for value in [store.sidebar, persisted] {
      XCTAssertEqual(value["sections"].array.first?["name"].string, "Renamed")
      XCTAssertEqual(value["sections"].array.first?["collapsed"].bool, true)
      XCTAssertEqual(value["channelOrderByGroup"]["unassigned"].array, [.string("b"), .string("a")])
    }
  }

  func testObservedRemoteMarkUnreadSurvivesAnOlderReadAck() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    let count = try await requestCount(readPath, method: "POST")
    try await control(["POST " + readPath: ack(delay: 3000)])
    var completed = false
    let read = Task {
      let accepted = await store.markRead(channelID, through: "180", throughNotificationSequence: "500")
      completed = true
      return accepted
    }
    try await waitForRequest(readPath, method: "POST", after: count)
    var remote = store.sidebar
    remote["unreadIds"] = .array([.string(channelID)])
    _ = try await API(server: server).request(sidebarPath, method: "PATCH", body: remote)
    _ = await store.refresh()
    XCTAssertFalse(completed)
    try await assertManualUnread(store)
    _ = await read.value
    try await assertManualUnread(store)
  }

  func testCancellationAfterClearSubmissionStillOrdersTheNewerUnreadWrite() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    await markUnread(store)
    let count = try await requestCount(sidebarPath, method: "PATCH")
    try await control([
      "POST " + readPath: ack(),
      "PATCH " + sidebarPath: .object(["delayMs": .number(3000), "count": .number(1)]),
    ])
    let read = Task {
      await store.markRead(channelID, through: "180", throughNotificationSequence: "500")
    }
    try await waitForRequest(sidebarPath, method: "PATCH", after: count)
    read.cancel()
    await markUnread(store)
    let accepted = await read.value
    XCTAssertFalse(accepted)
    try await assertManualUnread(store)
  }

  private func assertReadClearsManualUnread(_ store: AppStore, after patches: Int) async throws {
    XCTAssertFalse(store.sidebar["unreadIds"].array.contains(.string(channelID)))
    let persisted = try await API(server: server).request("/__qa/state")["settings"]
    XCTAssertFalse(persisted["unreadIds"].array.contains(.string(channelID)))
    let after = try await requestCount(sidebarPath, method: "PATCH")
    XCTAssertEqual(after, patches + 1, "The valid ACK must send a clear after the unrelated write")
    XCTAssertEqual(store.channel(channelID)?.unreadCount, 0)
    XCTAssertEqual(store.channel(channelID)?.notificationState?["lastReadSequence"].string, "180")
    XCTAssertEqual(store.channel(channelID)?.notificationState?["lastReadNotificationSequence"].string, "500")
  }

  func testDelayedReadAckClearsManualUnreadAfterUnrelatedPin() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    await markUnread(store)
    let count = try await requestCount(readPath, method: "POST")
    try await control(["POST " + readPath: ack(delay: 3000)])
    var completed = false
    let read = Task {
      let accepted = await store.markRead(channelID, through: "180", throughNotificationSequence: "500")
      completed = true
      return accepted
    }
    try await waitForRequest(readPath, method: "POST", after: count)
    await store.togglePin("unrelated-pin")
    let patches = try await requestCount(sidebarPath, method: "PATCH")
    XCTAssertFalse(completed, "The unrelated pin must complete before the captured ACK")
    let accepted = await read.value
    XCTAssertTrue(accepted)
    try await assertReadClearsManualUnread(store, after: patches)
    XCTAssertEqual(store.pins, ["unrelated-pin"])
    let persisted = try await API(server: server).request("/__qa/state")["settings"]
    XCTAssertEqual(persisted["pinnedIds"].array, [.string("unrelated-pin")])
  }

  func testDelayedReadAckClearsManualUnreadAfterUnrelatedSectionRename() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    await markUnread(store)
    var initial = store.sidebar
    initial["sections"] = .array([.object([
      "id": .string("unrelated-section"), "name": .string("Before"), "collapsed": .bool(false),
    ])])
    if let saved = await store.mutate(sidebarPath, method: "PATCH", body: initial) {
      store.sidebar = saved
    }
    let count = try await requestCount(readPath, method: "POST")
    try await control(["POST " + readPath: ack(delay: 3000)])
    var completed = false
    let read = Task {
      let accepted = await store.markRead(channelID, through: "180", throughNotificationSequence: "500")
      completed = true
      return accepted
    }
    try await waitForRequest(readPath, method: "POST", after: count)
    var renamed = store.sidebar
    var sections = renamed["sections"].array
    sections[0]["name"] = .string("After")
    renamed["sections"] = .array(sections)
    if let saved = await store.mutate(sidebarPath, method: "PATCH", body: renamed) {
      store.sidebar = saved
    }
    let patches = try await requestCount(sidebarPath, method: "PATCH")
    XCTAssertFalse(completed, "The unrelated rename must complete before the captured ACK")
    let accepted = await read.value
    XCTAssertTrue(accepted)
    try await assertReadClearsManualUnread(store, after: patches)
    let persisted = try await API(server: server).request("/__qa/state")["settings"]
    for value in [store.sidebar, persisted] {
      XCTAssertEqual(value["sections"].array.first?["name"].string, "After")
    }
  }

  func testDelayedReadAckClearsManualUnreadAfterUnrelatedCollapse() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    await markUnread(store)
    let count = try await requestCount(readPath, method: "POST")
    try await control(["POST " + readPath: ack(delay: 3000)])
    var completed = false
    let read = Task {
      let accepted = await store.markRead(channelID, through: "180", throughNotificationSequence: "500")
      completed = true
      return accepted
    }
    try await waitForRequest(readPath, method: "POST", after: count)
    var collapsed = store.sidebar
    collapsed["unassignedCollapsed"] = .bool(true)
    if let saved = await store.mutate(sidebarPath, method: "PATCH", body: collapsed) {
      store.sidebar = saved
    }
    let patches = try await requestCount(sidebarPath, method: "PATCH")
    XCTAssertFalse(completed, "The unrelated collapse must complete before the captured ACK")
    let accepted = await read.value
    XCTAssertTrue(accepted)
    try await assertReadClearsManualUnread(store, after: patches)
    let persisted = try await API(server: server).request("/__qa/state")["settings"]
    XCTAssertTrue(store.sidebar["unassignedCollapsed"].bool)
    XCTAssertTrue(persisted["unassignedCollapsed"].bool)
  }

  func testDelayedReadAckPreservesRepeatedExplicitMarkUnread() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    await markUnread(store)
    let count = try await requestCount(readPath, method: "POST")
    try await control(["POST " + readPath: ack(delay: 3000)])
    var completed = false
    let read = Task {
      let accepted = await store.markRead(channelID, through: "180", throughNotificationSequence: "500")
      completed = true
      return accepted
    }
    try await waitForRequest(readPath, method: "POST", after: count)
    await markUnread(store)
    XCTAssertFalse(completed)
    let accepted = await read.value
    XCTAssertTrue(accepted)
    try await assertManualUnread(store)
  }

  func testRepeatedExplicitMarkUnreadInAnotherChatDoesNotFenceReadAck() async throws {
    let store = try await connectedStore()
    defer { store.beginReauthentication() }
    await markUnread(store)
    await markUnread(store, id: "other-manual-chat")
    let count = try await requestCount(readPath, method: "POST")
    try await control(["POST " + readPath: ack(delay: 3000)])
    var completed = false
    let read = Task {
      let accepted = await store.markRead(channelID, through: "180", throughNotificationSequence: "500")
      completed = true
      return accepted
    }
    try await waitForRequest(readPath, method: "POST", after: count)
    await markUnread(store, id: "other-manual-chat")
    let patches = try await requestCount(sidebarPath, method: "PATCH")
    XCTAssertFalse(completed)
    let accepted = await read.value
    XCTAssertTrue(accepted)
    try await assertReadClearsManualUnread(store, after: patches)
    let persisted = try await API(server: server).request("/__qa/state")["settings"]
    for value in [store.sidebar, persisted] {
      XCTAssertTrue(value["unreadIds"].array.contains(.string("other-manual-chat")))
    }
  }
}
