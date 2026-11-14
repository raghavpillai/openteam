import XCTest

@testable import OpenTeamCore

/// The same cases as the desktop's packages/product-core/test/bot-avatar.test.ts.
final class BotAvatarActivityTests: XCTestCase {
  private func item(
    id: String = "i", kind: String = "tool_call", status: String = "running", tool: String? = nil,
    createdAt: String = "2026-11-13T00:00:00.000Z"
  ) -> RunItem {
    .init(
      id: id, runId: "run", kind: kind, status: status, title: nil,
      content: tool.map { .object(["tool": .string($0)]) } ?? .object([:]), createdAt: createdAt,
      updatedAt: createdAt)
  }
  private func mode(_ items: [RunItem]) -> RobotAvatarMode { BotActivityKind(items: items).avatarMode }
  private func card(_ metadata: [String: JSON], bot: String = "one") -> Message {
    .init(
      id: "m", clientId: nil, sequence: "1", channelId: "chat", sender: "agent", senderBotId: bot,
      sourceRunId: nil, content: "", metadata: .object(metadata), createdAt: "")
  }
  private let running = Run(id: "run", botId: "one", channelId: "chat", status: "running")

  func testShowsWhatTheNewestLiveItemIsDoing() {
    // Reasoning steps never reach a client, so a run with no live step is thinking.
    XCTAssertEqual(mode([]), .thinking)
    XCTAssertEqual(mode([item(kind: "reasoning")]), .thinking)
    XCTAssertEqual(mode([item(tool: "WebSearch")]), .searching)
    XCTAssertEqual(mode([item(tool: "SendToUser")]), .typing)
    XCTAssertEqual(mode([item(tool: "GenerateImage")]), .generating)
    XCTAssertEqual(mode([item(tool: "CallDynamicTool")]), .connecting)
    XCTAssertEqual(mode([item(tool: "AwaitShell")]), .connecting)
    XCTAssertEqual(mode([item(tool: "RequestUserForm")]), .connecting)
    XCTAssertEqual(mode([item(tool: "Write")]), .writing)
    XCTAssertEqual(mode([item(tool: "SendToAgent")]), .sending)
    XCTAssertEqual(mode([item(tool: "Task")]), .working)
    XCTAssertEqual(mode([item(tool: "browser_click")]), .working)
    XCTAssertEqual(mode([item(tool: "Shell")]), .working)
    XCTAssertEqual(mode([item(tool: "unknown")]), .working)
    XCTAssertEqual(mode([item(status: "completed", tool: "WebSearch")]), .thinking)
    XCTAssertEqual(
      mode([
        item(id: "a", tool: "WebSearch", createdAt: "2026-11-13T00:00:01.000Z"),
        item(id: "b", tool: "Shell", createdAt: "2026-11-13T00:00:02.000Z"),
      ]), .working)
  }
  func testWaitsOnACardThePersonHasNotAnsweredYet() {
    XCTAssertTrue(BotAvatarActivity.isWaitingOnUser(card(["type": .string("user-form")]), botId: "one"))
    XCTAssertTrue(
      BotAvatarActivity.isWaitingOnUser(
        card(["type": .string("external-draft"), "cardState": .string("pending")]), botId: "one"))
    XCTAssertFalse(
      BotAvatarActivity.isWaitingOnUser(
        card(["type": .string("external-draft"), "cardState": .string("sent")]), botId: "one"))
    XCTAssertTrue(BotAvatarActivity.isWaitingOnUser(card(["type": .string("secret-request")]), botId: "one"))
    XCTAssertFalse(
      BotAvatarActivity.isWaitingOnUser(
        card(["type": .string("secret-request"), "secretProvided": .bool(true)]), botId: "one"))
    XCTAssertFalse(BotAvatarActivity.isWaitingOnUser(card(["type": .string("widget")]), botId: "one"))
    XCTAssertFalse(
      BotAvatarActivity.isWaitingOnUser(card(["type": .string("user-form")], bot: "two"), botId: "one"))
  }
  func testRunningBeatsWaitingWhichBeatsASettledOutcome() {
    let form = card(["type": .string("user-form")])
    func resolve(run: Run? = nil, items: [RunItem]? = nil, latest: Message? = nil, settled: SettledBotRun? = nil, now: Double = 0)
      -> RobotAvatarMode
    {
      BotAvatarActivity.mode(botId: "one", activeRun: run, items: items, latest: latest, settled: settled, now: now)
    }
    XCTAssertEqual(resolve(), .idle)
    XCTAssertEqual(resolve(latest: form), .waiting)
    XCTAssertEqual(resolve(run: running, items: [], latest: form), .thinking)
    // Other conversations only report that a Bot is busy.
    XCTAssertEqual(resolve(run: running, items: nil), .working)
    XCTAssertEqual(resolve(latest: form, settled: .init(completed: true, at: 1000), now: 1001), .waiting)
    let done = SettledBotRun(completed: true, at: 1000)
    XCTAssertEqual(resolve(settled: done, now: 1000), .done)
    XCTAssertEqual(resolve(settled: done, now: 1007.9), .done)
    XCTAssertEqual(resolve(settled: done, now: 1008), .idle)
    XCTAssertEqual(resolve(settled: .init(completed: false, at: 1000), now: 1004), .failed)
  }
  func testRecordsOnlyFinishesItSawHappen() {
    var watched = WatchedBotRuns()
    func run(_ status: String, _ id: String = "r1") -> Run { .init(id: id, botId: "one", channelId: "chat", status: status) }
    watched.observe(runs: [run("completed")], at: 1) { _ in nil }
    XCTAssertTrue(watched.settled.isEmpty)
    watched.observe(runs: [run("running", "r2")], at: 2) { _ in nil }
    watched.observe(runs: [run("completed", "r2")], at: 3) { _ in nil }
    XCTAssertEqual(watched.settled[WatchedBotRuns.key("chat", "one")], .init(completed: true, at: 3))
    // The next run clears the reaction, and a cancellation never records one.
    watched.observe(runs: [run("running", "r3")], at: 4) { _ in nil }
    XCTAssertTrue(watched.settled.isEmpty)
    watched.observe(runs: [run("cancelled", "r3")], at: 5) { _ in nil }
    XCTAssertTrue(watched.settled.isEmpty)
    // A background run that vanishes counts as done only when its Bot wrote the newest message.
    watched.observe(runs: [run("running", "r4")], at: 6) { _ in nil }
    watched.observe(runs: [], at: 7) { _ in self.card([:]) }
    XCTAssertEqual(watched.settled[WatchedBotRuns.key("chat", "one")], .init(completed: true, at: 7))
    watched.observe(runs: [run("running", "r5")], at: 8) { _ in nil }
    watched.observe(runs: [], at: 9) { _ in nil }
    XCTAssertTrue(watched.settled.isEmpty)
  }
  func testPacesBusyModesAndHandsStatesOver() {
    var pacer = RobotModePacer(.idle)
    pacer.request(.thinking)
    XCTAssertEqual(pacer.shown(at: 0), .thinking)
    // Busy modes hold long enough to read.
    pacer.request(.searching)
    XCTAssertEqual(pacer.shown(at: 0.5), .thinking)
    XCTAssertEqual(pacer.shown(at: 0.95), .searching)
    pacer.request(.done)
    XCTAssertEqual(pacer.shown(at: 1), .done)
    XCTAssertEqual(pacer.shown(at: 6.4), .done)
    XCTAssertEqual(pacer.shown(at: 6.6), .idle)
    pacer.request(.waiting)
    XCTAssertEqual(pacer.shown(at: 10), .waiting)
    XCTAssertEqual(pacer.shown(at: 129), .waiting)
    XCTAssertEqual(pacer.shown(at: 130.1), .drowsy)
    pacer.request(.failed)
    XCTAssertEqual(pacer.shown(at: 131), .failed)
    XCTAssertEqual(pacer.shown(at: 134.1), .idle)
  }
}
