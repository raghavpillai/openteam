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
    for _ in 0..<60 where !store.connectionUnavailable {
      try await Task.sleep(for: .milliseconds(100))
    }
    XCTAssertTrue(store.connectionUnavailable)
    XCTAssertFalse(store.online)
  }

  func testWarningWaitsForThreeConsecutiveFailedChecks() async throws {
    let store = await connectedStore()
    defer { store.beginReauthentication() }
    try await control(.object(["offline": .bool(true)]))
    store.handle(URLError(.networkConnectionLost), quiet: true)
    try await Task.sleep(for: .milliseconds(2400))
    XCTAssertFalse(store.connectionUnavailable, "Two failed checks are not enough to show a warning")
    XCTAssertTrue(store.checkingConnection)
    try await waitForOutage(store)
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
}
