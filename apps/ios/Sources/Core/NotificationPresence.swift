import Foundation

/// A lifecycle lease with ordered updates; background releases can overtake in-flight heartbeats.
@MainActor public final class NotificationPresence {
  private let clientID = UUID().uuidString
  private var sequence = 0
  private var active = false
  private var heartbeat: Task<Void, Never>?
  private let interval: Duration
  private let send: @MainActor (JSON) async -> Void

  public init(interval: Duration = .seconds(30), send: @escaping @MainActor (JSON) async -> Void) {
    self.interval = interval
    self.send = send
  }

  public func setActive(_ value: Bool) {
    guard active != value else { return }
    active = value
    heartbeat?.cancel()
    heartbeat = nil
    report()
    if value {
      heartbeat = Task { [weak self, interval] in
        while !Task.isCancelled {
          do { try await Task.sleep(for: interval) } catch { return }
          guard let self, self.active, !Task.isCancelled else { return }
          self.report()
        }
      }
    }
  }

  private func report() {
    sequence += 1
    let payload: JSON = .object([
      "clientId": .string(clientID), "sequence": .number(Double(sequence)),
      "platform": .string("ios"), "active": .bool(active),
    ])
    let send = send
    Task { await send(payload) }
  }

  deinit { heartbeat?.cancel() }
}
