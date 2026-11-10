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

  func testPendingHistoryQuestionTakesPriorityWhilePreviewUsesLatestUserOrAgentMessage() {
    let pending = question()
    var latest = message("The latest update")
    latest.id = "latest"
    latest.sequence = "11"
    for sender in ["user", "agent"] {
      latest.sender = sender
      XCTAssertEqual(InboxPresentation.activity(latest: latest, runs: [run("running")],
        messages: [pending, latest]), .needsAnswer)
      XCTAssertEqual(InboxPresentation.preview(latest), "The latest update")
      XCTAssertNil(InboxPresentation.previewSymbol(latest))
    }
    XCTAssertEqual(InboxPresentation.activity(latest: nil, runs: [], messages: [pending]), .needsAnswer)
  }

  func testResolvedHistoryQuestionAndAuthoritativeLatestCopyClearWaiting() {
    let pending = question()
    var latest = message("The latest update")
    latest.id = "latest"
    for (key, value) in [("respondedValue", JSON.string("yes")), ("widgetDismissed", .bool(true))] {
      var resolved = pending
      resolved.metadata[key] = value
      XCTAssertEqual(InboxPresentation.activity(latest: latest, runs: [run("running")],
        messages: [resolved, latest]), .working)
      XCTAssertEqual(InboxPresentation.activity(latest: resolved, runs: [], messages: [pending]), .idle)
      XCTAssertEqual(InboxPresentation.activity(latest: pending, runs: [], messages: [resolved]), .needsAnswer)
    }
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

  func testOrdinaryQuestionsUserMessagesAndBranchesDoNotAskForAnAnswer() {
    XCTAssertEqual(InboxPresentation.activity(latest: message("What now?"), runs: []), .idle)
    var user = question()
    user.sender = "user"
    user.senderBotId = nil
    XCTAssertEqual(InboxPresentation.activity(latest: user, runs: []), .idle)
    var branch = question()
    branch.metadata["branched"] = .bool(true)
    XCTAssertEqual(InboxPresentation.activity(latest: branch, runs: []), .idle)
    let malformed = message("Question?", metadata: .object(["type": .string("widget")]))
    XCTAssertEqual(InboxPresentation.activity(latest: malformed, runs: []), .idle)
    var noActions = question()
    noActions.metadata["widget"]["options"] = .array([])
    noActions.metadata["widget"]["allowCustom"] = .bool(false)
    XCTAssertEqual(InboxPresentation.activity(latest: noActions, runs: []), .idle)
    noActions.metadata["widget"]["allowCustom"] = .bool(true)
    XCTAssertEqual(InboxPresentation.activity(latest: noActions, runs: []), .needsAnswer)
  }

  func testPendingCardsAndTheirDurableOutcomes() {
    for type in ["secret-request", "user-form", "external-draft", "imessage-send", "computer-handoff"] {
      var card = message(metadata: .object(["type": .string(type), "cardState": .string("pending")]))
      XCTAssertEqual(InboxPresentation.activity(latest: card, runs: []), .needsAnswer, type)
      for state in ["submitted", "sent", "dismissed", "expired", "escalated", "sending"] {
        card.metadata["cardState"] = .string(state)
        XCTAssertEqual(InboxPresentation.activity(latest: card, runs: []), .idle, "\(type) \(state)")
      }
    }
    let secret = message(metadata: .object([
      "type": .string("secret-request"), "secretProvided": .bool(true),
    ]))
    XCTAssertEqual(InboxPresentation.activity(latest: secret, runs: []), .idle)
    for state in ["completed", "skipped", "dismissed"] {
      let handoff = message(metadata: .object([
        "type": .string("computer-handoff"), "computerHandoffState": .string(state),
      ]))
      XCTAssertEqual(InboxPresentation.activity(latest: handoff, runs: []), .idle)
    }
    XCTAssertEqual(InboxPresentation.activity(latest: message(metadata: .object([
      "type": .string("bot-template"), "cardState": .string("pending"),
    ])), runs: []), .idle)
  }

  func testWidgetPreviewCombinesReadablePromptAndHelpWithChecklistSymbol() {
    XCTAssertEqual(InboxPresentation.preview(question()),
      "What should I draft for Jayne? — Still on track or delayed?")
    XCTAssertEqual(InboxPresentation.previewSymbol(question()), "checklist")
    var answered = question()
    answered.metadata["respondedValue"] = .string("yes")
    XCTAssertEqual(InboxPresentation.preview(answered), InboxPresentation.preview(question()))
    XCTAssertEqual(InboxPresentation.activity(latest: answered, runs: []), .idle)
    answered.metadata["widget"]["helpText"] = .string(" \n ")
    XCTAssertEqual(InboxPresentation.preview(answered), "What should I draft for Jayne? — Still on track")
    answered.metadata["widget"] = .null
    XCTAssertEqual(InboxPresentation.preview(answered), "Fallback question")
  }

  func testQuestionPreviewIncludesChoicesWithoutAddingHelpTextToTheCard() {
    var choice = question()
    choice.metadata["widget"]["helpText"] = .null
    choice.metadata["widget"]["options"] = .array([
      .object(["label": .string("**Still** on track")]),
      .object(["label": .string("Delayed on customs")]),
    ])
    XCTAssertEqual(InboxPresentation.preview(choice),
      "What should I draft for Jayne? — Still on track, Delayed on customs")
    choice.metadata["widget"]["options"] = .array([])
    XCTAssertEqual(InboxPresentation.preview(choice), "What should I draft for Jayne?")
  }

  func testLatestUserAndBotPreviewRetainsSharedTextAndAttachmentBehaviorWhileWorking() {
    var latest = message("Done. The [CRM](https://example.com) is **updated**.\nMore details")
    for sender in ["user", "agent"] {
      latest.sender = sender
      XCTAssertEqual(InboxPresentation.activity(latest: latest, runs: [run("running")]), .working)
      XCTAssertEqual(InboxPresentation.preview(latest), "Done. The CRM is updated.")
      XCTAssertEqual(InboxPresentation.preview(latest), latest.previewText)
      XCTAssertNil(InboxPresentation.previewSymbol(latest))
    }
    latest.content = "chart.png"
    latest.metadata = .object([
      "type": .string("attachment"), "attachment": .object([
        "assetId": .string("asset"), "fileName": .string("chart.png"),
        "mimeType": .string("image/png"), "byteSize": .number(42), "kind": .string("image"),
      ]),
    ])
    XCTAssertEqual(InboxPresentation.preview(latest), "Sent 1 image")
    // Once a newer ordinary message is supplied, older widgets cannot affect this API.
    XCTAssertEqual(InboxPresentation.activity(latest: latest, runs: []), .idle)
  }

  func testWidgetPreviewIsSingleLineAndUsesSharedLengthLimit() {
    var long = question()
    long.metadata["widget"]["prompt"] = .string("**Choose**\none")
    long.metadata["widget"]["helpText"] = .string(String(repeating: "more ", count: 100))
    let preview = InboxPresentation.preview(long)
    XCTAssertTrue(preview.hasPrefix("Choose one — more"))
    XCTAssertFalse(preview.contains("\n"))
    XCTAssertEqual(preview.utf16.count, MessagePreview.limit)
    XCTAssertTrue(preview.hasSuffix("…"))
  }

  private var calendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/New_York")!
    return calendar
  }

  private func date(_ value: String) -> Date {
    ISO8601DateFormatter().date(from: value)!
  }

  private func label(_ value: String, now: String) -> String {
    InboxPresentation.dateLabel(date(value), now: date(now), calendar: calendar,
      locale: Locale(identifier: "en_US_POSIX"))
  }

  func testDatesUseLocalCalendarDayBoundariesAndFullWeekdays() {
    let now = "2026-11-09T15:30:00Z"
    XCTAssertEqual(label("2026-11-09T05:00:00Z", now: now), "12:00 AM")
    XCTAssertEqual(label("2026-11-09T20:03:00Z", now: now), "3:03 PM")
    XCTAssertEqual(label("2026-11-09T04:59:59Z", now: now), "Yesterday")
    XCTAssertEqual(label("2026-11-07T17:00:00Z", now: now), "Saturday")
    XCTAssertEqual(label("2026-11-03T17:00:00Z", now: now), "Tuesday")
    XCTAssertEqual(label("2026-11-02T17:00:00Z", now: now), "Nov 2")
    XCTAssertEqual(label("2026-09-30T17:00:00Z", now: now), "Sep 30")
    XCTAssertEqual(label("2025-12-31T17:00:00Z", now: now), "Dec 31")
  }

  func testYesterdayAndWeekBoundariesAcrossDaylightSavingChanges() {
    // The previous calendar day can be 23 or 25 hours away.
    XCTAssertEqual(label("2026-03-08T05:30:00Z", now: "2026-03-09T04:30:00Z"), "Yesterday")
    XCTAssertEqual(label("2026-11-01T04:30:00Z", now: "2026-11-02T05:30:00Z"), "Yesterday")
    XCTAssertEqual(label("2026-11-01T04:30:00Z", now: "2026-11-07T05:30:00Z"), "Sunday")
    XCTAssertEqual(label("2026-11-01T04:30:00Z", now: "2026-11-08T05:30:00Z"), "Nov 1")
    XCTAssertEqual(label("2025-12-31T23:00:00Z", now: "2026-01-01T17:00:00Z"), "Yesterday")
  }

  func testWeekdayUsesSuppliedLocaleAndCalendarTimeZone() {
    XCTAssertEqual(InboxPresentation.dateLabel(date("2026-11-07T17:00:00Z"),
      now: date("2026-11-09T15:30:00Z"), calendar: calendar, locale: Locale(identifier: "fr_FR")),
      "samedi")
    var tokyo = calendar
    tokyo.timeZone = TimeZone(identifier: "Asia/Tokyo")!
    XCTAssertEqual(InboxPresentation.dateLabel(date("2026-11-09T04:59:59Z"),
      now: date("2026-11-09T15:30:00Z"), calendar: tokyo, locale: Locale(identifier: "en_US_POSIX")),
      "Yesterday")
  }
}
