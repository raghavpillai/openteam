import CoreLocation
import XCTest
@testable import OpenTeamNative

/// Real LocationSharing with held requests; no OS permission, GPS or network is used.
@MainActor private final class HeldLocationManager: CLLocationManager {
  var status: CLAuthorizationStatus = .authorizedWhenInUse
  private(set) var requests = 0
  override var authorizationStatus: CLAuthorizationStatus { status }
  override func requestLocation() { requests += 1 }
  override func requestWhenInUseAuthorization() {}

  func deliver(_ latitude: Double = 47.6097) {
    delegate?.locationManager?(self, didUpdateLocations: [CLLocation(
      coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: -122.3331),
      altitude: 0, horizontalAccuracy: 5, verticalAccuracy: 5,
      timestamp: Date())])
  }
  func authorize(_ value: CLAuthorizationStatus) {
    status = value
    delegate?.locationManagerDidChangeAuthorization?(self)
  }
}

@MainActor final class LocationSharingTests: XCTestCase {
  private var suite = ""
  private var defaults: UserDefaults!
  private var manager: HeldLocationManager!
  private var sharing: LocationSharing!

  override func setUp() async throws {
    suite = "native-location-boundary-" + UUID().uuidString
    defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defaults.removePersistentDomain(forName: suite)
    manager = HeldLocationManager()
    sharing = LocationSharing(manager: manager, defaults: defaults)
  }
  override func tearDown() async throws {
    defaults.removePersistentDomain(forName: suite)
    sharing = nil; manager = nil; defaults = nil
  }
  private func pending() async throws -> Task<DeviceLocation?, Never> {
    await sharing.setEnabled(true) {}
    let before = manager.requests
    let sharing = sharing!
    let task = Task { await sharing.locationForSend() }
    for _ in 0..<100 where manager.requests == before { await Task.yield() }
    XCTAssertEqual(manager.requests, before + 1, "The real send must enter a held location request")
    return task
  }
  func testEnabledPendingRequestReturnsFreshPhoneFix() async throws {
    let task = try await pending()
    manager.deliver()
    let returned = await task.value
    let value = try XCTUnwrap(returned)
    XCTAssertEqual(value.latitude, 47.6097)
    XCTAssertEqual(value.longitude, -122.3331)
    XCTAssertEqual(value.accuracyMeters, 5)
    XCTAssertEqual(value.device, "phone")
    XCTAssertFalse(value.capturedAt.isEmpty)
  }
  func testOptOutDuringPendingRequestRejectsLateCallback() async throws {
    let task = try await pending()
    var clears = 0
    await sharing.setEnabled(false) { clears += 1 }
    manager.deliver()
    let value = await task.value
    print("LOCATION_ACTUAL optout enabled=\(sharing.enabled) result=\(String(describing: value))")
    XCTAssertEqual(clears, 1)
    XCTAssertNil(value)
  }
  func testOptOutThenReenableDoesNotReviveOldSendPromise() async throws {
    let task = try await pending()
    await sharing.setEnabled(false) {}
    await sharing.setEnabled(true) {}
    manager.deliver()
    let value = await task.value
    print("LOCATION_ACTUAL reenabled=\(sharing.enabled) oldPromise=\(String(describing: value))")
    XCTAssertNil(value, "A later sharing session cannot authorize a send from before opt-out")
  }
  func testPermissionRevokedDuringPendingRequestReturnsNil() async throws {
    let task = try await pending()
    manager.authorize(.denied)
    manager.deliver()
    let value = await task.value
    XCTAssertFalse(sharing.allowed)
    XCTAssertNil(value)
  }
  func testCancelledPendingRequestReturnsNil() async throws {
    let task = try await pending()
    task.cancel()
    manager.deliver()
    let value = await task.value
    XCTAssertNil(value)
  }
  func testCallbackWhileOffCannotWarmNextSharingSessionsCache() async throws {
    await sharing.setEnabled(true) {}
    await sharing.setEnabled(false) {}
    manager.deliver(40)
    await sharing.setEnabled(true) {}
    let before = manager.requests
    let sharing = sharing!
    let task = Task { await sharing.locationForSend() }
    try await Task.sleep(for: .milliseconds(10))
    XCTAssertEqual(manager.requests, before + 1, "An off-state callback must not become a warm cache hit")
    manager.deliver(55)
    let value = await task.value
    XCTAssertEqual(value?.latitude, 55)
  }
}
