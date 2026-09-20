import Foundation

/// One serial writer per account. Critical sends wait for the atomic commit;
/// routine cache/draft saves run off the UI thread without reordering commits.
public final class StateWriter: @unchecked Sendable {
  private let queue = DispatchQueue(label: "dev.openteam.state-writer", qos: .utility)
  private let disk: DiskStore
  public init(disk: DiskStore) { self.disk = disk }
  public func saveNow(_ snapshot: SavedState) throws {
    try queue.sync { try disk.save(snapshot) }
  }
  public func save(_ snapshot: SavedState, completion: @escaping @Sendable (Result<Void, Error>) -> Void) {
    queue.async {
      completion(Result { try self.disk.save(snapshot) })
    }
  }
  /// Finish any submitted write before clearing an account's files.
  public func drain() { queue.sync {} }
}
