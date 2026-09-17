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
public enum RobotAvatarMode: String, CaseIterable, Codable, Sendable { case still, idle, thinking }
public struct RobotNode: Codable, Sendable {
  public var id: String, tag: String, geometry: [String: Double], points: [Double]
  public var fill: String, stroke: String, strokeWidth: Double, strokeLinecap: String,
    strokeLinejoin: String
  public var opacity: Double, part: String, limit: Double, hiddenWhenThinking: Bool
  public var perspective: Bool, transform: String, origin: [Double], index: Int,
    children: [RobotNode]
  public subscript(_ key: String) -> Double { geometry[key] ?? 0 }
  public var motionPart: RobotPart {
    .init(
      id: id, name: part, limit: limit, index: index, opacity: opacity,
      hiddenWhenThinking: hiddenWhenThinking)
  }
}
public struct RobotPart: Sendable {
  public var id: String, name: String, limit: Double, index: Int, opacity: Double,
    hiddenWhenThinking: Bool
  static let body = Self(
    id: "body", name: "body", limit: 0, index: 0, opacity: 1, hiddenWhenThinking: false)
}
public struct RobotArtwork: Codable, Sendable {
  public struct Design: Codable, Sendable {
    public var label: String, tempo: Double, nodes: [RobotNode]
    public var parts: [RobotPart] {
      func walk(_ nodes: [RobotNode]) -> [RobotPart] {
        nodes.flatMap { ($0.part.isEmpty ? [] : [$0.motionPart]) + walk($0.children) }
      }
      return [.body] + walk(nodes)
    }
  }
  public var viewBox: String, colors: [String], sources: [String: String], shapes: [String: Design]
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
