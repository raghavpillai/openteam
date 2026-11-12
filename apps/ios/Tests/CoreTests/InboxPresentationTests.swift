import XCTest

@testable import OpenTeamCore

final class InboxPresentationTests: XCTestCase {
  private func message(_ content: String = "Latest reply", metadata: JSON = .object([:])) -> Message {
    Message(id: "message", sequence: "10", channelId: "channel", sender: "agent",
      senderBotId: "bot", content: content, metadata: metadata, createdAt: "2026-11-09T12:00:00Z")
  }

  private func question() -> Message {
    message("Fallback question", metadata: .object([
      "type": .string("widget"),
      "widget": .object([
        "prompt": .string("What should I draft for **Jayne**?"),
        "helpText": .string("Still on track or delayed?"),
        "options": .array([.object(["label": .string("Still on track"), "value": .string("yes")])]),
        "allowCustom": .bool(true),
      ]),
    ]))
  }

  private func run(_ status: String, channelID: String? = "channel") -> Run {
    Run(id: "run", botId: "bot", channelId: channelID, status: status)
  }

  func testRunningAndQueuedWorkIncludesBackgroundRuns() {
    for status in ["queued", "running"] {
      XCTAssertEqual(InboxPresentation.activity(latest: nil, runs: [run(status)]), .working)
      XCTAssertEqual(
        InboxPresentation.activity(latest: message(), runs: [run(status, channelID: nil)]), .working)
    }
    for status in ["completed", "failed", "cancelled", "interrupted"] {
      XCTAssertEqual(InboxPresentation.activity(latest: message(), runs: [run(status)]), .idle)
    }
    XCTAssertEqual(InboxPresentation.activity(latest: nil, runs: []), .idle)
    XCTAssertEqual(
      InboxPresentation.activity(latest: nil, runs: [run("completed"), run("running")]), .working)
  }

  func testPendingQuestionTakesPriorityOverRunningWork() {
    XCTAssertEqual(InboxPresentation.activity(latest: question(), runs: []), .needsAnswer)
    XCTAssertEqual(InboxPresentation.activity(latest: question(), runs: [run("running")]), .needsAnswer)
    var pending = question()
    pending.metadata["cardState"] = .string("pending")
    XCTAssertEqual(InboxPresentation.activity(latest: pending, runs: []), .needsAnswer)
  }

  func testAnsweredDismissedAndTerminalQuestionsClearWaiting() {
    for (key, value) in [
      ("respondedValue", JSON.string("yes")), ("respondedValue", .string("")),
      ("widgetDismissed", .bool(true)), ("cardState", .string("answered")),
      ("cardState", .string("dismissed")), ("cardState", .string("expired")),
    ] {
      var resolved = question()
      resolved.metadata[key] = value
      XCTAssertEqual(InboxPresentation.activity(latest: resolved, runs: []), .idle, key)
      XCTAssertEqual(
        InboxPresentation.activity(latest: resolved, runs: [run("running")]), .working, key)
    }
  }

  private var calendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/New_York")!
    return calendar
  }

  private func date(_ value: String) -> Date {
    ISO8601DateFormatter().date(from: value)!
  }
}
