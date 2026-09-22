import SwiftUI
import UIKit

/// The only owner of app-generated feedback. UIKit handles unsupported hardware
/// and system restrictions. No haptic failure can block a user action.
@MainActor enum NativeHaptics {
  private static let selection = UISelectionFeedbackGenerator()
  private static let light = UIImpactFeedbackGenerator(style: .light)
  private static let medium = UIImpactFeedbackGenerator(style: .medium)
  private static let notification = UINotificationFeedbackGenerator()

  static func play(_ effect: HapticEffect, source: String) {
    let defaults = UserDefaults.standard
    let enabled = defaults.object(forKey: "haptics") == nil || defaults.bool(forKey: "haptics")
    let active = UIApplication.shared.applicationState == .active
    let emitted = HapticPolicy.allows(enabled: enabled, active: active)
    if emitted {
      switch effect {
      case .selection: selection.selectionChanged()
      case .light: light.impactOccurred()
      case .medium: medium.impactOccurred()
      case .success: notification.notificationOccurred(.success)
      case .error: notification.notificationOccurred(.error)
      }
    }
    #if DEBUG
      record(effect, source: source, enabled: enabled, active: active, emitted: emitted)
    #endif
  }

  static func failure(_ error: Error, source: String) {
    if !UserFacingError.isCancelled(error) { play(.error, source: source) }
  }

  #if DEBUG
    /// Opt-in telemetry to the same loopback-only UI-test fixture. Contains only
    /// effect identifiers and gate state, never messages, account data or secrets.
    private static func record(
      _ effect: HapticEffect, source: String, enabled: Bool, active: Bool, emitted: Bool
    ) {
      let args = ProcessInfo.processInfo.arguments
      guard args.contains("--haptic-audit"), args.contains("--ui-testing"),
        let index = args.firstIndex(of: "--server"), args.indices.contains(index + 1),
        let base = URL(string: args[index + 1]), base.host == "127.0.0.1",
        let url = URL(string: "/__qa/haptics", relativeTo: base)
      else { return }
      var request = URLRequest(url: url)
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try? JSONSerialization.data(withJSONObject: [
        "effect": effect.rawValue, "source": source, "enabled": enabled, "active": active,
        "emitted": emitted, "timestamp": Date().timeIntervalSince1970,
      ])
      URLSession.shared.dataTask(with: request).resume()
    }
  #endif
}

extension Binding where Value: Equatable {
  /// Feedback only from user edits, not initial data hydration or a no-op choice.
  func hapticSelection(_ source: String) -> Binding<Value> {
    Binding(
      get: { wrappedValue },
      set: { next in
        guard next != wrappedValue else { return }
        NativeHaptics.play(.selection, source: source)
        wrappedValue = next
      })
  }
}
