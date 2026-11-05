import AppIntents
import Foundation
import UniformTypeIdentifiers

/// Intents can cold-launch without a SwiftUI scene. Read the Keychain directly,
/// resolve against the server, and recheck identity after every network boundary.
@MainActor
struct SystemIntentClient {
  let session: SessionRecord
  let api: API
  let bootstrap: Bootstrap
  var scope: String { SystemEntityID.scope(server: session.server, userID: session.userID) }

  static func savedSession() throws -> SessionRecord {
    guard !UserDefaults.standard.bool(forKey: LocalDataReset.pendingKey),
      let session = try SecureSession.read() else {
      throw APIError("Open OpenTeam and connect to your server first.")
    }
    return session
  }

  static func connect() async throws -> Self {
    let session = try savedSession()
    let api = try API(server: session.server, token: session.token, timeout: 15)
    let bootstrap: Bootstrap
    do { bootstrap = try await api.get("/api/v0/client-bootstrap", as: Bootstrap.self) }
    catch let failure as APIError where failure.unauthorized {
      // A revoked session may be discovered by a background intent before the
      // app resumes. Invalidate that session too, otherwise a later cached-state
      // donation could repopulate the index using the revoked credentials.
      // An account changed while the request was in flight must be preserved.
      if let current = try SecureSession.read(), current.server == session.server,
        current.userID == session.userID, current.token == session.token {
        SystemDiscovery.shared.clear(removeTransfers: true)
        try SecureSession.clear()
      }
      throw failure
    } catch let failure as APIError {
      throw failure
    } catch {
      // URLSession errors may contain Network.__NWPath in NSError.userInfo.
      // App Intents returns query failures over secure XPC, which cannot encode
      // that object and would terminate the app during parameter refresh.
      throw APIError(UserFacingError.message(error))
    }
    let client = Self(session: session, api: api, bootstrap: bootstrap)
    try client.validateSession()
    return client
  }

  static func validateSession(_ session: SessionRecord) throws {
    guard !UserDefaults.standard.bool(forKey: LocalDataReset.pendingKey),
      let current = try SecureSession.read(), current.server == session.server,
      current.userID == session.userID, current.token == session.token else {
      throw APIError("Your OpenTeam account changed. Choose the conversation again.")
    }
  }

  func validateSession() throws { try Self.validateSession(session) }

  func identifier(_ value: String, kind: SystemEntityID.Kind) throws -> SystemEntityID {
    try validateSession()
    guard let id = SystemEntityID(value), id.matches(scope: scope, kind: kind) else {
      throw APIError("This item belongs to a different OpenTeam account. Choose it again.")
    }
    return id
  }

  var destinations: [ShareDestination] {
    ShareDirectory.destinations(bootstrap).filter { $0.bot?.status != "archived" }
  }

  func destination(_ value: String, kind: SystemEntityID.Kind) throws -> ShareDestination {
    let id = try identifier(value, kind: kind)
    guard let target = destinations.first(where: { $0.id == id.channelID }),
      kind != .bot || target.bot?.id == id.localID else {
      throw APIError("This conversation is no longer available in OpenTeam.")
    }
    return target
  }

  func messages(for values: [String]) async throws -> [Message] {
    var messages: [Message] = []
    for value in values {
      let id = try identifier(value, kind: .message)
      guard bootstrap.channels.contains(where: { $0.id == id.channelID }) else { continue }
      do {
        let page = try await api.get(
          "/api/v0/channel-messages/\(API.segment(id.localID))/context", as: MessageContext.self)
        try validateSession()
        if page.channelId == id.channelID,
          let message = (page.messages + page.threadContext).first(where: { $0.id == id.localID }) {
          messages.append(message)
        }
      } catch let failure as APIError where failure.status == 404 { continue }
    }
    return messages
  }

  func searchMessages(_ query: String) async throws -> [Message] {
    let response = try await api.get("/api/v0/search", as: SearchResponse.self,
      query: ["q": String(query.prefix(200)), "category": "messages"])
    try validateSession()
    return try await messages(for: response.results.compactMap { result in
      guard let messageID = result.messageId, let channelID = result.channelId else { return nil }
      return SystemEntityID(scope: scope, kind: .message, channelID: channelID, localID: messageID).value
    })
  }

