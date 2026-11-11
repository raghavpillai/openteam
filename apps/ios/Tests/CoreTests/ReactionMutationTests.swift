import XCTest

@testable import OpenTeamCore

@MainActor
final class ReactionMutationTests: XCTestCase {
  @MainActor final class Server {
    var calls: [(String, String)] = []
    var waiting: [String: CheckedContinuation<Message, Error>] = [:]
    var received: [Message] = []
    var failures = 0
    var recovered = true
    var own: [String: String] = [:]
    let queue = ReactionMutations()

    func message(_ id: String = "a", own: String? = nil) -> Message {
      Message(id: id, sequence: "1", channelId: "chat", sender: "user", content: "hello",
        metadata: ReactionMutations.replacingOwn(.object([:]), with: own), createdAt: "now")
    }
    @discardableResult func tap(_ emoji: String, id: String = "a") -> Bool {
      queue.toggle(messageID: id, metadata: message(id, own: own[id]).metadata, emoji: emoji,
        send: { emoji in
          // A second simultaneous request to one message is always a bug.
          XCTAssertNil(self.waiting[id])
          self.calls.append((id, emoji))
          return try await withCheckedThrowingContinuation { self.waiting[id] = $0 }
        }, confirmed: { message in self.received.append(message) },
        recover: { _ in self.failures += 1; return self.recovered })
    }
    func complete(_ id: String = "a") {
      let emoji = calls.last { $0.0 == id }!.1
      own[id] = own[id] == emoji ? nil : emoji
      waiting.removeValue(forKey: id)!.resume(returning: message(id, own: own[id]))
    }
    func fail(_ id: String = "a") {
      waiting.removeValue(forKey: id)!.resume(throwing: URLError(.timedOut))
    }
  }

  func waitUntil(_ predicate: @MainActor () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
    for _ in 0..<2_000 {
      if predicate() { return }
      await Task.yield()
    }
    XCTFail("Async queue did not reach the expected state", file: file, line: line)
  }

  func testRapidDifferentTapsSerializeAndLastChoiceWins() async {
    let server = Server()
    server.tap("👍")
    await waitUntil { server.calls.count == 1 }
    server.tap("❤️")
    server.tap("🎉")
    XCTAssertEqual(server.calls.count, 1)
    server.complete()
    await waitUntil { server.calls.count == 2 }
    XCTAssertEqual(server.calls.map(\.1), ["👍", "🎉"])
    XCTAssertEqual(ReactionMutations.ownEmoji(server.queue.project(.object([:]), messageID: "a")), "🎉")
    server.complete()
    await waitUntil { server.queue.pendingCount == 0 }
    XCTAssertEqual(server.own["a"], "🎉")
  }

  func testDoubleTapClearsUsingTheSameStringAndNoNullRequest() async {
    let server = Server()
    server.tap("👍")
    await waitUntil { server.calls.count == 1 }
    server.tap("👍")
    XCTAssertNil(ReactionMutations.ownEmoji(server.queue.project(.object([:]), messageID: "a")))
    server.complete()
    await waitUntil { server.calls.count == 2 }
    XCTAssertEqual(server.calls.map(\.1), ["👍", "👍"])
    server.complete()
    await waitUntil { server.queue.pendingCount == 0 }
    XCTAssertNil(server.own["a"])
  }

  func testReturnToInflightChoiceCoalescesObsoleteIntermediateTap() async {
    let server = Server()
    server.tap("👍")
    await waitUntil { server.calls.count == 1 }
    server.tap("❤️")
    server.tap("👍")
    server.complete()
    await waitUntil { server.queue.pendingCount == 0 }
    XCTAssertEqual(server.calls.map(\.1), ["👍"])
    XCTAssertEqual(server.own["a"], "👍")
  }

  func testSynchronousDoubleTapNeedsNoRequest() async {
    let server = Server()
    server.tap("👍")
    server.tap("👍")
    await waitUntil { server.queue.pendingCount == 0 }
    XCTAssertTrue(server.calls.isEmpty)
  }

  func testExistingOwnReactionCanBeCleared() async {
    let server = Server()
    server.own["a"] = "👍"
    server.tap("👍")
    await waitUntil { server.calls.count == 1 }
    server.complete()
    await waitUntil { server.queue.pendingCount == 0 }
    XCTAssertNil(server.own["a"])
  }

