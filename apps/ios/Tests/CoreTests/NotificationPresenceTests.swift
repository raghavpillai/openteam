import XCTest
@testable import OpenTeamCore

@MainActor final class NotificationPresenceTests: XCTestCase {
  func testBackgroundReleaseOvertakesInFlightForegroundWithoutChangingIdentity() async throws {
    var updates: [JSON] = []
    var held: CheckedContinuation<Void, Never>?
    let presence = NotificationPresence { value in
      updates.append(value)
      if value["active"].bool { await withCheckedContinuation { held = $0 } }
    }
    presence.setActive(true)
    for _ in 0..<20 where held == nil { await Task.yield() }
    XCTAssertNotNil(held)
    presence.setActive(false)
    for _ in 0..<20 where updates.count < 2 { await Task.yield() }
    XCTAssertEqual(updates.map { $0["sequence"].int }, [1, 2])
    XCTAssertEqual(updates.map { $0["active"].bool }, [true, false])
    XCTAssertEqual(updates.first?["clientId"], updates.last?["clientId"])
    held?.resume()
  }

  func testBackgroundStopsHeartbeatAndNewLifecycleHasNewIdentity() async throws {
    var updates: [JSON] = []
    let presence = NotificationPresence(interval: .milliseconds(5)) { updates.append($0) }
    presence.setActive(true)
    try await Task.sleep(for: .milliseconds(30))
    XCTAssertGreaterThanOrEqual(updates.count, 2)
    presence.setActive(false)
    try await Task.sleep(for: .milliseconds(10))
    let count = updates.count
    try await Task.sleep(for: .milliseconds(20))
    XCTAssertEqual(updates.count, count)
    XCTAssertEqual(updates.last?["active"], .bool(false))
    let next = NotificationPresence { updates.append($0) }
    next.setActive(true)
    await Task.yield()
    next.setActive(false)
    await Task.yield()
    XCTAssertNotEqual(updates.first?["clientId"], updates.last?["clientId"])
  }
}
