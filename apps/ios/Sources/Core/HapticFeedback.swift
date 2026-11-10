import Foundation

public enum HapticEffect: String, Codable, Sendable {
  case selection, light, medium, rigid, soft, heavy, success, warning, error
}

/// React Native's haptics-core.ts gate. Recheck when an async result arrives.
public enum HapticPolicy {
  public static func allows(enabled: Bool, active: Bool) -> Bool { enabled && active }
}

/// The two inbox directions have independent commands, with the same travel.
/// Arming is reversible until release; velocity can reveal but never execute.
public struct InboxSwipeGesture {
  public enum Side: Equatable { case unread, pin }
  public enum Release: Equatable { case settle(Double), commit(Side) }
  public private(set) var origin: Double = 0
  public private(set) var distance: Double = 0
  public private(set) var armed: Side?
  private var width: Double = 320
  public let revealDistance: Double = 76
  public var activationDistance: Double { min(148, max(112, width * 0.44)) }
  public var resetDistance: Double { activationDistance - 18 }
  public var offset: Double {
    let travel = abs(distance)
    // Follow the finger one-to-one across the row; soften only beyond its edge.
    let displayed = travel <= width ? travel : width + (travel - width) * 0.22
    return distance < 0 ? -displayed : displayed
  }
  public init() {}
  public mutating func begin(at origin: Double, width: Double) {
    self.width = width.isFinite ? max(1, width) : 320
    self.origin = origin.isFinite ? origin : 0
    distance = self.origin
    armed = nil
  }
  /// True only when newly armed, including a deliberate retreat and recross.
  public mutating func move(to distance: Double) -> Bool {
    guard distance.isFinite else { return false }
    self.distance = distance
    if let armed {
      let sameSide = armed == .unread ? distance > 0 : distance < 0
      if sameSide && abs(distance) >= resetDistance { return false }
      self.armed = nil
    }
    guard abs(distance) >= activationDistance else { return false }
    armed = distance > 0 ? .unread : .pin
    return true
  }
  public func release(velocity: Double, cancelled: Bool) -> Release {
    if cancelled { return .settle(origin) }
    if let armed { return .commit(armed) }
    let speed = velocity.isFinite ? min(1500, max(-1500, velocity)) : 0
    let projected = distance + speed * 0.12
    // A fast retreat closes; it must not fling open the opposite command.
    guard abs(distance) >= 18, projected * distance > 0, abs(projected) >= 36 else {
      return .settle(0)
    }
    return .settle(distance > 0 ? revealDistance : -revealDistance)
  }
  public mutating func reset() { self = Self() }
}

/// Distance-driven resistance rises and falls as the finger moves. Quiet while
/// held, with hysteresis and a rate limit to prevent chatter around a detent.
public struct InboxSwipeTensionFeedback {
  private static let levels: [Double] = [0.16, 0.32, 0.48, 0.62, 0.74, 0.84, 0.92, 0.98]
  private static let strengths: [Double] = [0.12, 0.18, 0.26, 0.36, 0.48, 0.62, 0.78, 0.92]
  private var leadingTarget: Double = 0
  private var trailingTarget: Double = 0
  private var side = 0
  private var level = 0
  private var lastSignalTime: Double?

  public init() {}
  public mutating func begin(at distance: Double = 0, leadingTarget: Double, trailingTarget: Double) {
    reset()
    guard distance.isFinite, leadingTarget.isFinite, trailingTarget.isFinite,
      leadingTarget > 0, trailingTarget > 0 else { return }
    self.leadingTarget = leadingTarget
    self.trailingTarget = trailingTarget
    side = distance == 0 ? 0 : distance > 0 ? 1 : -1
    level = Self.levels.filter { abs(distance) / target(for: distance) >= $0 }.count
  }
  public mutating func reset() { self = Self() }
  public mutating func quiet(at time: Double) { lastSignalTime = time }
  public mutating func move(_ distance: Double, at time: Double) -> Double? {
    guard leadingTarget > 0, trailingTarget > 0, distance.isFinite, time.isFinite else { return nil }
    let direction = distance == 0 ? 0 : distance > 0 ? 1 : -1
    if direction != side { side = direction; level = 0 }
    let progress = abs(distance) / target(for: distance)
    var next = level
    while next < Self.levels.count && progress >= Self.levels[next] { next += 1 }
    while next > 0 && progress < Self.levels[next - 1] - 0.025 { next -= 1 }
    if next == 0 { level = 0; return nil }
    guard next != level, lastSignalTime.map({ time - $0 >= 0.045 }) ?? true else { return nil }
    level = next
    lastSignalTime = time
    return Self.strengths[next - 1]
  }
  private func target(for distance: Double) -> Double {
    distance >= 0 ? leadingTarget : trailingTarget
  }
}

/// Soft, increasingly weighty pulses as a cancellation swipe stretches farther.
/// Distance drives feedback; holding still or jittering around a detent adds no pulses.
public struct VoiceCancelResistanceFeedback {
  private var furthestStep = 0
  private var lastPulse = -Double.infinity
  public init() {}

  public mutating func move(_ progress: Double, time: TimeInterval) -> Double? {
    let tension = min(1, max(0, progress))
    guard tension > 0 else {
      furthestStep = 0
      return nil
    }
    let step = Int(ceil(tension * 8))
    guard step > furthestStep else { return nil }
    furthestStep = step
    // A quick flick must not bunch several impacts together.
    guard time - lastPulse >= 0.045 else { return nil }
    lastPulse = time
    return 0.12 + 0.4 * pow(tension, 1.5)
  }
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
