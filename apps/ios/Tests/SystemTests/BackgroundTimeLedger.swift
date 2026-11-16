@testable import OpenTeamNative

/// Stands in for iOS background time and records which requests are still open.
@MainActor
final class BackgroundTimeLedger {
  private(set) var names: [String] = []
  private(set) var open: Set<Int> = []
  private let previous: @MainActor (String) -> @MainActor () -> Void

  init() {
    previous = BackgroundTime.begin
    BackgroundTime.begin = { [self] name in
      names.append(name)
      let id = names.count
      open.insert(id)
      return { [self] in open.remove(id) }
    }
  }

  func restore() { BackgroundTime.begin = previous }
}