  func testUnrelatedMessageCompletesWhileFirstMessageWaits() async {
    let server = Server()
    server.tap("👍", id: "a")
    server.tap("❤️", id: "b")
    await waitUntil { server.calls.count == 2 }
    server.complete("b")
    await waitUntil { server.queue.pendingCount == 1 }
    XCTAssertEqual(server.received.map(\.id), ["b"])
    XCTAssertNotNil(server.waiting["a"])
    server.complete("a")
    await waitUntil { server.queue.pendingCount == 0 }
  }

  func testOptimismPreservesOtherActorsAndUnrelatedMetadata() async {
    let server = Server()
    server.tap("❤️")
    await waitUntil { server.calls.count == 1 }
    let metadata: JSON = .object([
      "unrelated": .string("keep"),
      "reactions": .array([
        .object(["by": .string("bot-1"), "emoji": .string("👍")]),
        .object(["by": .string("me"), "emoji": .string("🎉")]),
        .object(["by": .string("me"), "emoji": .string("👍")]),
        .object(["by": .string("bot-2"), "emoji": .string("❤️")]),
      ]),
    ])
    let result = server.queue.project(metadata, messageID: "a")
    XCTAssertEqual(result["unrelated"], .string("keep"))
    XCTAssertEqual(result["reactions"].array.filter { $0["by"].string != "me" },
      metadata["reactions"].array.filter { $0["by"].string != "me" })
    XCTAssertEqual(result["reactions"].array.filter { $0["by"].string == "me" }.count, 1)
    XCTAssertEqual(ReactionMutations.ownEmoji(result), "❤️")
    XCTAssertEqual(server.queue.project(metadata, messageID: "another"), metadata)
    server.complete()
    await waitUntil { server.queue.pendingCount == 0 }
  }

  func testFailureDropsQueuedMutationAndReadsOnceWithoutBlindRetry() async {
    let server = Server()
    server.tap("👍")
    await waitUntil { server.calls.count == 1 }
    server.tap("❤️")
    server.fail()
    await waitUntil { server.queue.pendingCount == 0 }
    XCTAssertEqual(server.calls.count, 1)
    XCTAssertEqual(server.failures, 1)
    XCTAssertTrue(server.queue.uncertain.isEmpty)
    XCTAssertTrue(server.received.isEmpty)
  }

  func testUnconfirmedFailureBlocksMutationAndNextTapOnlyRetriesRead() async {
    let server = Server()
    server.recovered = false
    server.tap("👍")
    await waitUntil { server.calls.count == 1 }
    server.fail()
    await waitUntil { server.queue.pendingCount == 0 }
    XCTAssertEqual(server.queue.uncertain, ["a"])
    server.recovered = true
    XCTAssertFalse(server.tap("❤️"))
    await waitUntil { server.queue.uncertain.isEmpty }
    XCTAssertEqual(server.calls.count, 1)
    XCTAssertEqual(server.failures, 2)
    XCTAssertTrue(server.tap("❤️"))
    await waitUntil { server.calls.count == 2 }
    server.complete()
    await waitUntil { server.queue.pendingCount == 0 }
  }

  func testCommittedButLostResponseDoesNotRetoggleAndNextDeliberateTapCanClear() async {
    let server = Server()
    server.tap("👍")
    await waitUntil { server.calls.count == 1 }
    server.own["a"] = "👍" // The server committed, then the response was lost.
    server.fail()
    await waitUntil { server.queue.pendingCount == 0 }
    XCTAssertEqual(server.calls.count, 1)
    XCTAssertEqual(server.own["a"], "👍")
    server.tap("👍")
    await waitUntil { server.calls.count == 2 }
    server.complete()
    await waitUntil { server.queue.pendingCount == 0 }
    XCTAssertNil(server.own["a"])
  }

  func testAccountCancellationIgnoresLateResponseAndDiscardsQueue() async {
    let server = Server()
    server.tap("👍")
    await waitUntil { server.calls.count == 1 }
    server.tap("❤️")
    server.queue.cancelAll()
    server.complete()
    for _ in 0..<20 { await Task.yield() }
    XCTAssertEqual(server.queue.pendingCount, 0)
    XCTAssertTrue(server.received.isEmpty)
    XCTAssertEqual(server.calls.count, 1)
    XCTAssertEqual(server.failures, 0)
  }

