import Foundation

public struct Draft: Codable, Sendable, Equatable {
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
  public var stagedFiles: [StagedFile]?
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
  public var messages: [String: [Message]] = [:]
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
    guard !data.isEmpty, data.count <= 200 * 1024 * 1024 else {
      throw APIError("Choose a file between 1 byte and 200 MB.")
    }
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
