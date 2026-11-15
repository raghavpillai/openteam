import Foundation

public struct Draft: Codable, Sendable, Equatable {
  /// Matches the server's `maxAttachmentsPerMessage` (packages/contracts/src/capabilities.ts).
  public static let maxAttachments = 20
  public var widgetSelections: [String: [String]]?
  public var widgetCustomAnswers: [String: String]?
  public var text: String = ""
  public var attachments: [Asset] = []
  public var stagedFiles: [StagedFile]?
  public var replyTo: String?
  public var isFork: Bool = false
  public init() {}
}
public struct PendingSend: Codable, Identifiable, Sendable {
  public var id: String { input.clientId }
  public var channelId: String
  public var input: SendInput
  public var createdAt: Date
  public var failure: String?
  /// A request may have been accepted. Retrying must reconcile with the same client nonce.
  /// Optional to preserve caches written before delivery confirmation was tracked.
  public var deliveryUnconfirmed: Bool?
  public var stagedFiles: [StagedFile]?
  /// Uploaded `assetId:fileName` → staged file ID, committed with each upload.
  /// Absent in older caches; previews then fetch the authoritative asset.
  public var uploadedFileIDs: [String: String]?
  public var draftKey: String?
  public init(
    channelId: String, input: SendInput, stagedFiles: [StagedFile] = [], draftKey: String? = nil
  ) {
    self.channelId = channelId
    self.input = input
    self.createdAt = Date()
    self.stagedFiles = stagedFiles
    self.draftKey = draftKey
  }
}
public struct SavedState: Codable, Sendable {
  public var bootstrap: Bootstrap?
  public var sidebar: JSON?
  /// Minimal, account-scoped artwork metadata for the persistent inbox footer.
  /// Nil means never fetched; an empty array is a confirmed empty installation list.
  public var sidebarPlugins: [SidebarPlugin]?
  public var messages: [String: [Message]] = [:]
  /// A bootstrap preview alone is not a downloaded conversation page. Optional so
  /// a cache saved without this field still decodes; its chats then refetch history.
  public var loadedHistoryChannels: Set<String>? = []
  /// A confirmed local echo can be newer than cached history with unseen messages between.
  public var incompleteHistoryChannels: Set<String>? = []
  public var drafts: [String: Draft] = [:]
  public var outbox: [PendingSend] = []
  public init() {}
}

/// Each authenticated account gets its own cache. Writes are atomic before UI acknowledges a send.
public struct DiskStore: Sendable {
  public let url: URL
  public init(directory: URL, scope: String) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    // Base64url is reversible but this is an identity, never a credential.
    let name = Data(scope.utf8).base64EncodedString().replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "+", with: "-")
    url = directory.appendingPathComponent(String(name.prefix(180)) + ".json")
  }
  public func load() throws -> SavedState {
    guard FileManager.default.fileExists(atPath: url.path) else { return SavedState() }
    return try JSONDecoder().decode(SavedState.self, from: Data(contentsOf: url))
  }
  public func save(_ state: SavedState) throws {
    let data = try JSONEncoder().encode(state)
    #if os(iOS)
      try data.write(
        to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    #else
      try data.write(to: url, options: .atomic)
    #endif
    var u = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try u.setResourceValues(values)
  }
  public func clear() throws {
    if FileManager.default.fileExists(atPath: url.path) {
      try FileManager.default.removeItem(at: url)
    }
    if FileManager.default.fileExists(atPath: attachmentDirectory.path) {
      try FileManager.default.removeItem(at: attachmentDirectory)
    }
  }
  public var attachmentDirectory: URL {
    url.deletingPathExtension().appendingPathExtension("attachments")
  }
  public func stage(_ data: Data, fileName: String, mimeType: String) throws -> StagedFile {
    try AttachmentLimits.validate(byteCount: data.count, mimeType: mimeType)
    let file = StagedFile(
      id: UUID().uuidString, fileName: fileName, mimeType: mimeType, byteSize: data.count)
    try FileManager.default.createDirectory(
      at: attachmentDirectory, withIntermediateDirectories: true)
    #if os(iOS)
      try data.write(
        to: fileURL(file), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    #else
      try data.write(to: fileURL(file), options: .atomic)
    #endif
    var directory = attachmentDirectory
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try directory.setResourceValues(values)
    return file
  }
  /// Copies a file into the staging folder; videos are too large to hold in memory.
  public func stage(fileAt source: URL, fileName: String, mimeType: String) throws -> StagedFile {
    let size = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    try AttachmentLimits.validate(byteCount: size, mimeType: mimeType)
    let file = StagedFile(id: UUID().uuidString, fileName: fileName, mimeType: mimeType, byteSize: size)
    try FileManager.default.createDirectory(
      at: attachmentDirectory, withIntermediateDirectories: true)
    let target = try fileURL(file)
    try FileManager.default.copyItem(at: source, to: target)
    #if os(iOS)
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: target.path)
    #endif
    var directory = attachmentDirectory
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try directory.setResourceValues(values)
    return file
  }
  public func fileURL(_ file: StagedFile) throws -> URL {
    guard UUID(uuidString: file.id) != nil else {
      throw APIError("The saved attachment has an invalid identifier.")
    }
    return attachmentDirectory.appendingPathComponent(file.id)
  }
  public func removeFile(_ file: StagedFile) throws {
    let url = try fileURL(file)
    if FileManager.default.fileExists(atPath: url.path) {
      try FileManager.default.removeItem(at: url)
    }
  }
}

public struct StagedFile: Codable, Sendable, Equatable, Identifiable {
  public var id: String
  public var fileName: String
  public var mimeType: String
  public var byteSize: Int
}

/// Keep staging consistent with the production asset endpoint.
public enum AttachmentLimits {
  public static func maximumBytes(mimeType: String) -> Int {
    (mimeType.lowercased().hasPrefix("video/") ? 200 : 25) * 1024 * 1024
  }
  public static func validate(byteCount: Int, mimeType: String) throws {
    let limit = maximumBytes(mimeType: mimeType)
    guard byteCount > 0, byteCount <= limit else {
      throw APIError("Choose a file between 1 byte and \(limit / 1024 / 1024) MB.")
    }
  }
}
