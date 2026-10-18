import XCTest

@testable import OpenTeamCore

final class ShareDirectoryTests: XCTestCase {
  /// Bots Research, Ops and Build, each with a direct chat.
  private func bootstrap() throws -> Bootstrap {
    let url = Bundle.module.url(forResource: "bootstrap", withExtension: "json", subdirectory: "Fixtures")!
    var bootstrap = try JSONDecoder().decode(Bootstrap.self, from: Data(contentsOf: url))
    bootstrap.latestMessages = []
    for index in bootstrap.channels.indices { bootstrap.channels[index].updatedAt = "2026-10-01T09:00:00.000Z" }
    return bootstrap
  }
  private func message(_ channelID: String, at time: String) -> Message {
    Message(
      id: channelID + time, sequence: "1", channelId: channelID, sender: "user", content: "Hi",
      metadata: .object([:]), createdAt: time)
  }
  private func group(_ id: String, _ name: String, members: [String], from template: Channel) -> Channel {
    var group = template
    group.id = id
    group.kind = "group"
    group.name = name
    group.members = members.enumerated().map { .init(botId: $0.element, ordinal: $0.offset) }
    return group
  }

  func testDirectChatsAndGroupsAreListedMostRecentFirst() throws {
    var data = try bootstrap()
    data.channels[1].updatedAt = "2026-10-01T11:00:00.000Z"
    data.channels[2].updatedAt = "2026-10-01T10:00:00.000Z"
    var team = group("channel-team", "Launch", members: ["bot-build", "bot-ops"], from: data.channels[0])
    team.updatedAt = "2026-10-01T10:30:00.000Z"
    data.channels.append(team)
    let list = ShareDirectory.destinations(data)
    XCTAssertEqual(list.map(\.id), ["channel-ops", "channel-team", "channel-build", "channel-research"])
    XCTAssertEqual(list[0].bot?.id, "bot-ops")
    XCTAssertNil(list[1].bot)
    XCTAssertEqual(list[1].members.map(\.id), ["bot-build", "bot-ops"])
  }

  func testANewerMessageOutranksAnOlderUpdateTime() throws {
    var data = try bootstrap()
    data.channels[0].updatedAt = "2026-10-01T12:00:00.000Z"
    data.latestMessages = [
      message("channel-build", at: "2026-09-30T08:00:00Z"),
      message("channel-build", at: "2026-10-02T08:00:00.000Z"),
    ]
    XCTAssertEqual(ShareDirectory.destinations(data).map(\.id).prefix(2), ["channel-build", "channel-research"])
  }

  func testEqualTimesKeepTheServerOrder() throws {
    XCTAssertEqual(
      ShareDirectory.destinations(try bootstrap()).map(\.id),
      ["channel-research", "channel-ops", "channel-build"])
  }

  func testOnlyBotChatsAndGroupsCanBeShareTargets() throws {
    var data = try bootstrap()
    data.bots.removeAll { $0.id == "bot-ops" }
    var other = data.channels[0]
    other.id = "channel-other"
    other.kind = "system"
    data.channels.append(other)
    XCTAssertEqual(ShareDirectory.destinations(data).map(\.id), ["channel-research", "channel-build"])
  }

  func testHiddenChatsAppearOnlyWhenSearchedForOrChosen() throws {
    var data = try bootstrap()
    data.bots[1].hiddenFromSidebar = true
    data.channels[2].hiddenFromSidebar = true
    let list = ShareDirectory.destinations(data)
    XCTAssertEqual(ShareDirectory.visible(list, query: "", selected: []).map(\.id), ["channel-research"])
    XCTAssertEqual(
      ShareDirectory.visible(list, query: "", selected: ["channel-ops"]).map(\.id),
      ["channel-research", "channel-ops"])
    XCTAssertEqual(ShareDirectory.visible(list, query: " build ", selected: []).map(\.id), ["channel-build"])
  }

  func testSearchMatchesGroupMembers() throws {
    var data = try bootstrap()
    data.channels.append(group("channel-team", "Launch", members: ["bot-ops"], from: data.channels[0]))
    XCTAssertEqual(
      ShareDirectory.visible(ShareDirectory.destinations(data), query: "OPS", selected: []).map(\.id),
      ["channel-ops", "channel-team"])
  }
}
