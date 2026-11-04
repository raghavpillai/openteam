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

  func testTransientSendFailuresRecoverAutomatically() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    let bot = try XCTUnwrap(store.bot(for: channel))
    var draft = Draft()
    draft.text = "Automatically recovered"
    store.saveDraft(draft, channel: channel.id)
    try await control(
      .object([
        "failures": .object([
          "POST /api/v0/conversations/\(bot.conversationId)/messages": .object([
            "status": .number(503), "count": .number(2),
          ])
        ])
      ]))
    let started = ContinuousClock.now
    await store.enqueue(channel)
    XCTAssertTrue(store.state.outbox.isEmpty)
    XCTAssertLessThan(started.duration(to: .now), .seconds(10))
    let state = try await API(server: server).request("/__qa/state")
    XCTAssertEqual(state["messages"].array.filter { $0["content"].string == draft.text }.count, 1)
    XCTAssertNil(store.error)
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
    try await control(.object(["failures": .object([:])]))
    await store.retry(pending.id)
    XCTAssertTrue(store.state.outbox.isEmpty)
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

  func testRetryAttemptsDeliveryEvenWhenPreviousRequestMarkedConnectionOffline() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    store.online = false
    var draft = Draft()
    draft.text = "Attempt the user's send"
    store.saveDraft(draft, channel: channel.id)
    await store.enqueue(channel)
    XCTAssertTrue(store.state.outbox.isEmpty)
    XCTAssertTrue(store.messages(channel.id).contains { $0.content == draft.text })
  }

  func testRetryWhileAnotherSendIsInFlightRunsAfterThatRequest() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    var draft = Draft()
    draft.text = "First failed send"
    store.saveDraft(draft, channel: channel.id)
    try await control(.object(["offline": .bool(true)]))
    await store.enqueue(channel)
    let first = try XCTUnwrap(store.state.outbox.first)
    let bot = try XCTUnwrap(store.bot(for: channel))
    try await control(
      .object([
        "offline": .bool(false),
        "failures": .object([
          "POST /api/v0/conversations/\(bot.conversationId)/messages": .object([
            "delayMs": .number(1200), "count": .number(1),
          ])
        ]),
      ]))
    draft.text = "Second send in flight"
    store.saveDraft(draft, channel: channel.id)
    let sending = Task { await store.enqueue(channel) }
    try await Task.sleep(for: .milliseconds(200))
    await store.retry(first.id)
    await sending.value
    for _ in 0..<30 where !store.state.outbox.isEmpty {
      try await Task.sleep(for: .milliseconds(100))
    }
    XCTAssertTrue(store.state.outbox.isEmpty)
    XCTAssertTrue(store.messages(channel.id).contains { $0.content == "First failed send" })
    XCTAssertTrue(store.messages(channel.id).contains { $0.content == "Second send in flight" })
  }

  func testIncreasingUploadBytesCanSendForLongerThanTenSeconds() async throws {
    // Start `node apps/ios/scripts/send-upload-proxy.cjs` beside the Bun fixture.
    // Node's small paused request stream supplies actual TCP backpressure.
    let proxy = "http://127.0.0.1:20085"
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

  func testUnchangedPendingAndUnknownDurabilityStopCheckingWithoutFalseFailure() async throws {
    for status in ["pending", "unknown_durability"] {
      let store = await connectedStore()
      let channel = try XCTUnwrap(store.channels.first)
      store.sendStallTimeout = .seconds(1)
      try await control(.object(["deliveryStatuses": .array([.string(status)])]))
      var draft = Draft()
      draft.text = "Check \(status)"
      store.saveDraft(draft, channel: channel.id)
      let started = ContinuousClock.now
      await store.enqueue(channel)
      let pending = try XCTUnwrap(store.state.outbox.first)
      XCTAssertNil(pending.failure)
      XCTAssertEqual(pending.deliveryUnconfirmed, true)
      XCTAssertNil(store.activeSendID)
      XCTAssertTrue(store.online, "A pending lookup is a reachable server, not offline")
      XCTAssertLessThan(started.duration(to: .now), .seconds(2))
      let before = try await API(server: server).request("/__qa/state")
      await store.flush()
      let after = try await API(server: server).request("/__qa/state")
      XCTAssertEqual(
        before["requests"], after["requests"], "Unconfirmed sends park for explicit Retry")
      XCTAssertFalse(
        after["requests"].array.contains {
          $0["method"].string == "POST" && $0["clientId"].string == pending.id
        })
      try await control(.object(["deliveryStatuses": .array([])]))
      await store.retry(pending.id)
      XCTAssertTrue(store.state.outbox.isEmpty)
    }
  }

  func testDeliveryTransitionsRefreshStallAndAcceptedNeedsNoBotResponse() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    store.sendStallTimeout = .seconds(2)
    try await control(
      .object([
        "deliveryStatuses": .array([
          .string("pending"), .string("unknown_durability"), .string("not_found"),
        ]),
        "deliveryDelayMs": .number(600),
      ]))
    var draft = Draft()
    draft.text = "Server is making progress"
    store.saveDraft(draft, channel: channel.id)
    let started = ContinuousClock.now
    await store.enqueue(channel)
    XCTAssertGreaterThan(started.duration(to: .now), .seconds(2))
    XCTAssertTrue(store.state.outbox.isEmpty)
    let state = try await API(server: server).request("/__qa/state")
    XCTAssertEqual(state["requests"].array.filter { $0["method"].string == "POST" }.count, 1)
  }

  func testAcceptedStatusWithoutDurableMessageKeepsSavedContent() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    store.sendStallTimeout = .seconds(1)
    try await control(.object(["deliveryStatuses": .array([.string("accepted")])]))
    var draft = Draft()
    draft.text = "Malformed acceptance must not erase this"
    store.saveDraft(draft, channel: channel.id)
    await store.enqueue(channel)
    let pending = try XCTUnwrap(store.state.outbox.first)
    XCTAssertEqual(pending.input.content, draft.text)
    XCTAssertNil(pending.failure)
    XCTAssertEqual(pending.deliveryUnconfirmed, true)
    let state = try await API(server: server).request("/__qa/state")
    XCTAssertFalse(state["requests"].array.contains { $0["method"].string == "POST" })
  }

  func testFreshSubmissionDoesNotShowDeliveryChecking() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    try await control(.object(["sendResponseDelayMs": .number(1200)]))
    var draft = Draft()
    draft.text = "Ordinary send"
    store.saveDraft(draft, channel: channel.id)
    let sending = Task { await store.enqueue(channel) }
    try await Task.sleep(for: .milliseconds(200))
    XCTAssertNotNil(store.activeSendID)
    XCTAssertNil(store.checkingSendID)
    await sending.value
    XCTAssertNil(store.activeSendID)
    XCTAssertNil(store.checkingSendID)
    XCTAssertTrue(store.state.outbox.isEmpty)
  }

  func testOverallCapStopsChangingDeliveryStates() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    store.sendStallTimeout = .seconds(3)
    store.sendOverallTimeout = .seconds(4)
    let statuses = (0..<20).map {
      JSON.string($0.isMultiple(of: 2) ? "pending" : "unknown_durability")
    }
    try await control(.object(["deliveryStatuses": .array(statuses)]))
    var draft = Draft()
    draft.text = "Bound all progress"
    store.saveDraft(draft, channel: channel.id)
    let started = ContinuousClock.now
    await store.enqueue(channel)
    XCTAssertGreaterThanOrEqual(started.duration(to: .now), .seconds(3.8))
    XCTAssertLessThan(started.duration(to: .now), .seconds(5))
    XCTAssertNil(store.state.outbox.first?.failure)
    XCTAssertEqual(store.state.outbox.first?.deliveryUnconfirmed, true)
  }

  func testLostSlowAcknowledgementParksAndRetryFindsExactlyOneAcceptedMessage() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    store.sendStallTimeout = .seconds(1)
    try await control(.object(["sendResponseDelayMs": .number(4000)]))
    var draft = Draft()
    draft.text = "Durable before timeout"
    store.saveDraft(draft, channel: channel.id)
    await store.enqueue(channel)
    let pending = try XCTUnwrap(store.state.outbox.first)
    XCTAssertNil(pending.failure)
    XCTAssertEqual(pending.deliveryUnconfirmed, true)
    let encoded = try JSONEncoder().encode(store.state)
    let restored = try JSONDecoder().decode(SavedState.self, from: encoded)
    XCTAssertEqual(restored.outbox.first?.deliveryUnconfirmed, true)
    await store.retry(pending.id)
    XCTAssertTrue(store.state.outbox.isEmpty)
    let state = try await API(server: server).request("/__qa/state")
    XCTAssertEqual(state["messages"].array.filter { $0["clientId"].string == pending.id }.count, 1)
    XCTAssertEqual(
      state["requests"].array.filter {
        $0["method"].string == "POST" && $0["clientId"].string == pending.id
      }.count, 1)
  }

  func testHistoryAcceptanceCancelsSlowAcknowledgementImmediately() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    try await control(.object(["sendResponseDelayMs": .number(20000)]))
    var draft = Draft()
    draft.text = "History confirms the send"
    store.saveDraft(draft, channel: channel.id)
    let started = ContinuousClock.now
    let sending = Task { await store.enqueue(channel) }
    for _ in 0..<30 {
      let state = try await API(server: server).request("/__qa/state")
      if state["messages"].array.contains(where: { $0["content"].string == draft.text }) { break }
      try await Task.sleep(for: .milliseconds(50))
    }
    await store.loadHistory(channel.id)
    await sending.value
    XCTAssertTrue(store.state.outbox.isEmpty)
    XCTAssertLessThan(started.duration(to: .now), .seconds(3))
  }

  func testBootstrapAcceptanceKeepsBubbleWhenCachedHistoryRefreshFails() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    await store.loadHistory(channel.id)
    let cachedIDs = Set(store.visibleMessages(channel.id).map(\.id))
    XCTAssertFalse(cachedIDs.isEmpty)
    try await control(.object(["sendResponseDelayMs": .number(20000)]))
    var draft = Draft()
    draft.text = "Keep the accepted local bubble"
    store.saveDraft(draft, channel: channel.id)
    let sending = Task { await store.enqueue(channel) }
    for _ in 0..<30 {
      let state = try await API(server: server).request("/__qa/state")
      if state["messages"].array.contains(where: { $0["content"].string == draft.text }) { break }
      try await Task.sleep(for: .milliseconds(50))
    }
    try await control(
      .object([
        "failures": .object([
          "GET /api/v0/channels/\(channel.id)/history": .object([
            "status": .number(503), "count": .number(100),
          ])
        ])
      ]))
    await store.refresh(quiet: true, flushPending: false)
    await sending.value
    await store.loadHistory(channel.id)
    XCTAssertTrue(store.state.outbox.isEmpty)
    XCTAssertTrue(store.historyLoadFailures.contains(channel.id))
    XCTAssertTrue(store.visibleMessages(channel.id).contains { $0.content == draft.text })
    XCTAssertTrue(cachedIDs.isSubset(of: Set(store.visibleMessages(channel.id).map(\.id))))
  }

  func testConfirmedLocalEchoKeepsInterveningHistoryMarkedIncomplete() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    await store.loadHistory(channel.id)
    let api = try API(server: server)
    let intervening = try await api.send(
      channel: channel, bot: store.bot(for: channel),
      input: SendInput(content: "An unseen message from another device"))
    try await control(.object(["sendResponseDelayMs": .number(20000)]))
    var draft = Draft()
    draft.text = "Local echo after the gap"
    store.saveDraft(draft, channel: channel.id)
    let sending = Task { await store.enqueue(channel) }
    for _ in 0..<30 {
      let state = try await api.request("/__qa/state")
      if state["messages"].array.contains(where: { $0["content"].string == draft.text }) { break }
      try await Task.sleep(for: .milliseconds(50))
    }
    await store.refresh(quiet: true, flushPending: false)
    await sending.value
    XCTAssertTrue(store.visibleMessages(channel.id).contains { $0.content == draft.text })
    XCTAssertFalse(store.messages(channel.id).contains { $0.id == intervening.id })
    XCTAssertTrue(
      store.transcriptBehind(channel.id), "A newer local echo must not hide the history gap")
    let restored = try JSONDecoder().decode(
      SavedState.self, from: JSONEncoder().encode(store.state))
    XCTAssertTrue(restored.incompleteHistoryChannels?.contains(channel.id) == true)
    await store.loadHistory(channel.id)
    XCTAssertTrue(store.messages(channel.id).contains { $0.id == intervening.id })
    XCTAssertFalse(store.transcriptBehind(channel.id))
  }

  func testCancellationAfterSubmissionKeepsUnconfirmedNonceForSafeRetry() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    try await control(.object(["sendResponseDelayMs": .number(20000)]))
    var draft = Draft()
    draft.text = "Cancel while acknowledgement is missing"
    store.saveDraft(draft, channel: channel.id)
    let sending = Task { await store.enqueue(channel) }
    for _ in 0..<30 {
      let state = try await API(server: server).request("/__qa/state")
      if state["messages"].array.contains(where: { $0["content"].string == draft.text }) { break }
      try await Task.sleep(for: .milliseconds(50))
    }
    sending.cancel()
    await sending.value
    let pending = try XCTUnwrap(store.state.outbox.first)
    XCTAssertNil(pending.failure)
    XCTAssertEqual(pending.deliveryUnconfirmed, true)
    XCTAssertNil(store.activeSendID)
    XCTAssertNil(store.checkingSendID)
    await store.retry(pending.id)
    XCTAssertTrue(store.state.outbox.isEmpty)
    let state = try await API(server: server).request("/__qa/state")
    XCTAssertEqual(
      state["requests"].array.filter {
        $0["method"].string == "POST" && $0["clientId"].string == pending.id
      }.count, 1)
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

  func testDiscardDuringCheckingCancelsRequestWithoutSending() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    try await control(.object(["deliveryDelayMs": .number(20000)]))
    var draft = Draft()
    draft.text = "Discard while checking"
    store.saveDraft(draft, channel: channel.id)
    let sending = Task { await store.enqueue(channel) }
    try await Task.sleep(for: .milliseconds(100))
    store.discard(try XCTUnwrap(store.state.outbox.first?.id))
    await sending.value
    XCTAssertTrue(store.state.outbox.isEmpty)
    let state = try await API(server: server).request("/__qa/state")
    XCTAssertFalse(state["requests"].array.contains { $0["method"].string == "POST" })
  }

  func testFailedHistoryRefreshKeepsCachedMessagesAndClearsAfterRetry() async throws {
    let store = await connectedStore()
    let channel = try XCTUnwrap(store.channels.first)
    await store.loadHistory(channel.id)
    let cached = store.messages(channel.id)
    XCTAssertFalse(cached.isEmpty)
    try await control(
      .object([
        "failures": .object([
          "GET /api/v0/channels/\(channel.id)/history": .object([
            "status": .number(503), "count": .number(100),
          ])
        ])
      ]))
    await store.loadHistory(channel.id)
    XCTAssertTrue(store.historyLoadFailures.contains(channel.id))
    XCTAssertEqual(store.messages(channel.id), cached)
    XCTAssertNil(store.error)
    try await control(.object(["failures": .object([:])]))
    await store.loadHistory(channel.id)
    XCTAssertFalse(store.historyLoadFailures.contains(channel.id))
    XCTAssertEqual(store.messages(channel.id), cached)
  }

  func testDecodingAndLocalErrorsDoNotChangeConnectionStatus() async {
    let store = await connectedStore()
    store.handle(
      DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "Bad payload")),
      quiet: true)
    store.handle(NSError(domain: NSCocoaErrorDomain, code: NSFileWriteOutOfSpaceError), quiet: true)
    XCTAssertTrue(store.online)
    XCTAssertNil(store.error)
  }
}