  func routines(matching query: String) async throws -> [TeamRoutineEntity] {
    // The server's bounded search directory avoids one request per Bot.
    let response = try await api.get("/api/v0/search", as: SearchResponse.self,
      query: ["q": String(query.prefix(200)), "category": "routines"])
    try validateSession()
    return response.results.compactMap { result in
      guard let channelID = result.channelId,
        let target = destinations.first(where: { $0.id == channelID }) else { return nil }
      // Search document IDs are prefixed with the result kind.
      let id = result.id.hasPrefix("routine:") ? String(result.id.dropFirst(8)) : result.id
      return TeamRoutineEntity(id: SystemEntityID(scope: scope, kind: .routine,
        channelID: channelID, localID: id).value, name: result.title, conversation: target.name)
    }
  }

  func routine(_ value: String) async throws -> Routine {
    let id = try identifier(value, kind: .routine)
    let target = try destination(value, kind: .routine)
    let owner = target.bot.map { "bots/\(API.segment($0.id))" }
      ?? "channels/\(API.segment(target.id))"
    let routines = try await api.get("/api/v0/\(owner)/routines", as: [Routine].self)
    try validateSession()
    guard let routine = routines.first(where: { $0.id == id.localID }) else {
      throw APIError("This routine is no longer available in OpenTeam.")
    }
    return routine
  }

  func upload(_ files: [IntentFile]) async throws -> [Asset] {
    guard files.count <= Draft.maxAttachments else { throw APIError("A message can contain up to \(Draft.maxAttachments) attachments.") }
    var assets: [Asset] = []
    for file in files {
      try validateSession()
      let mime = file.type?.preferredMIMEType ?? "application/octet-stream"
      let response: Asset
      if let url = file.fileURL {
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        try AttachmentLimits.validate(byteCount: size, mimeType: mime)
        response = try await api.requestAsset(file: url, fileName: file.filename, mimeType: mime)
      } else {
        let data = file.data
        try AttachmentLimits.validate(byteCount: data.count, mimeType: mime)
        response = try await api.requestAsset(data, fileName: file.filename, mimeType: mime)
      }
      try validateSession()
      assets.append(response)
    }
    return assets
  }

  func send(to target: ShareDestination, text: String, files: [IntentFile] = []) async throws -> Message {
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty else {
      throw APIError("Add instructions or an attachment to send to your Bot.")
    }
    let assets = try await upload(files)
    try validateSession()
    let message = try await api.send(channel: target.channel, bot: target.bot,
      input: SendInput(content: text, attachments: assets))
    try validateSession()
    return message
  }

  func attachment(_ value: String) async throws -> (Message, Asset) {
    let id = try identifier(value, kind: .attachment)
    // Content-addressed assets can have multiple filenames in one message.
    // Encode the parent message, asset, and filename; assets are never
    // exported just because a caller supplies a valid server asset identifier.
    guard let data = Data(base64Encoded: id.localID),
      let parts = try? JSONDecoder().decode([String].self, from: data), parts.count == 3 else {
      throw APIError("This attachment is no longer available.")
    }
    let messageID = SystemEntityID(scope: scope, kind: .message,
      channelID: id.channelID, localID: parts[0]).value
    guard let message = try await messages(for: [messageID]).first,
      let asset = message.attachments.first(where: { $0.assetId == parts[1] && $0.fileName == parts[2] }) else {
      throw APIError("This attachment is no longer available.")
    }
    return (message, asset)
  }

  func exportAttachment(_ value: String) async throws -> URL {
    let (_, asset) = try await attachment(value)
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("OpenTeamTransfers")
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.complete])
    // Strip path components from server-supplied names.
    let name = URL(fileURLWithPath: asset.fileName).lastPathComponent
    let url = directory.appendingPathComponent(name.isEmpty ? "Attachment" : name)
    do {
      try await api.downloadAsset(asset, to: url)
      try validateSession()
      return url
    } catch {
      try? FileManager.default.removeItem(at: directory)
      throw error
    }
  }
}
