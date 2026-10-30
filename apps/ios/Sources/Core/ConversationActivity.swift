import Foundation

public enum ConversationActivity: Equatable, Sendable {
  case foreground, background

  public static func resolve(
    channel: Channel, botId: String?, runs: [Run], subagents: [SubagentActivity]
  ) -> Self? {
    if runs.contains(where: { $0.channelId == channel.id && $0.isActive }) {
      return .foreground
    }
    guard channel.kind == "bot_dm", let botId else { return nil }
    return subagents.contains {
      $0.parentChannelId == channel.id && $0.parentBotId == botId
        && $0.runInBackground && $0.isActive
    } ? .background : nil
  }
}
