import SwiftUI
import UIKit

/// The only owner of app-generated feedback. UIKit handles unsupported hardware
/// and system restrictions. No haptic failure can block a user action.
@MainActor enum NativeHaptics {
  private static let selection = UISelectionFeedbackGenerator()
  private static let light = UIImpactFeedbackGenerator(style: .light)
  private static let medium = UIImpactFeedbackGenerator(style: .medium)
  private static let rigid = UIImpactFeedbackGenerator(style: .rigid)
  private static let soft = UIImpactFeedbackGenerator(style: .soft)
  private static let heavy = UIImpactFeedbackGenerator(style: .heavy)
  private static let notification = UINotificationFeedbackGenerator()

  /// `intensity` scales impact effects (0…1); other effects ignore it.
  static func play(_ effect: HapticEffect, intensity: Double = 1, source: String) {
    let intensity = intensity.isFinite ? min(1, max(0, intensity)) : 0
    let defaults = UserDefaults.standard
    let enabled = defaults.object(forKey: "haptics") == nil || defaults.bool(forKey: "haptics")
    let active = UIApplication.shared.applicationState == .active
    let emitted = HapticPolicy.allows(enabled: enabled, active: active)
    if emitted {
      switch effect {
      case .selection: selection.selectionChanged()
      case .light: light.impactOccurred()
      case .medium: medium.impactOccurred()
      case .rigid: rigid.impactOccurred(intensity: intensity)
      case .soft: soft.impactOccurred(intensity: intensity)
      case .heavy: heavy.impactOccurred(intensity: intensity)
      case .success: notification.notificationOccurred(.success)
      case .warning: notification.notificationOccurred(.warning)
      case .error: notification.notificationOccurred(.error)
      }
    }
    #if DEBUG
      record(effect, intensity: intensity, source: source, enabled: enabled, active: active, emitted: emitted)
    #endif
  }

  /// Prepare both swipe cues only while feedback can be emitted.
  static func prepareSwipe() {
    let defaults = UserDefaults.standard
    let enabled = defaults.object(forKey: "haptics") == nil || defaults.bool(forKey: "haptics")
    guard HapticPolicy.allows(enabled: enabled, active: UIApplication.shared.applicationState == .active)
    else { return }
    soft.prepare()
    rigid.prepare()
  }

  /// Sending has two light pulses, shared by hold release and the Send button.
  static func voiceSend(source: String) {
    play(.light, source: source)
    Task { @MainActor in
      do { try await Task.sleep(for: .milliseconds(90)) } catch { return }
      play(.light, source: source)
    }
  }

  /// A draft's send-off has at most three cues: a light tap on the press, a soft one as the blob
  /// is slung, and a rigid thump as it bursts on the badge. The press readies the later two.
  static func draftSendPress(source: String) {
    play(.light, source: source)
    rigid.prepare()
    soft.prepare()
  }

  static func draftSendSling(source: String) { play(.soft, intensity: 0.5, source: source) }

  static func draftSendHit(source: String) { play(.rigid, intensity: 0.9, source: source) }

  /// Keep the soft generator ready for the next distance-driven resistance pulse.
  static func prepareVoiceResistance() { soft.prepare() }

  static func voiceResistance(intensity: Double, source: String) {
    play(.soft, intensity: intensity, source: source)
    soft.prepare()
  }

  /// A crisp double click reserved for locking, distinct from cancellation’s soft resistance.
  static func voiceLock(source: String) {
    play(.rigid, intensity: 1, source: source)
    Task { @MainActor in
      do { try await Task.sleep(for: .milliseconds(90)) } catch { return }
      play(.rigid, intensity: 0.65, source: source)
    }
  }

  static func failure(_ error: Error, source: String) {
    if !UserFacingError.isCancelled(error) { play(.error, source: source) }
  }

  #if DEBUG
    /// Opt-in telemetry to the same loopback-only UI-test fixture. Contains only
    /// effect identifiers and gate state, never messages, account data or secrets.
    private static func record(
      _ effect: HapticEffect, intensity: Double, source: String, enabled: Bool, active: Bool, emitted: Bool
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
        "effect": effect.rawValue, "intensity": intensity, "source": source, "enabled": enabled, "active": active,
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
