import Foundation

public enum RobotShape: String, Codable, CaseIterable, Sendable {
  case classic, goggles
  case tvHead = "tv-head"
  case terminal, pod
  case hexVisor = "hex-visor"
  case chip, helmet, bulb, owl, periscope
  case dualScreen = "dual-screen"
  public init(icon: String?) {
    self =
      Self(rawValue: (icon ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
      ?? .chip
  }
}

/// What an avatar shows; the same list, in the same order, as the desktop's BOT_AVATAR_MODES.
public enum RobotAvatarMode: String, CaseIterable, Codable, Sendable {
  case still, idle, working, typing, thinking, searching, generating, connecting, writing,
    sending, spawning, done, failed, waiting, drowsy, sleeping, waking
  /// Modes that fold the robot into a loading glyph.
  public var isGlyph: Bool {
    [.thinking, .searching, .generating, .connecting, .writing, .sending, .spawning].contains(self)
  }
  /// Busy modes flip often while a run moves between tools.
  public var isBusy: Bool { isGlyph || self == .working || self == .typing }
  var index: Int { Self.allCases.firstIndex(of: self)! }
}

/// One primitive of a CSS transform list.
public enum RobotOp: Codable, Sendable, Equatable {
  case translate(Double, Double), scale(Double, Double), rotate(Double)
  public init(from decoder: Decoder) throws {
    var container = try decoder.unkeyedContainer()
    let kind = try container.decode(String.self)
    let a = try container.decode(Double.self)
    switch kind {
    case "t": self = .translate(a, try container.decode(Double.self))
    case "s": self = .scale(a, try container.decode(Double.self))
    default: self = .rotate(a)
    }
  }
  public func encode(to encoder: Encoder) throws {
    var container = encoder.unkeyedContainer()
    switch self {
    case .translate(let x, let y): try container.encode("t"); try container.encode(x); try container.encode(y)
    case .scale(let x, let y): try container.encode("s"); try container.encode(x); try container.encode(y)
    case .rotate(let a): try container.encode("r"); try container.encode(a)
    }
  }
}
public struct RobotBridge: Codable, Sendable, Equatable {
  public var duration: Double, delay: Double, easing: String
}
public struct RobotLoop: Codable, Sendable, Equatable {
  public var keyframes: String, duration: Double, delay: Double, phased: Bool, easing: String
  public var iterations: Int, fill: String, alternate: Bool
}
/// An element's resting look in one mode, and how it gets there and moves there.
public struct RobotState: Codable, Sendable {
  public var transform: [RobotOp], opacity: Double, visible: Bool
  public var bridge: RobotBridge, bridgeFromGlyph: RobotBridge
  public var loop: RobotLoop?
}
public struct RobotKeyframeTrack<Value: Codable & Sendable>: Codable, Sendable {
  public var offset: Double
  /// Nil animates from or to the element's own resting value.
  public var value: Value?
  public var easing: String?
}
public struct RobotKeyframeSet: Codable, Sendable {
  public var transform: [RobotKeyframeTrack<[RobotOp]>]
  public var opacity: [RobotKeyframeTrack<Double>]
  public var dash: [RobotKeyframeTrack<Double>]
}
public struct RobotTransitions: Codable, Sendable {
  public var transform: RobotBridge?, opacity: RobotBridge?
}
public struct RobotNode: Codable, Sendable {
  public var id: String, tag: String, geometry: [String: Double], points: [Double], path: String
  public var fill: String, stroke: String, strokeWidth: Double, strokeLinecap: String,
    strokeLinejoin: String
  public var opacity: Double, part: String, roles: [String: String], limit: Double
  public var replacedBySmile: Bool, replacedByFrown: Bool, dashed: Bool
  public var perspective: Bool, transform: String, origin: [Double], index: Int
  public var bridged: Bool, transition: RobotTransitions
  public var modes: [Int], reducedModes: [Int]
  public var children: [RobotNode]
  public subscript(_ key: String) -> Double { geometry[key] ?? 0 }
  /// The expression layer this element is, such as "joy" or "blush".
  public var expression: String? { roles["x"] }
}
public struct RobotGroup: Codable, Sendable {
  public var modes: [Int], reducedModes: [Int], origin: [Double]
}

public struct RobotReactionFrame: Codable, Sendable {
  public struct Pose: Codable, Sendable { public var x, y, rotation, scaleX, scaleY: Double }
  public struct Spin: Codable, Sendable { public var depth, lift, turn, scaleX, scaleY: Double }
  public var offset: Double, easing: String?
  public var pose: Pose?, spin: Spin?
}
public struct RobotReaction: Codable, Sendable {
  public struct Part: Codable, Sendable {
    /// "look" (the eye wrapper), "mouth", or empty for the antenna, glow and pins.
    public var target: String?
    public var delay: Double, duration: Double, easing: String
    public var keyframes: [RobotReactionFrame]
  }
  public struct Expression: Codable, Sendable {
    public var name: String, delay: Double, duration: Double
  }
  public var duration: Double, delay: Double, easing: String
  public var keyframes: [RobotReactionFrame]
  public var antenna: Part?
  public var parts: [Part]
  public var expressions: [Expression]
}

public struct RobotArtwork: Codable, Sendable {
  public struct Design: Codable, Sendable {
    public var label: String, tempo: Double, rig: RobotGroup, body: RobotGroup
    public var nodes: [RobotNode], glyphs: [RobotNode]
    /// Every element of the robot and its glyphs, parents before children.
    public var elements: [RobotNode] {
      func walk(_ nodes: [RobotNode]) -> [RobotNode] { nodes.flatMap { [$0] + walk($0.children) } }
      return walk(nodes) + walk(glyphs)
    }
  }
  public var viewBox: String, colors: [String], modes: [String], sources: [String: String]
  public var keyframes: [String: RobotKeyframeSet], states: [RobotState]
  public var reactions: [String: RobotReaction], pokes: Int
  public var shapes: [String: Design]
  public subscript(_ shape: RobotShape) -> Design { shapes[shape.rawValue]! }
  public static let shared: Self = {
    #if SWIFT_PACKAGE
      let bundle = Bundle.module
    #else
      let bundle = Bundle.main
    #endif
    guard let url = bundle.url(forResource: "RobotArtwork", withExtension: "json"),
      let data = try? Data(contentsOf: url),
      let result = try? JSONDecoder().decode(Self.self, from: data)
    else { preconditionFailure("Missing bundled desktop robot artwork") }
    return result
  }()
  public static func faceColor(_ color: String) -> String {
    ["#242424", "#000000"].contains(color.lowercased()) ? "#f2f2f2" : "#1b1b1d"
  }
}
