import Foundation

/// A decomposed CSS 2D matrix. Translation is in matrix coordinates; this preserves the
/// rotate-then-translate order of robot-ponder, including the 320 ms matrix-to-matrix bridge.
public struct RobotPose: Sendable, Equatable, Codable {
  public var x = 0.0, y = 0.0, scaleX = 1.0, scaleY = 1.0, rotation = 0.0, opacity = 1.0
  public var matrix: [Double] {
    let angle = rotation * .pi / 180
    return [
      cos(angle) * scaleX, sin(angle) * scaleX, -sin(angle) * scaleY, cos(angle) * scaleY, x, y,
    ]
  }
  public func mixed(with other: Self, by t: Double) -> Self {
    func mix(_ a: Double, _ b: Double) -> Double { a + (b - a) * t }
    return .init(
      x: mix(x, other.x), y: mix(y, other.y), scaleX: mix(scaleX, other.scaleX),
      scaleY: mix(scaleY, other.scaleY), rotation: mix(rotation, other.rotation),
      opacity: mix(opacity, other.opacity))
  }
  func equals(_ other: Self) -> Bool {
    zip(matrix + [opacity], other.matrix + [other.opacity]).allSatisfy { abs($0 - $1) < 1e-10 }
  }
}

public enum RobotKeyframes {
  /// CSS cubic-bezier(0.42, 0, .58, 1), solved for x rather than assuming t == x.
  public static func ease(_ x: Double) -> Double {
    if x <= 0 { return 0 }
    if x >= 1 { return 1 }
    var low = 0.0
    var high = 1.0
    for _ in 0..<36 {
      let t = (low + high) / 2
      let v = 1 - t
      let position = 3 * v * v * t * 0.42 + 3 * v * t * t * 0.58 + t * t * t
      if position < x { low = t } else { high = t }
    }
    let t = (low + high) / 2
    return 3 * (1 - t) * t * t + t * t * t
  }
  static func value(_ time: Double, duration: Double, points: [(Double, Double)]) -> Double {
    let phase = max(time, 0).truncatingRemainder(dividingBy: duration) / duration
    for i in 1..<points.count where phase <= points[i].0 {
      let a = points[i - 1]
      let b = points[i]
      return a.1 + (b.1 - a.1) * ease((phase - a.0) / (b.0 - a.0))
    }
    return points.last!.1
  }
  public static func animation(_ part: RobotPart, mode: RobotAvatarMode) -> String? {
    if mode == .still || (mode == .thinking && part.hiddenWhenThinking) { return nil }
    if part.name == "cursor" { return "cursor" }
    if mode == .idle {
      if part.name == "body" { return "breathe" }
      if part.name == "eyes" || part.name == "visor" { return "idle-eyes" }
      return nil
    }
    return [
      "body": "ponder", "eyes": "thinking-eyes", "visor": "scan", "dot": "thought-dot",
      "antenna": "antenna", "head": "head", "pin": "pins", "glow": "glow", "neck": "neck",
    ][part.name]
  }
  public static func pose(_ part: RobotPart, mode: RobotAvatarMode, time: Double, tempo: Double)
    -> RobotPose
  {
    var pose = RobotPose(opacity: mode == .thinking && part.hiddenWhenThinking ? 0 : part.opacity)
    guard let animation = animation(part, mode: mode) else { return pose }
    let delay =
      part.name == "dot" && (1...2).contains(part.index)
      ? Double(part.index) * 0.16
      : part.name == "pin" && (1...3).contains(part.index) ? Double(part.index) * 0.21 : 0
    // CSS animation-fill-mode is none. Delayed dots retain their SVG opacity (zero) until starting.
    guard time >= delay else { return pose }
    let time = time - delay
    func value(_ duration: Double, _ points: [(Double, Double)]) -> Double {
      Self.value(time, duration: duration, points: points)
    }
    func pulse(_ duration: Double, _ a: Double, _ b: Double) -> Double {
      value(duration, [(0, a), (0.5, b), (1, a)])
    }
    switch animation {
    case "breathe":
      pose.scaleX = pulse(4.6, 1, 1.01)
      pose.scaleY = pose.scaleX
    case "idle-eyes":
      let fractions = [0.0, 0.27, 0.28, 0.30, 0.31, 0.33, 0.48, 0.52, 0.66, 0.73, 1]
      pose.scaleY = value(tempo, fractions.map { ($0, $0 == 0.28 || $0 == 0.31 ? 0.08 : 1) })
      pose.x = value(tempo, fractions.map { ($0, $0 == 0.52 || $0 == 0.66 ? 2 : 0) })
      pose.y = value(tempo, fractions.map { ($0, $0 == 0.52 || $0 == 0.66 ? -1 : 0) })
    case "ponder":
      pose.rotation = pulse(4.2, -1, 1.5)
      pose.x = sin(pose.rotation * .pi / 180)
      pose.y = -cos(pose.rotation * .pi / 180)
    case "thinking-eyes":
      let gx =
        part.limit == 4 ? 3.0 : part.limit == 5 ? 3.5 : [6, 6.5, 7].contains(part.limit) ? 4 : 5
      let gy =
        [4, 5].contains(part.limit)
        ? -2.0 : [6, 6.5].contains(part.limit) ? -3 : part.limit == 7 ? -4 : -5
      let fractions = [0.0, 0.08, 0.32, 0.42, 0.69, 0.76, 0.80, 0.94, 1]
      pose.x = value(
        tempo,
        fractions.map { ($0, $0 == 0.08 || $0 == 0.32 ? gx : $0 == 0.42 || $0 == 0.69 ? -gx : 0) })
      pose.y = value(tempo, fractions.map { ($0, $0 >= 0.08 && $0 <= 0.69 ? gy : 0) })
      pose.scaleY = value(tempo, fractions.map { ($0, $0 == 0.76 ? 0.08 : 1) })
    case "scan": pose.x = pulse(2.6, -17, 17)
    case "thought-dot": pose.opacity = value(1.2, [(0, 0.18), (0.3, 1), (0.7, 0.18), (1, 0.18)])
    case "antenna":
      pose.scaleX = pulse(1.4, 1, 1.5)
      pose.scaleY = pose.scaleX
      pose.opacity = pulse(1.4, part.opacity, 0.45)
    case "head": pose.rotation = pulse(4.8, -5, 5)
    case "pins": pose.opacity = pulse(1.4, part.opacity, 0.2)
    case "glow":
      pose.scaleX = pulse(1.7, 1, 1.07)
      pose.scaleY = pose.scaleX
      pose.opacity = pulse(1.7, part.opacity, 0.22)
    case "neck": pose.y = value(3.6, [(0, 0), (0.3, -8), (0.65, -8), (1, 0)])
    case "cursor": pose.opacity = time.truncatingRemainder(dividingBy: 1.1) < 0.55 ? 0.7 : 0
    default: break
    }
    return pose
  }
}