  func testMismatchedSuccessfulResponseStopsInsteadOfRetogglingForever() async {
    let server = Server()
    server.tap("👍")
    await waitUntil { server.calls.count == 1 }
    server.waiting.removeValue(forKey: "a")!.resume(returning: server.message())
    await waitUntil { server.queue.pendingCount == 0 }
    XCTAssertEqual(server.calls.count, 1)
    XCTAssertEqual(server.failures, 1)
    XCTAssertTrue(server.received.isEmpty)
  }

  func testReadStartedBeforeTapRereadsAfterAckInsteadOfRestoringOldEmoji() async throws {
    let server = Server()
    var reads: [CheckedContinuation<Message, Error>] = []
    let reading = Task {
      try await server.queue.read {
        try await withCheckedThrowingContinuation { reads.append($0) }
      }
    }
    await waitUntil { reads.count == 1 }
    server.tap("❤️")
    await waitUntil { server.calls.count == 1 }
    server.complete()
    await waitUntil { server.queue.pendingCount == 0 }
    reads[0].resume(returning: server.message())
    await waitUntil { reads.count == 2 }
    reads[1].resume(returning: server.message(own: "❤️"))
    let safe = try await reading.value
    let merged = MessageMerge.merge(server.received, [safe])
    XCTAssertEqual(ReactionMutations.ownEmoji(merged[0].metadata), "❤️")
    XCTAssertEqual(reads.count, 2)
  }

  func testReadStartedDuringMutationAlsoRereadsWhenAckAdvancesRevision() async throws {
    let server = Server()
    server.tap("👍")
    await waitUntil { server.calls.count == 1 }
    var reads: [CheckedContinuation<Message, Error>] = []
    let reading = Task {
      try await server.queue.read {
        try await withCheckedThrowingContinuation { reads.append($0) }
      }
    }
    await waitUntil { reads.count == 1 }
    server.complete()
    await waitUntil { server.queue.pendingCount == 0 }
    reads[0].resume(returning: server.message())
    await waitUntil { reads.count == 2 }
    reads[1].resume(returning: server.message(own: "👍"))
    let result = try await reading.value
    XCTAssertEqual(ReactionMutations.ownEmoji(result.metadata), "👍")
  }

  func testContinuousReactionChangesDiscardSecondStaleReadWithoutUnboundedRetry() async {
    let server = Server()
    var reads: [CheckedContinuation<Message, Error>] = []
    let reading = Task {
      try await server.queue.read {
        try await withCheckedThrowingContinuation { reads.append($0) }
      }
    }
    await waitUntil { reads.count == 1 }
    server.tap("👍")
    await waitUntil { server.calls.count == 1 }
    reads[0].resume(returning: server.message())
    await waitUntil { reads.count == 2 }
    server.tap("❤️")
    reads[1].resume(returning: server.message())
    do {
      _ = try await reading.value
      XCTFail("A stale second read must never reach message merge")
    } catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertEqual(reads.count, 2)
    server.queue.cancelAll()
    server.complete()
  }

  func testStableReadDoesNotRetryOrMutate() async throws {
    let server = Server()
    var count = 0
    let result = try await server.queue.read { count += 1; return server.message(own: "❤️") }
    XCTAssertEqual(count, 1)
    XCTAssertEqual(ReactionMutations.ownEmoji(result.metadata), "❤️")
    XCTAssertTrue(server.calls.isEmpty)
  }

  func testOneHundredTapsAcrossTenMessagesKeepFinalIntent() async {
    let server = Server()
    var expected: [String: String] = [:]
    let emojis = ["👍", "❤️", "🎉", "👀", "😂", "🙏"]
    for index in 0..<10 { server.tap("👍", id: "m\(index)"); expected["m\(index)"] = "👍" }
    await waitUntil { server.calls.count == 10 }
    for index in 0..<100 {
      let id = "m\(index % 10)"
      let emoji = emojis[(index / 10 + index) % emojis.count]
      expected[id] = expected[id] == emoji ? nil : emoji
      server.tap(emoji, id: id)
    }
    XCTAssertEqual(server.calls.count, 10)
    for _ in 0..<2_000 where server.queue.pendingCount > 0 {
      for id in Array(server.waiting.keys) { server.complete(id) }
      for _ in 0..<20 { await Task.yield() }
    }
    XCTAssertEqual(server.queue.pendingCount, 0)
    XCTAssertEqual(server.own, expected)
    XCTAssertLessThanOrEqual(server.calls.count, 20)
    XCTAssertEqual(server.failures, 0)
  }
}
