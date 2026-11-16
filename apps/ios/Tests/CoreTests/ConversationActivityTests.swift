import XCTest
@testable import OpenTeamCore

final class ConversationActivityTests: XCTestCase {
  func testParkedRequestsAndChildrenStaySilentUntilAnActualWake() throws {
    let bootstrap = try Fixture.bootstrap()
    var channel = bootstrap.channels[0]
    channel.kind = "bot_dm"
    let botId = bootstrap.bots[0].id
    // Decode the real wire shape, including intentionally unconsumed request fields.
    func run(_ id: String, _ status: String, _ state: String, _ check: Any) throws -> Run {
      let payload: [String: Any] = ["id": id, "channelId": channel.id, "botId": botId,
        "status": status, "requestState": state, "requestNextCheckAt": check]
      return try JSONDecoder().decode(Run.self, from: JSONSerialization.data(withJSONObject: payload))
    }
    let parked = SubagentActivity(id: "parked", parentBotId: botId,
      parentChannelId: channel.id, status: "waiting")
    for check: Any in ["2099-11-04T08:00:00Z", "2020-01-01T00:00:00Z", "invalid", NSNull()] {
      let runs = try [run("old", "completed", "waiting", check),
        run("second-wait", "completed", "waiting", check),
        run("blocked", "completed", "blocked", check),
        run("latest", "completed", "complete", NSNull())]
      XCTAssertNil(ConversationActivity.resolve(channel: channel, botId: botId,
        runs: runs, subagents: [parked]))
      for status in ["queued", "running"] {
        let wake = try run("wake", status, "waiting", check)
        XCTAssertEqual(ConversationActivity.resolve(channel: channel, botId: botId,
          runs: runs + [wake], subagents: [parked]), .foreground)
      }
      for status in ["provisioning", "queued", "running"] {
        var wake = parked
        wake.id = "wake"
        wake.status = status
        XCTAssertEqual(ConversationActivity.resolve(channel: channel, botId: botId,
          runs: runs, subagents: [parked, wake]), .background)
      }
    }
  }

  func testBootstrapAndChannelStateDecodeAndPersistTasks() throws {
    let original = try Fixture.bootstrap()
    var payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(original)) as! [String: Any]
    payload["subagents"] = [["id": "task", "parentBotId": "bot", "parentChannelId": "chat",
      "status": "queued", "description": "Extra contract fields are allowed"]]
    let bootstrap = try JSONDecoder().decode(Bootstrap.self, from: JSONSerialization.data(withJSONObject: payload))
    let saved = try JSONDecoder().decode(Bootstrap.self, from: JSONEncoder().encode(bootstrap))
    XCTAssertEqual(saved.subagents?.first?.id, "task")
    XCTAssertEqual(saved.subagents?.first?.isActive, true)
    let state = try JSONDecoder().decode(ChannelState.self, from: JSONSerialization.data(withJSONObject: [
      "channelId": "chat", "revision": "1", "runs": [], "subagents": payload["subagents"]!,
    ]))
    XCTAssertEqual(state.subagents?.first?.id, "task")
    XCTAssertEqual(state.subagents?.first?.isActive, true)
  }
}