/// Equivalent to createRobotAvatarMotion: pause each destination loop while its bridge lands,
/// preserve shared loops, and capture the presented pose before interrupting an existing bridge.
public struct RobotMotion: Sendable {
  private struct Bridge: Sendable { var from: RobotPose, to: RobotPose, elapsed = 0.0 }
  private struct Track: Sendable {
    var elapsed = 0.0
    var bridge: Bridge?
  }
  public static let transitionDuration = 0.32
  public private(set) var mode: RobotAvatarMode = .still
  public private(set) var shape: RobotShape
  public private(set) var reducedMotion = false
  private var tracks: [String: Track] = [:]
  private var parts: [RobotPart] { RobotArtwork.shared[shape].parts }
  public init(shape: RobotShape = .chip, mode: RobotAvatarMode = .still) {
    self.shape = shape
    setMode(mode)
  }
  public var isAnimating: Bool {
    !reducedMotion && (mode != .still || tracks.values.contains { $0.bridge != nil })
  }
  public mutating func setShape(_ shape: RobotShape) {
    guard self.shape != shape else { return }
    let mode = mode
    let reduced = reducedMotion
    self = .init(shape: shape)
    reducedMotion = reduced
    setMode(mode, animate: !reduced)
  }
  public mutating func setReducedMotion(_ reduced: Bool) {
    guard reduced != reducedMotion else { return }
    reducedMotion = reduced
    // The media query removes the CSS animations. Re-enabling it starts fresh loops.
    tracks = [:]
  }
  public func pose(_ id: String) -> RobotPose {
    guard let part = parts.first(where: { $0.id == id }) else { return .init() }
    if reducedMotion {
      return RobotKeyframes.pose(
        part, mode: .still, time: 0, tempo: RobotArtwork.shared[shape].tempo)
    }
    let track = tracks[id] ?? Track()
    if let bridge = track.bridge {
      return bridge.from.mixed(
        with: bridge.to, by: RobotKeyframes.ease(bridge.elapsed / Self.transitionDuration))
    }
    return RobotKeyframes.pose(
      part, mode: mode, time: track.elapsed, tempo: RobotArtwork.shared[shape].tempo)
  }
  public mutating func setMode(_ next: RobotAvatarMode, animate: Bool = true) {
    guard mode != next || !animate else { return }
    let before = Dictionary(uniqueKeysWithValues: parts.map { ($0.id, pose($0.id)) })
    let previous = mode
    mode = next
    for part in parts {
      var track = tracks[part.id] ?? Track()
      let shared =
        RobotKeyframes.animation(part, mode: previous) == RobotKeyframes.animation(part, mode: next)
      if !shared { track.elapsed = 0 }
      track.bridge = nil
      if animate && !reducedMotion {
        let after = RobotKeyframes.pose(
          part, mode: next, time: track.elapsed, tempo: RobotArtwork.shared[shape].tempo)
        let from = before[part.id]!
        if !from.equals(after) { track.bridge = .init(from: from, to: after) }
      }
      tracks[part.id] = track
    }
  }
  public mutating func advance(by delta: Double) {
    guard isAnimating, delta > 0, delta.isFinite else { return }
    for part in parts {
      var track = tracks[part.id] ?? Track()
      var elapsed = delta
      if var bridge = track.bridge {
        let remaining = max(0, Self.transitionDuration - bridge.elapsed)
        if elapsed < remaining {
          bridge.elapsed += elapsed
          track.bridge = bridge
          elapsed = 0
        } else {
          elapsed -= remaining
          track.bridge = nil
        }
      }
      if track.bridge == nil { track.elapsed += elapsed }
      tracks[part.id] = track
    }
  }
}
