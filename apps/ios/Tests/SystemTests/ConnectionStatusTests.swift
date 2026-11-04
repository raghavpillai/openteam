import XCTest

@testable import OpenTeamNative

@MainActor
final class ConnectionStatusTests: SystemIntentFixture {
  private func connectedStore() async -> AppStore {
    let store = AppStore()
    store.server = server
    await store.connect(username: "", password: "")
    XCTAssertEqual(store.phase, .ready)
    return store
  }
  private func control(_ body: JSON) async throws {
    _ = try await API(server: server).request("/__qa/control", method: "POST", body: body)
  }
  private func waitForOutage(_ store: AppStore) async throws {
    for _ in 0..<40 where !store.connectionUnavailable {
      try await Task.sleep(for: .milliseconds(100))
    }
    XCTAssertTrue(store.connectionUnavailable)
    XCTAssertFalse(store.online)
  }

  func testHistoryEndpointFailureKeepsConnectionAndCachedMessages() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    await store.loadHistory(channel.id)
    let cached = store.messages(channel.id)
    try await control(.object(["failures": .object([
      "GET /api/v0/channels/\(channel.id)/history": .object([
        "status": .number(503), "count": .number(100),
      ]),
    ])]))
    await store.loadHistory(channel.id)
    XCTAssertTrue(store.historyLoadFailures.contains(channel.id))
    XCTAssertFalse(store.connectionUnavailable, "One failed refresh must not flash a warning")
    try await Task.sleep(for: .milliseconds(1500))
    XCTAssertTrue(store.online, "The independent server check succeeds")
    XCTAssertFalse(store.connectionUnavailable)
    XCTAssertEqual(store.messages(channel.id), cached)
    store.beginReauthentication()
  }

  func testPollFailuresDoNotBecomeHistoryFailuresOrConnectionOutages() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    await store.loadHistory(channel.id)
    store.activeChannel = channel.id
    try await control(.object(["failures": .object([
      "GET /api/v0/events/poll": .object(["status": .number(503), "count": .number(100)]),
    ])]))
    store.finishLaunch()
    try await Task.sleep(for: .milliseconds(2500))
    XCTAssertTrue(store.online)
    XCTAssertFalse(store.connectionUnavailable)
    XCTAssertFalse(store.historyLoadFailures.contains(channel.id))
    store.beginReauthentication()
  }

  func testStartupSettingsFailureRetriesAfterHistoryProvesReachability() async throws {
    try await assertStartupSyncRecovery(failingPath: "/api/v0/settings")
  }

  func testStartupBootstrapFailureStillRetriesSettingsAfterReachabilityRecovers() async throws {
    try await assertStartupSyncRecovery(failingPath: "/api/v0/client-bootstrap")
  }

  private func assertStartupSyncRecovery(failingPath: String) async throws {
    let store = await connectedStore()
    defer { store.beginReauthentication() }
    let channel = try XCTUnwrap(store.channels.first)
    await store.loadHistory(channel.id)
    store.activeChannel = channel.id
    try await control(.object(["failures": .object([
      "GET " + failingPath: .object(["status": .number(503), "count": .number(1)]),
    ])]))
    store.finishLaunch()
    // Reading QA state adds no events. The retry must run even when every poll
    // is empty after the successful startup bootstrap advanced the cursor.
    var fetchedSettings = false
    for _ in 0..<40 {
      let state = try await API(server: server).request("/__qa/state")
      fetchedSettings = state["requests"].array.contains {
        $0["method"].string == "GET" && $0["path"].string == "/api/v0/settings"
      }
      if fetchedSettings { break }
      try await Task.sleep(for: .milliseconds(100))
    }
    XCTAssertTrue(fetchedSettings, "Reachability recovery must not discard an unfinished state sync")
    XCTAssertTrue(store.online)
    XCTAssertFalse(store.connectionUnavailable)
  }

  func testConfirmedOutageClearsOnReachableResponseEvenIfHistoryStillFails() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    await store.loadHistory(channel.id)
    let cached = store.messages(channel.id)
    try await control(.object(["offline": .bool(true)]))
    await store.loadHistory(channel.id)
    XCTAssertFalse(store.connectionUnavailable)
    try await waitForOutage(store)
    XCTAssertEqual(store.messages(channel.id), cached)
    try await control(.object([
      "offline": .bool(false), "failures": .object([
        "GET /api/v0/channels/\(channel.id)/history": .object([
          "status": .number(503), "count": .number(100),
        ]),
      ]),
    ]))
    await store.refresh(quiet: true, flushPending: false)
    XCTAssertTrue(store.online)
    XCTAssertFalse(store.connectionUnavailable, "Recovery must not depend on clearing the history flag")
    XCTAssertTrue(store.historyLoadFailures.contains(channel.id))
    try await control(.object(["failures": .object([:])]))
    await store.loadHistory(channel.id)
    XCTAssertFalse(store.historyLoadFailures.contains(channel.id))
    store.beginReauthentication()
  }

  func testSuccessfulRequestInvalidatesAnOlderFailingProbe() async throws {
    let store = await connectedStore()
    try await control(.object(["failures": .object([
      "GET /api/auth/config": .object([
        "status": .number(503), "delayMs": .number(1500), "count": .number(1),
      ]),
    ])]))
    store.handle(URLError(.timedOut), quiet: true)
    try await Task.sleep(for: .milliseconds(1250))
    await store.refresh(quiet: true, flushPending: false)
    try await Task.sleep(for: .milliseconds(1750))
    XCTAssertTrue(store.online)
    XCTAssertFalse(store.connectionUnavailable, "An older failure cannot overwrite newer success")
    store.beginReauthentication()
  }

  func testReachableProbeRejectionIsNotAnOutage() async throws {
    let store = await connectedStore()
    defer { store.beginReauthentication() }
    try await control(.object(["failures": .object([
      "GET /api/auth/config": .object(["status": .number(403), "count": .number(1)]),
    ])]))
    store.handle(URLError(.timedOut), quiet: true)
    XCTAssertTrue(store.checkingConnection)
    for _ in 0..<30 where store.checkingConnection {
      try await Task.sleep(for: .milliseconds(100))
    }
    XCTAssertFalse(store.checkingConnection)
    XCTAssertTrue(store.online)
    XCTAssertFalse(store.connectionUnavailable)
    XCTAssertEqual(store.phase, .ready, "A rejected public probe is not an expired session")
  }

  func testRetryRecoversWhileHistoryIsStillBusy() async throws {
    let store = await connectedStore()
    defer { store.beginReauthentication() }
    let channel = try XCTUnwrap(store.channels.first)
    await store.loadHistory(channel.id)
    try await control(.object(["offline": .bool(true)]))
    await store.loadHistory(channel.id)
    try await waitForOutage(store)
    try await control(.object(["offline": .bool(false), "failures": .object([
      "GET /api/v0/channels/\(channel.id)/history": .object([
        "delayMs": .number(8000), "status": .number(503), "count": .number(1),
      ]),
    ])]))
    let history = Task { await store.loadHistory(channel.id) }
    defer { history.cancel() }
    for _ in 0..<20 where !store.busy.contains("history-" + channel.id) {
      try await Task.sleep(for: .milliseconds(50))
    }
    XCTAssertTrue(store.busy.contains("history-" + channel.id))
    store.retryConnection()
    XCTAssertTrue(store.checkingConnection)
    for _ in 0..<20 where store.connectionUnavailable {
      try await Task.sleep(for: .milliseconds(50))
    }
    XCTAssertFalse(store.connectionUnavailable)
    XCTAssertFalse(store.checkingConnection)
    XCTAssertTrue(store.online)
    XCTAssertTrue(store.busy.contains("history-" + channel.id), "Retry must bypass the slow history load")
  }

  func testRetryRestartsSyncWithoutWaitingForAnOutstandingPoll() async throws {
    let store = await connectedStore()
    defer { store.beginReauthentication() }
    let channel = try XCTUnwrap(store.channels.first)
    try await control(.object(["failures": .object([
      "GET /api/v0/events/poll": .object(["delayMs": .number(15000), "count": .number(1)]),
    ])]))
    store.finishLaunch()
    try await Task.sleep(for: .milliseconds(300))
    var sidebar = store.sidebar
    sidebar["pinnedIds"] = .array([.string(channel.id)])
    _ = try await API(server: server).request(
      "/api/v0/settings/sidebar", method: "PATCH", body: sidebar)
    XCTAssertFalse(store.pins.contains(channel.id))
    store.retryConnection()
    for _ in 0..<40 where !store.pins.contains(channel.id) {
      try await Task.sleep(for: .milliseconds(50))
    }
    XCTAssertTrue(store.pins.contains(channel.id), "User retry must immediately reconcile fresh state")
    XCTAssertFalse(store.connectionUnavailable)
  }

  func testRetryHasABoundedDeadlineWhenTheProbeHangs() async throws {
    let store = await connectedStore()
    defer { store.beginReauthentication() }
    try await control(.object(["failures": .object([
      "GET /api/auth/config": .object(["delayMs": .number(8000), "count": .number(1)]),
    ])]))
    store.retryConnection()
    XCTAssertTrue(store.checkingConnection)
    let started = ContinuousClock.now
    for _ in 0..<65 where store.checkingConnection {
      try await Task.sleep(for: .milliseconds(100))
    }
    XCTAssertFalse(store.checkingConnection, "Retry must not remain stuck on a hanging probe")
    XCTAssertLessThan(started.duration(to: .now), .seconds(6.5))
    XCTAssertTrue(store.connectionUnavailable)
  }

  func testForegroundResumeRecoversAndLoadsMessagesArrivingDuringOutage() async throws {
    let store = await connectedStore()
    defer { store.beginReauthentication() }
    let channel = try XCTUnwrap(store.channels.first)
    await store.loadHistory(channel.id)
    store.activeChannel = channel.id
    store.finishLaunch()
    try await control(.object(["offline": .bool(true)]))
    await store.loadHistory(channel.id)
    try await waitForOutage(store)
    store.setForeground(false)
    try await control(.object(["offline": .bool(false)]))
    let message = try await API(server: server).send(
      channel: channel, bot: store.bot(for: channel), input: SendInput(content: "Arrived while backgrounded"))
    store.setForeground(true)
    for _ in 0..<40 where !store.messages(channel.id).contains(where: { $0.id == message.id }) {
      try await Task.sleep(for: .milliseconds(50))
    }
    XCTAssertFalse(store.connectionUnavailable)
    XCTAssertTrue(store.online)
    XCTAssertTrue(store.messages(channel.id).contains { $0.id == message.id })
  }

  func testOldProbeCannotChangeANewlyConnectedSession() async throws {
    let store = await connectedStore()
    defer { store.beginReauthentication() }
    try await control(.object(["failures": .object([
      "GET /api/auth/config": .object([
        "delayMs": .number(1500), "status": .number(503), "count": .number(1),
      ]),
    ])]))
    store.handle(URLError(.timedOut), quiet: true)
    try await Task.sleep(for: .milliseconds(1250))
    store.beginReauthentication()
    try await control(.object(["failures": .object([:])]))
    store.server = server
    await store.connect(username: "", password: "")
    try await Task.sleep(for: .milliseconds(1750))
    XCTAssertEqual(store.phase, .ready)
    XCTAssertTrue(store.online)
    XCTAssertFalse(store.checkingConnection)
    XCTAssertFalse(store.connectionUnavailable)
  }

  func testCancellationBackgroundAndReauthenticationCannotShowStaleOutage() async throws {
    let store = await connectedStore()
    store.handle(URLError(.cancelled), quiet: true)
    store.handle(CancellationError(), quiet: true)
    XCTAssertTrue(store.online)
    try await control(.object(["offline": .bool(true)]))
    store.handle(URLError(.networkConnectionLost), quiet: true)
    store.setForeground(false)
    try await Task.sleep(for: .milliseconds(1250))
    XCTAssertFalse(store.connectionUnavailable)
    store.beginReauthentication()
    try await Task.sleep(for: .milliseconds(1250))
    XCTAssertEqual(store.phase, .signedOut)
    XCTAssertFalse(store.connectionUnavailable)
    XCTAssertFalse(store.online)
  }
}
