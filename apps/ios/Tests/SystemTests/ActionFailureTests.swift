import XCTest

@testable import OpenTeamNative

@MainActor
final class ActionFailureTests: SystemIntentFixture {
  private func connectedStore(server endpoint: String? = nil) async -> AppStore {
    let store = AppStore()
    store.server = endpoint ?? server
    await store.connect(username: "", password: "")
    XCTAssertEqual(store.phase, .ready)
    return store
  }
  private func control(_ body: JSON) async throws {
    _ = try await API(server: server).request("/__qa/control", method: "POST", body: body)
  }

  func testFailedSendIsSavedAndOnlyRetrySendsItAfterRecovery() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    var draft = Draft()
    draft.text = "Retry this saved message"
    store.saveDraft(draft, channel: channel.id)
    try await control(.object(["offline": .bool(true)]))
    let started = ContinuousClock.now
    let send = Task { await store.enqueue(channel) }
    try await Task.sleep(for: .seconds(1))
    XCTAssertEqual(store.state.outbox.count, 1)
    XCTAssertNil(
      store.state.outbox.first?.failure,
      "Transient outages must remain Sending during the retry window")
    await send.value
    XCTAssertGreaterThanOrEqual(started.duration(to: .now), .seconds(9))
    XCTAssertLessThan(started.duration(to: .now), .seconds(14))
    let failed = try XCTUnwrap(store.state.outbox.first)
    XCTAssertNotNil(failed.failure)
    XCTAssertNil(store.error, "Send failures must not present a global alert")
    XCTAssertTrue(store.draft(channel.id).text.isEmpty)
    store.flushPersistence()

