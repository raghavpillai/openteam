import Foundation

/// Resolve a saved Bot parameter from the same account cache used by app launch.
/// This only supplies display/navigation metadata. Sending, searching, and
/// exporting continue to validate against the server in their intent handlers.
@MainActor
enum SavedBotDirectory {
  private struct Cache: Decodable {
    let bootstrap: Directory?
  }
  private struct Directory: Decodable {
    struct BotRow: Decodable {
      let id: String
      let name: String
      let title: String
      let status: String
      let dmChannelId: String
    }
    struct ChannelRow: Decodable {
      let id: String
      let kind: String
      let members: [Channel.Member]
    }
    let bots: [BotRow]
    let channels: [ChannelRow]
  }

  /// A missing or corrupt cache falls back to live resolution. Do not decode
  /// message history, drafts, Bot instructions, or attachments for a Bot picker.
  static func entities(for values: [String]) throws -> [TeamBotEntity]? {
    let session = try SystemIntentClient.savedSession()
    let scope = SystemEntityID.scope(server: session.server, userID: session.userID)
    let ids = try values.map { value in
      guard let id = SystemEntityID(value), id.matches(scope: scope, kind: .bot) else {
        throw APIError("This item belongs to a different OpenTeam account. Choose it again.")
      }
      return id
    }
    if ids.isEmpty { return [] }
    let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("OpenTeam", isDirectory: true)
    guard let disk = try? DiskStore(directory: root, scope: scope),
      let data = try? Data(contentsOf: disk.url, options: .mappedIfSafe),
      let directory = try? JSONDecoder().decode(Cache.self, from: data).bootstrap else { return nil }
    var result: [TeamBotEntity] = []
    for id in ids {
      guard let bot = directory.bots.first(where: {
        $0.id == id.localID && $0.dmChannelId == id.channelID && $0.status != "archived"
      }), directory.channels.contains(where: {
        $0.id == bot.dmChannelId && $0.kind != "group" && $0.members.contains { $0.botId == bot.id }
      }) else { return nil }
      result.append(TeamBotEntity(id: id.value, name: bot.name, role: bot.title))
    }
    try SystemIntentClient.validateSession(session)
    return result
  }
}
