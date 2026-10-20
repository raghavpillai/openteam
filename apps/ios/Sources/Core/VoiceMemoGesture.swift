import Foundation

/// Voice memo gesture tuning, shared with the desktop composer (Discord-style).
/// Tap the mic: hands-free (locked) recording. Press and hold: release sends; while holding,
/// slide left the full cancel distance and release to cancel, or slide up to lock.
public struct VoiceHoldThresholds: Equatable, Sendable {
  /// The hold UI ("Release to Send", the lock) appears after this; a shorter press is a tap.
  public var holdDelay: TimeInterval = 0.18
  /// Travel (pt) after which the dominant direction wins for the rest of the gesture.
  public var axisLock: Double = 10
  /// Cancelling takes a deliberate slide: `max(minimumCancel, cancelFraction × bar width)`,
  /// over a quarter of the bar on any phone.
  public var minimumCancel: Double = 80
  public var cancelFraction: Double = 0.28
  /// Share of the cancel distance at which releasing cancels ("Release to Cancel"). The red
  /// builds gradually over the whole slide up to it.
  public var cancelArm: Double = 1
  /// Upward travel that locks the recording.
  public var lock: Double = 70
  /// A hold released sooner than this (from the moment the hold UI appeared) is treated as a
  /// tap and locks instead of sending (`MIN_VOICE_NOTE_MS` in packages/contracts/src/transcription.ts).
  public var minimumDuration: TimeInterval = 0.5
  public init() {}

  public func cancelDistance(barWidth: Double) -> Double {
    max(minimumCancel, barWidth * cancelFraction)
  }
}

public enum VoiceHoldAxis: Equatable, Sendable { case undecided, horizontal, vertical }
public enum VoiceHoldEvent: Equatable, Sendable { case lock }

/// Follows one press on the mic. Only leftward and upward travel counts, so a finger that
/// drifts right or down never picks an axis and can still cancel or lock.
public struct VoiceHoldTracker: Equatable, Sendable {
  public let thresholds: VoiceHoldThresholds
  public let cancelDistance: Double
  public private(set) var axis: VoiceHoldAxis = .undecided
  /// Finger travel along the chosen axis, clamped to ≤ 0 (left / up).
  public private(set) var dx = 0.0
  public private(set) var dy = 0.0
  public private(set) var resolved: VoiceHoldEvent?

  public init(barWidth: Double, thresholds: VoiceHoldThresholds = .init()) {
    self.thresholds = thresholds
    cancelDistance = thresholds.cancelDistance(barWidth: barWidth)
  }

  /// Feeds the translation since touch-down (screen coordinates, y grows downward).
  /// Returns `.lock` the first time the lock threshold is crossed.
  @discardableResult
  public mutating func move(dx rawX: Double, dy rawY: Double) -> VoiceHoldEvent? {
    guard resolved == nil else { return nil }
    let left = max(0, -rawX), up = max(0, -rawY)
    if axis == .undecided, max(left, up) > thresholds.axisLock {
      axis = left >= up ? .horizontal : .vertical
    }
    switch axis {
    case .undecided:
      dx = -left
      dy = -up
    case .horizontal:
      dx = -left
      dy = 0
    case .vertical:
      dx = 0
      dy = -up
    }
    if axis == .vertical, up >= thresholds.lock { resolved = .lock }
    return resolved
  }

  /// 0 at rest … 1 at the full cancel distance.
  public var cancelProgress: Double { min(1, max(0, -dx / max(1, cancelDistance))) }
  /// Releasing now cancels.
  public var cancelArmed: Bool { cancelProgress >= thresholds.cancelArm }
  /// 0 at rest … 1 at the lock threshold.
  public var lockProgress: Double { min(1, max(0, -dy / max(1, thresholds.lock))) }
  /// True once the finger has clearly started to slide, which commits the hold early.
  public var isSliding: Bool { axis != .undecided }
}

public enum VoiceHoldRelease: Equatable, Sendable {
  /// A tap or a very short hold: keep recording hands-free.
  case lock
  /// Released past the cancel arm: discard.
  case cancel
  case send
}

extension VoiceHoldThresholds {
  /// `heldFor` is nil when the hold UI never appeared (a tap).
  public func release(heldFor: TimeInterval?, cancelArmed: Bool) -> VoiceHoldRelease {
    if cancelArmed { return .cancel }
    guard let heldFor, heldFor >= minimumDuration else { return .lock }
    return .send
  }
}

public enum VoiceMemoText {
  /// The message a voice memo sends: any typed draft, a space, then the transcript.
  public static func message(draft: String, transcript: String) -> String {
    let spoken = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    var typed = draft
    while typed.last?.isWhitespace == true { typed.removeLast() }
    if typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return spoken }
    if spoken.isEmpty { return typed }
    return typed + " " + spoken
  }

  /// `m:ss` with tabular digits in the UI.
  public static func duration(_ seconds: TimeInterval) -> String {
    let whole = max(0, Int(seconds.rounded(.down)))
    return String(format: "%d:%02d", whole / 60, whole % 60)
  }
}

public enum VoiceLevel {
  /// AVAudioRecorder average power (dBFS, −160…0) to a 0…1 level for meters and the glow.
  /// Room noise (≈ −50 dB) rests near zero; normal speech (−30…−15 dB) lands at 0.4…0.7.
  public static func normalized(decibels: Double) -> Double {
    guard decibels.isFinite else { return 0 }
    return min(1, max(0, (decibels + 50) / 50))
  }
}

/// The transcribing state of the voice glow: the lobes gather into one beam that sweeps side to side.
public enum VoiceProcessingSweep {
  public struct Frame: Equatable, Sendable {
    public var gather: Double
    public var offset: Double
    public var stretch: Double
    public var heldLevel: Double
  }

  /// `elapsed` is seconds since transcription began. The beam gathers over `gatherIn`
  /// seconds, then eases between the edges once per `period`.
  public static func frame(elapsed: TimeInterval, period: TimeInterval = 2.2, gatherIn: TimeInterval = 0.45,
    reach: Double = 0.85, reduceMotion: Bool = false) -> Frame
  {
    let t = max(0, elapsed)
    let g = min(1, t / max(0.01, gatherIn))
    let gather = g * g * (3 - 2 * g)
    guard !reduceMotion else { return Frame(gather: gather, offset: 0, stretch: 0, heldLevel: 0.5) }
    let phase = 2 * Double.pi * t / max(0.1, period)
    // sin keeps the beam centred at t = 0 so it starts where the voice glow was.
    return Frame(gather: gather, offset: reach * sin(phase) * gather,
      stretch: abs(cos(phase)) * gather, heldLevel: 0.5)
  }
}
