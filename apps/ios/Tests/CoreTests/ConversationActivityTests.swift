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
    for status in ["completed", "failed", "stopped", "unknown"] {
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
