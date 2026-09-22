import Foundation

/// The group Computer action follows the latest visible bot reply, not an active
/// run or a later user message. Membership is resolved from the current channel.
public enum ConversationComputer {
  public static func target(channel: Channel, bots: [Bot], messages: [Message]) -> Bot? {
    guard channel.isGroup else { return bots.first { $0.dmChannelId == channel.id } }
    let members = channel.members.sorted { $0.ordinal < $1.ordinal }.compactMap { member in
      bots.first { $0.id == member.botId }
    }
    let memberIDs = Set(members.map(\.id))
    let latest = messages.filter {
      $0.channelId == channel.id && $0.sender == "agent"
        && memberIDs.contains($0.senderBotId ?? "")
        && !$0.metadata["branched"].bool
        && $0.metadata["event"]["type"].string.isEmpty
        && $0.metadata["toAgent"] == .null
    }.max { MessageMerge.less($0.sequence, $1.sequence) }
    if let id = latest?.senderBotId { return members.first { $0.id == id } }
    return members.first
  }
}
