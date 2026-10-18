import Foundation

/// A conversation the share extension can send to: a Bot's direct chat or a group chat.
public struct ShareDestination: Identifiable, Sendable {
  public var id: String { channel.id }
  public var channel: Channel
  /// The Bot of a direct chat; nil for a group.
  public var bot: Bot?
  /// Group members in display order, or the Bot alone for a direct chat.
  public var members: [Bot]
  /// Hidden from the sidebar; listed only when searched for or already chosen.
  public var hidden: Bool
  public var lastActivity: Date?
  public var name: String { bot?.name ?? channel.name }
}

public enum ShareDirectory {
  /// Most recently active first: the later of the chat's update time and its latest message.
  public static func destinations(_ bootstrap: Bootstrap) -> [ShareDestination] {
    let byDM = Dictionary(bootstrap.bots.map { ($0.dmChannelId, $0) }) { first, _ in first }
    let byID = Dictionary(bootstrap.bots.map { ($0.id, $0) }) { first, _ in first }
    let parse = DateParser()
    var latest: [String: Date] = [:]
    for message in bootstrap.latestMessages {
      guard let date = parse(message.createdAt) else { continue }
      latest[message.channelId] = max(latest[message.channelId] ?? date, date)
    }
    let destinations = bootstrap.channels.compactMap { channel -> ShareDestination? in
      let activity = [parse(channel.updatedAt), latest[channel.id]].compactMap { $0 }.max()
      if let bot = byDM[channel.id] {
        return ShareDestination(
          channel: channel, bot: bot, members: [bot],
          hidden: bot.hiddenFromSidebar || channel.hiddenFromSidebar == true, lastActivity: activity)
      }
      guard channel.isGroup else { return nil }
      let members = channel.members.sorted { $0.ordinal < $1.ordinal }.compactMap { byID[$0.botId] }
      return ShareDestination(
        channel: channel, bot: nil, members: members,
        hidden: channel.hiddenFromSidebar == true, lastActivity: activity)
    }
    // Ties keep the server's order so equal timestamps never reshuffle between opens.
    return destinations.enumerated().sorted { a, b in
      let (left, right) = (a.element.lastActivity ?? .distantPast, b.element.lastActivity ?? .distantPast)
      return left != right ? left > right : a.offset < b.offset
    }.map(\.element)
  }

  /// Searching matches chat names and group members, and reveals hidden chats.
  public static func visible(
    _ destinations: [ShareDestination], query: String, selected: Set<String>
  ) -> [ShareDestination] {
    let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return destinations.filter { !$0.hidden || selected.contains($0.id) } }
    return destinations.filter { destination in
      destination.name.localizedStandardContains(query)
        || destination.members.contains { $0.name.localizedStandardContains(query) }
    }
  }

  private struct DateParser {
    let fractional = ISO8601DateFormatter.fractional
    let whole = ISO8601DateFormatter()
    func callAsFunction(_ value: String) -> Date? { fractional.date(from: value) ?? whole.date(from: value) }
  }
}