    try await control(.object(["offline": .bool(false)]))
    await store.refresh(quiet: true)
    await store.flush()
    XCTAssertEqual(
      store.state.outbox.first?.id, failed.id,
      "Recovery must keep the failed message available for Retry")
    await store.retry(failed.id)
    await store.retry(failed.id)
    XCTAssertTrue(store.state.outbox.isEmpty)
    let state = try await API(server: server).request("/__qa/state")
    let accepted = state["messages"].array.filter { $0["content"].string == draft.text }
    XCTAssertEqual(accepted.count, 1)
    XCTAssertEqual(accepted.first?["clientId"].string, failed.id)
  }

  func testSendingKeepsTheAppRunningUntilTheOutboxIsDone() async throws {
    let store = await connectedStore()
    let ledger = BackgroundTimeLedger()
    defer { ledger.restore() }
    await store.flush()
    XCTAssertTrue(ledger.names.isEmpty, "Checking an empty outbox asks for no background time")
    let channel = try XCTUnwrap(store.channels.first)
    var draft = Draft()
    draft.text = "Sent after switching apps"
    store.saveDraft(draft, channel: channel.id)
    try await control(.object(["failures": .object([
      "POST /api/v0/conversations/*": .object(["delayMs": .number(600), "count": .number(1)])])]))
    let send = Task { await store.enqueue(channel) }
    try await Task.sleep(for: .milliseconds(300))
    XCTAssertEqual(ledger.open.count, 1, "The app keeps running while the message is in flight")
    await send.value
    XCTAssertTrue(store.state.outbox.isEmpty)
    XCTAssertTrue(ledger.open.isEmpty, "Background time ends once the outbox is empty")
    let state = try await API(server: server).request("/__qa/state")
    XCTAssertEqual(state["messages"].array.filter { $0["content"].string == draft.text }.count, 1)
  }

  func testAutomaticRetryReconcilesLostAcknowledgementWithoutDuplicateMessage() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    var draft = Draft()
    draft.text = "Accepted before the response was lost"
    store.saveDraft(draft, channel: channel.id)
    try await control(.object(["dropNextSend": .bool(true)]))
    await store.enqueue(channel)
    XCTAssertTrue(store.state.outbox.isEmpty)
    let state = try await API(server: server).request("/__qa/state")
    XCTAssertEqual(state["messages"].array.filter { $0["content"].string == draft.text }.count, 1)
    let nonce = try XCTUnwrap(
      state["messages"].array.first { $0["content"].string == draft.text }?["clientId"].string)
    XCTAssertEqual(
      state["requests"].array.filter {
        $0["clientId"].string == nonce && $0["method"].string == "POST"
      }.count, 1)
  }

  func testTimedOutSubmissionRemainsUnconfirmedUntilSafeRetry() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    var draft = Draft()
    draft.text = "Bounded request"
    store.saveDraft(draft, channel: channel.id)
    try await control(
      .object([
        "failures": .object([
          // The nonce varies, so delay the POST after the initial reconciliation.
          "POST /api/v0/conversations/\(try XCTUnwrap(store.bot(for: channel)).conversationId)/messages":
            .object([
              "delayMs": .number(30000), "status": .number(503), "count": .number(1),
            ])
        ])
      ]))
    let started = ContinuousClock.now
    await store.enqueue(channel)
    let pending = try XCTUnwrap(store.state.outbox.first)
    XCTAssertNil(pending.failure)
    XCTAssertEqual(pending.deliveryUnconfirmed, true)
    XCTAssertLessThan(started.duration(to: .now), .seconds(14))
    let ledger = BackgroundTimeLedger()
    defer { ledger.restore() }
    await store.flush()
    XCTAssertTrue(ledger.names.isEmpty, "A message parked after a timeout doesn't hold the app open")
    try await control(.object(["failures": .object([:])]))
    await store.retry(pending.id)
    XCTAssertTrue(store.state.outbox.isEmpty)
    XCTAssertEqual(ledger.names.count, 1, "Retrying it does")
    XCTAssertTrue(ledger.open.isEmpty)
  }

  func testPermanentRejectionDoesNotRetryForTenSeconds() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    let bot = try XCTUnwrap(store.bot(for: channel))
    var draft = Draft()
    draft.text = "Rejected input"
    store.saveDraft(draft, channel: channel.id)
    try await control(
      .object([
        "failures": .object([
          "POST /api/v0/conversations/\(bot.conversationId)/messages": .object([
            "status": .number(422), "count": .number(100),
          ])
        ])
      ]))
    let started = ContinuousClock.now
    await store.enqueue(channel)
    XCTAssertNotNil(store.state.outbox.first?.failure)
    XCTAssertLessThan(started.duration(to: .now), .seconds(2))
  }

  func testIncreasingUploadBytesCanSendForLongerThanTenSeconds() async throws {
    // Start `node apps/ios/scripts/send-upload-proxy.cjs` beside the Bun fixture.
    // Node's small paused request stream supplies actual TCP backpressure.
    let proxy = "http://127.0.0.1:20086"
    let health = try await API(server: proxy).request("/__qa/proxy-health")
    XCTAssertEqual(health["bytesPerSecond"].int, 1024 * 1024)
    let store = await connectedStore(server: proxy)
    let channel = try XCTUnwrap(store.channels.first)
    try store.stage(
      Data(repeating: 65, count: 16 * 1024 * 1024),
      name: "progress.txt", mime: "text/plain", channel: channel.id)
    let started = ContinuousClock.now
    await store.enqueue(channel)
    XCTAssertGreaterThan(started.duration(to: .now), .seconds(10))
    XCTAssertLessThan(started.duration(to: .now), .seconds(35))
    XCTAssertTrue(
      store.state.outbox.isEmpty,
      "Real upload progress must extend the stall window beyond the old total deadline")
    let state = try await API(server: server).request("/__qa/state")
    XCTAssertEqual(state["contentReceipts"].array.count, 1)
    XCTAssertEqual(state["contentReceipts"].array.first?["byteSize"].int, 16 * 1024 * 1024)
    await store.signOut()  // This one test uses a separate server/account cache scope.
  }

  func testCompletedUploadsRefreshStallAndRemainSavedOnRetry() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    store.sendStallTimeout = .seconds(2)
    for index in 0..<3 {
      try store.stage(
        Data("file \(index)".utf8), name: "file-\(index).txt",
        mime: "text/plain", channel: channel.id)
    }
    let stagedFiles = try XCTUnwrap(store.draft(channel.id).stagedFiles)
    let bot = try XCTUnwrap(store.bot(for: channel))
    try await control(
      .object([
        "failures": .object([
          "POST /api/v0/assets": .object(["delayMs": .number(900), "count": .number(3)]),
          "POST /api/v0/conversations/\(bot.conversationId)/messages":
            .object(["status": .number(422), "count": .number(1)]),
        ])
      ]))
    let started = ContinuousClock.now
    await store.enqueue(channel)
    XCTAssertGreaterThan(started.duration(to: .now), .seconds(2))
    let failed = try XCTUnwrap(store.state.outbox.first)
    XCTAssertNotNil(failed.failure)
    XCTAssertEqual(failed.input.attachments.count, 3)
    XCTAssertTrue(failed.stagedFiles?.isEmpty == true)
    let expectedMapping = Dictionary(uniqueKeysWithValues: zip(failed.input.attachments, stagedFiles).map {
      ($0.0.assetId + ":" + $0.0.fileName, $0.1.id)
    })
    XCTAssertEqual(failed.uploadedFileIDs, expectedMapping)
    let restored = try JSONDecoder().decode(PendingSend.self, from: JSONEncoder().encode(failed))
    XCTAssertEqual(restored.uploadedFileIDs, expectedMapping)
    store.flushPersistence()
    await store.retry(failed.id)
    XCTAssertTrue(store.state.outbox.isEmpty)
    let state = try await API(server: server).request("/__qa/state")
    XCTAssertEqual(state["contentReceipts"].array.count, 3, "Retry must reuse uploaded assets")
  }

  func testAccountGenerationChangeCancelsOldDeliveryRequest() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    try await control(.object(["deliveryDelayMs": .number(20000)]))
    var draft = Draft()
    draft.text = "Old account request"
    store.saveDraft(draft, channel: channel.id)
    let sending = Task { await store.enqueue(channel) }
    try await Task.sleep(for: .milliseconds(100))
    store.beginReauthentication()
    await sending.value
    XCTAssertEqual(store.phase, .signedOut)
    XCTAssertTrue(store.state.outbox.isEmpty)
    XCTAssertNil(store.activeSendID)
    XCTAssertNil(store.checkingSendID)
    let state = try await API(server: server).request("/__qa/state")
    XCTAssertFalse(state["requests"].array.contains { $0["method"].string == "POST" })
  }
}
