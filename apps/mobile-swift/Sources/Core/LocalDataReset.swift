import Foundation

/// Clears app-owned data, including caches belonging to previous accounts.
/// Keep the sandbox roots themselves: iOS can allow clearing their contents while
/// denying removal of the system-created directory.
enum LocalDataReset {
  static let pendingKey = "native-local-reset-pending"

  static func erase(directories: [URL]) throws {
    var failure: Error?
    for directory in directories {
      do {
        if FileManager.default.fileExists(atPath: directory.path) {
          let contents = try FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil)
          for item in contents {
            do { try FileManager.default.removeItem(at: item) }
            catch { if failure == nil { failure = error } }
          }
        }
      } catch { if failure == nil { failure = error } }
    }
    if let failure { throw failure }
  }
}
