import XCTest

@testable import OpenTeamCore

final class HistoryPerformanceTests: XCTestCase {
  private func history(_ count: Int, nested: Bool = false) throws -> [Message] {
    let url = Bundle.module.url(forResource: "bootstrap", withExtension: "json", subdirectory: "Fixtures")!
    let seed = try JSONDecoder().decode(Bootstrap.self, from: Data(contentsOf: url)).latestMessages[0]
    return (0..<count).map { index in
      var message = seed
      message.id = "message-\(index)"
      message.createdAt = String(format: "2026-09-22T12:%02d:%02d.123Z", index / 60 % 60, index % 60)
      message.metadata = nested && index > 0
        ? .object(["branched": .bool(true), "replyTo": .string("message-\(index - 1)")])
        : .object([:])
      return message
    }
  }

  func testThousandMessageTimelineRebuild() throws {
    let rows = try history(1_000)
    measure {
      let timeline = MessageTimeline(rows)
      XCTAssertEqual(timeline.entries.count, 1_000)
      XCTAssertNotNil(timeline.entries.first?.timestamp)
    }
  }

  func testDeepReplyCounts() throws {
    let rows = try history(1_000, nested: true).reversed()
    measure {
      let counts = ThreadProjection.replyCounts(in: Array(rows))
      XCTAssertEqual(counts.count, 999)
      XCTAssertEqual(counts["message-0"], 999)
      XCTAssertEqual(counts["message-500"], 499)
    }
  }

  func testDeepReplyPage() throws {
    let rows = try history(1_000, nested: true)
    measure {
      let page = ThreadProjection.messages(root: rows[0], in: rows.reversed())
      XCTAssertEqual(page.map(\.id), rows.map(\.id))
    }
  }

  func testTimestampCacheEvictionPreservesDates() throws {
    var message = try XCTUnwrap(history(1).first)
    let original = message.createdAt
    let expected = try XCTUnwrap(message.date)
    for index in 0..<2_100 {
      message.createdAt = "invalid-\(index)"
      XCTAssertNil(message.date)
    }
    message.createdAt = original
    XCTAssertEqual(message.date, expected)
  }

  func testMessageDatesPreserveExistingParsingAcrossThreads() throws {
    let seed = try XCTUnwrap(history(1).first)
    let timestamps = ["2026-09-22T12:34:56Z", "2026-09-22T12:34:56.123Z",
      "2026-09-22T12:34:56.123456+05:30", "2026-09-22T12:34:56-04:00", "", "invalid"]
    let expected = timestamps.map {
      ISO8601DateFormatter().date(from: $0) ?? ISO8601DateFormatter.fractional.date(from: $0)
    }
    DispatchQueue.concurrentPerform(iterations: 40) { _ in
      for (index, timestamp) in timestamps.enumerated() {
        var message = seed
        message.createdAt = timestamp
        if let date = message.date, let expected = expected[index] {
          XCTAssertEqual(date.timeIntervalSince1970, expected.timeIntervalSince1970, accuracy: 0.000_001)
        } else { XCTAssertEqual(message.date, expected[index]) }
      }
    }
  }
}
