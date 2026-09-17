import Foundation

/// Deletes app-owned data roots, including caches belonging to previous accounts.
enum LocalDataReset {
  static let pendingKey = "native-local-reset-pending"

  static func erase(directories: [URL]) throws {
    var failure: Error?
    for directory in directories {
      do {
        if FileManager.default.fileExists(atPath: directory.path) {
          try FileManager.default.removeItem(at: directory)
        }
      } catch { if failure == nil { failure = error } }
    }
    if let failure { throw failure }
  }
}
