import XCTest

@testable import OpenTeamCore

final class ConversationComputerTests: XCTestCase {
  private func fixture() throws -> (Channel, [Bot]) {
    let url = Bundle.module.url(forResource: "bootstrap", withExtension: "json", subdirectory: "Fixtures")!
    let bootstrap = try JSONDecoder().decode(Bootstrap.self, from: Data(contentsOf: url))
    let bots = (0..<3).map { index in
      var bot = bootstrap.bots[0]
      bot.id = "bot-\(index)"
      bot.dmChannelId = "dm-\(index)"
      return bot
    }
    var channel = bootstrap.channels[0]
    channel.id = "group"
    channel.kind = "group"
    channel.members = bots.enumerated().map { .init(botId: $0.element.id, ordinal: $0.offset) }
    return (channel, bots)
  }
  private func reply(_ sequence: String, _ bot: Bot, metadata: JSON = .object([:])) -> Message {
    Message(id: sequence, sequence: sequence, channelId: "group", sender: "agent",
      senderBotId: bot.id, content: "Reply", metadata: metadata, createdAt: "2026-09-20T12:00:00Z")
  }
  func testLatestReplyUsesNumericSequenceRegardlessOfHistoryOrder() throws {
    let (channel, bots) = try fixture()
    let messages = [reply("100", bots[2]), reply("9", bots[0]), reply("10", bots[1])]
    XCTAssertEqual(ConversationComputer.target(channel: channel, bots: bots, messages: messages)?.id, bots[2].id)
  }
  func testLaterUserEventsThreadsAndOtherChannelsDoNotChangeResponder() throws {
    let (channel, bots) = try fixture()
    var user = reply("20", bots[0]); user.sender = "user"; user.senderBotId = nil
    var elsewhere = reply("40", bots[0]); elsewhere.channelId = "elsewhere"
    let messages = [reply("10", bots[1]), user, elsewhere,
      reply("50", bots[0], metadata: .object(["branched": .bool(true)])),
      reply("60", bots[0], metadata: .object(["event": .object(["type": .string("renamed")])])),
      reply("70", bots[0], metadata: .object(["toAgent": .string("peer")]))]
    XCTAssertEqual(ConversationComputer.target(channel: channel, bots: bots, messages: messages)?.id, bots[1].id)
  }
  func testRemovedOrMissingRespondersFallBackToLatestAvailableMember() throws {
    var (channel, bots) = try fixture()
    channel.members.removeLast()
    let messages = [reply("10", bots[0]), reply("20", bots[2])]
    XCTAssertEqual(ConversationComputer.target(channel: channel, bots: bots, messages: messages)?.id, bots[0].id)
    XCTAssertEqual(ConversationComputer.target(channel: channel, bots: Array(bots.dropFirst()), messages: messages)?.id, bots[1].id)
  }
  func testNoReplyFallsBackByMembershipOrderAndEmptyGroupHasNoComputer() throws {
    var (channel, bots) = try fixture()
    channel.members.reverse()
    XCTAssertEqual(ConversationComputer.target(channel: channel, bots: bots.reversed(), messages: [])?.id, bots[0].id)
    channel.members = []
    XCTAssertNil(ConversationComputer.target(channel: channel, bots: bots, messages: []))
  }
  func testDirectChatKeepsItsOwnComputerEvenIfAnotherBotReplied() throws {
    var (channel, bots) = try fixture()
    channel.kind = "bot_dm"
    channel.id = bots[0].dmChannelId
    var message = reply("10", bots[1]); message.channelId = channel.id
    XCTAssertEqual(ConversationComputer.target(channel: channel, bots: bots, messages: [message])?.id, bots[0].id)
  }
}
