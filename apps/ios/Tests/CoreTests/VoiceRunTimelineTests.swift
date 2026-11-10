import XCTest

@testable import OpenTeamCore

final class VoiceRunTimelineTests: XCTestCase {
  func message(_ id: String, session: String? = nil) -> Message {
    let metadata: JSON =
      session.map { .object(["voice": .object(["sessionId": .string($0)])]) } ?? .object([:])
    return Message(
      id: id, sequence: id, channelId: "chat", sender: "agent", content: id, metadata: metadata,
      createdAt: "2026-09-19T12:00:00Z")
  }
  func testConsecutiveVoiceMessagesFoldIntoOneEntry() {
    let timeline = MessageTimeline([
      message("1", session: "a"), message("2", session: "a"), message("3"),
      message("4", session: "a"), message("5", session: "b"),
    ])
    XCTAssertEqual(timeline.entries.map(\.id), ["1", "3", "4", "5"])
    XCTAssertEqual(timeline.entries[0].voiceRun.map(\.id), ["1", "2"])
    XCTAssertTrue(timeline.entries[1].voiceRun.isEmpty)
  }
}
