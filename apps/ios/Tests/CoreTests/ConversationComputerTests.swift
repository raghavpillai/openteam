import XCTest

@testable import OpenTeamCore

final class ConversationComputerTests: XCTestCase {
  private func fixture() throws -> (Channel, [Bot]) {
    let bootstrap = try Fixture.bootstrap()
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
}
