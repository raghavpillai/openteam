import Foundation

public enum HapticEffect: String, Codable, Sendable {
  case selection, light, medium, success, error
}

/// React Native's haptics-core.ts gate. Recheck when an async result arrives.
public enum HapticPolicy {
  public static func allows(enabled: Bool, active: Bool) -> Bool { enabled && active }
}

/// Matches reply-swipe.ts: 52-point arm, 40-point reset, one cue per gesture.
public struct ReplySwipeFeedback {
  private var armed = false
  private var signalled = false
  public init() {}
  public mutating func reset() {
    armed = false
    signalled = false
  }
  private mutating func update(_ distance: Double) {
    if distance >= 52 { armed = true } else if distance < 40 { armed = false }
  }
  public mutating func move(_ distance: Double) -> Bool {
    update(distance)
    guard armed, !signalled else { return false }
    signalled = true
    return true
  }
  public mutating func release(_ distance: Double, velocity: Double) -> (open: Bool, signal: Bool) {
    update(distance)
    let open = armed || (distance >= 24 && velocity >= 650)
    let signal = open && !signalled
    reset()
    return (open, signal)
  }
}

/// A deliberate user scroll back to the live edge, never layout or streaming.
public struct ScrollEdgeFeedback {
  /// SwiftUI reports a negative resting offset for the top safe-area inset.
  /// Normalize it to the same zero-at-top coordinate used by React Native.
  public static func remaining(content: Double, viewport: Double, offset: Double, topInset: Double)
    -> Double
  {
    content - max(0, offset + topInset) - viewport
  }
  private var active = false, armed = false, signalled = false
  public init() {}
  public mutating func begin() {
    active = true
    armed = false
    signalled = false
  }
  public mutating func end() { active = false }
  public mutating func observe(remaining: Double, scrollable: Bool) -> Bool {
    guard active, scrollable else { return false }
    if remaining >= 24 { armed = true }
    guard armed, !signalled, remaining <= 2 else { return false }
    signalled = true
    return true
  }
}
