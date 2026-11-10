import Foundation

/// Resolve a saved Bot parameter from the same account cache used by app launch.
/// This only supplies display/navigation metadata. Sending, searching, and
/// exporting continue to validate against the server in their intent handlers.
@MainActor
enum SavedBotDirectory {
  private struct Cache: Decodable {
    let bootstrap: Directory?
  }
  private struct Directory: Decodable, Sendable {
    struct BotRow: Decodable, Sendable {
      let id: String
      let name: String
      let title: String
      let status: String
      let dmChannelId: String
    }
    struct ChannelRow: Decodable, Sendable {
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
    guard let directory = directory(scope: scope) else { return nil }
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

  /// Choosing a Bot uses the same local directory as resolving an existing parameter.
  /// A picker must not require unrelated server history/runtime fields to decode.
  static func entities(matching query: String) throws -> [TeamBotEntity]? {
    let session = try SystemIntentClient.savedSession()
    let scope = SystemEntityID.scope(server: session.server, userID: session.userID)
    guard let directory = directory(scope: scope) else { return nil }
    let result = entities(in: directory, scope: scope, matching: query)
    try SystemIntentClient.validateSession(session)
    return result
  }

  static func liveEntities(matching query: String) async throws -> [TeamBotEntity] {
    let session = try SystemIntentClient.savedSession()
    let api = try API(server: session.server, token: session.token, timeout: 15)
    let directory = try await SystemIntentClient.loadBootstrap(session: session, api: api, as: Directory.self)
    let scope = SystemEntityID.scope(server: session.server, userID: session.userID)
    return entities(in: directory, scope: scope, matching: query)
  }

  private static func entities(in directory: Directory, scope: String, matching query: String) -> [TeamBotEntity] {
    let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let result = directory.bots.compactMap { bot -> TeamBotEntity? in
      guard bot.status != "archived", query.isEmpty || bot.name.localizedStandardContains(query),
        directory.channels.contains(where: {
          $0.id == bot.dmChannelId && $0.kind != "group" && $0.members.contains { $0.botId == bot.id }
        }) else { return nil }
      let id = SystemEntityID(scope: scope, kind: .bot, channelID: bot.dmChannelId, localID: bot.id)
      return TeamBotEntity(id: id.value, name: bot.name, role: bot.title)
    }
    return result
  }

  private static func directory(scope: String) -> Directory? {
    let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("OpenTeam", isDirectory: true)
    guard let disk = try? DiskStore(directory: root, scope: scope),
      let data = try? Data(contentsOf: disk.url, options: .mappedIfSafe),
      let directory = try? JSONDecoder().decode(Cache.self, from: data).bootstrap else { return nil }
    return directory
  }
}
