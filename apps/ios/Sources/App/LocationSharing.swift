import CoreLocation
import Foundation
import Observation
import SwiftUI

/// Location sharing on this iPhone: off until turned on in Settings. While it is on, each message
/// carries the phone's latest fix, and the server keeps the newest one for the bot's GetUserLocation.
@MainActor @Observable
final class LocationSharing: NSObject, CLLocationManagerDelegate {
  static let shared = LocationSharing()
  static let enabledKey = "shareLocation"
  /// A fix this recent goes out as is; an older one is refreshed first.
  private static let freshFor: TimeInterval = 5 * 60
  /// How long a send waits for a fresh fix before it goes with what it has.
  private static let sendWait: Duration = .milliseconds(1_500)

  private(set) var enabled = UserDefaults.standard.bool(forKey: LocationSharing.enabledKey)
  private(set) var authorization: CLAuthorizationStatus
  private(set) var changing = false
  private let manager = CLLocationManager()
  private var latest: CLLocation?
  /// Counts finished location requests, fixes and failures alike.
  private var answers = 0
  private var authorizationWaiters: [CheckedContinuation<Void, Never>] = []

  override init() {
    authorization = manager.authorizationStatus
    super.init()
    manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
  }

  var allowed: Bool { [.authorizedWhenInUse, .authorizedAlways].contains(authorization) }
  var denied: Bool { [.denied, .restricted].contains(authorization) }

  /// Turning it on asks for permission the first time; it stays off when permission is refused.
  func setEnabled(_ value: Bool, clear: @escaping () async -> Void) async {
    changing = true
    defer { changing = false }
    if value {
      if authorization == .notDetermined {
        await withCheckedContinuation { continuation in
          authorizationWaiters.append(continuation)
          manager.requestWhenInUseAuthorization()
        }
      }
      guard allowed else { return store(false) }
      store(true)
      refresh()
    } else {
      store(false)
      latest = nil
      await clear()
    }
  }

  /// Called when the app comes to the front, so a send rarely has to wait.
  func refresh() {
    guard enabled, allowed else { return }
    manager.requestLocation()
  }

  /// The location a message carries: nil while sharing is off or permission is gone.
  func locationForSend() async -> DeviceLocation? {
    guard enabled, allowed else { return nil }
    if let latest, -latest.timestamp.timeIntervalSinceNow < Self.freshFor { return Self.fix(latest) }
    let asked = answers
    manager.requestLocation()
    let deadline = ContinuousClock.now + Self.sendWait
    while answers == asked, ContinuousClock.now < deadline, !Task.isCancelled {
      try? await Task.sleep(for: .milliseconds(50))
    }
    return latest.map(Self.fix)
  }

  private func store(_ value: Bool) {
    enabled = value
    UserDefaults.standard.set(value, forKey: Self.enabledKey)
  }

  private static func fix(_ location: CLLocation) -> DeviceLocation {
    DeviceLocation(
      latitude: location.coordinate.latitude, longitude: location.coordinate.longitude,
      accuracyMeters: location.horizontalAccuracy >= 0 ? location.horizontalAccuracy : nil,
      capturedAt: location.timestamp)
  }

  nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    MainActor.assumeIsolated {
      if let newest = locations.max(by: { $0.timestamp < $1.timestamp }) { latest = newest }
      answers += 1
    }
  }

  nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    MainActor.assumeIsolated { answers += 1 }
  }

  nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    MainActor.assumeIsolated {
      authorization = self.manager.authorizationStatus
      guard authorization != .notDetermined else { return }
      let waiters = authorizationWaiters
      authorizationWaiters = []
      waiters.forEach { $0.resume() }
    }
  }
}

struct LocationSharingSettings: View {
  @Environment(AppStore.self) private var store
  private var sharing: LocationSharing { .shared }
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Toggle(
        "Share location",
        isOn: Binding(
          get: { sharing.enabled && sharing.allowed },
          set: { value in
            Task { await sharing.setEnabled(value) { await store.clearUserLocation() } }
          })
      ).disabled(sharing.changing).tint(NativePalette.toggle)
        .accessibilityIdentifier("share-location-toggle")
      Text(
        "Messages you send from this iPhone include its location, so bots can answer questions like what’s near you. Turning it off forgets the shared location."
      ).font(.footnote).foregroundStyle(NativePalette.muted)
      if sharing.denied {
        Button("Allow location in iPhone Settings") {
          UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!)
        }.accessibilityIdentifier("share-location-settings")
      }
    }
  }
}
