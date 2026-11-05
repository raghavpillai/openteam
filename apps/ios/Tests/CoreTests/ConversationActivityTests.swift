import XCTest
@testable import OpenTeamCore

final class ConversationActivityTests: XCTestCase {
  func testBackgroundActivityLifecycleAndScope() throws {
    let bootstrap = try ProtocolTests().fixture()
    var channel = bootstrap.channels[0]
    channel.kind = "bot_dm"
    let botId = bootstrap.bots[0].id
    var task = SubagentActivity(id: "task", parentBotId: botId,
      parentChannelId: channel.id, runInBackground: true, status: "provisioning")
    func activity(_ task: SubagentActivity) -> ConversationActivity? {
      .resolve(channel: channel, botId: botId, runs: [], subagents: [task])
    }
    for status in ["provisioning", "queued", "running"] {
      task.status = status
      XCTAssertEqual(activity(task), .background, status)
    }
    for status in ["waiting", "blocked", "completed", "failed", "stopped", "unknown"] {
      task.status = status
      XCTAssertNil(activity(task), status)
    }
    task.status = "running"
    task.runInBackground = false
    XCTAssertNil(activity(task))
    task.runInBackground = true
    task.parentBotId = "another-bot"
    XCTAssertNil(activity(task))
    task.parentBotId = botId
    task.parentChannelId = "another-chat"
    XCTAssertNil(activity(task))
    task.parentChannelId = channel.id
    channel.kind = "group"
    XCTAssertNil(activity(task))
    channel.kind = "bot_dm"
    XCTAssertNil(ConversationActivity.resolve(channel: channel, botId: nil, runs: [], subagents: [task]))
    XCTAssertNil(ConversationActivity.resolve(channel: channel, botId: botId, runs: [], subagents: []))

    var run = Run(id: "run", botId: botId, channelId: channel.id, status: "running")
    XCTAssertEqual(ConversationActivity.resolve(channel: channel, botId: botId, runs: [run], subagents: [task]), .foreground)
    run.status = "completed"
    XCTAssertEqual(ConversationActivity.resolve(channel: channel, botId: botId, runs: [run], subagents: [task]), .background)
  }

  func testParkedRequestsAndChildrenStaySilentUntilAnActualWake() throws {
    let bootstrap = try ProtocolTests().fixture()
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
      parentChannelId: channel.id, runInBackground: true, status: "waiting")
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

  func testBootstrapDecodesAndPersistsTasksAndReadsOlderCaches() throws {
    let original = try ProtocolTests().fixture()
    var payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(original)) as! [String: Any]
    payload["subagents"] = [["id": "task", "parentBotId": "bot", "parentChannelId": "chat",
      "runInBackground": true, "status": "queued", "description": "Extra contract fields are allowed"]]
    let bootstrap = try JSONDecoder().decode(Bootstrap.self, from: JSONSerialization.data(withJSONObject: payload))
    let saved = try JSONDecoder().decode(Bootstrap.self, from: JSONEncoder().encode(bootstrap))
    XCTAssertEqual(saved.subagents?.first?.id, "task")
    XCTAssertEqual(saved.subagents?.first?.isActive, true)
    payload.removeValue(forKey: "subagents")
    let legacy = try JSONDecoder().decode(Bootstrap.self, from: JSONSerialization.data(withJSONObject: payload))
    XCTAssertNil(legacy.subagents)
  }
}
