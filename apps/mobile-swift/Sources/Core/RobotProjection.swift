import Foundation

/// SVG flattens a CSS 3D transform into its 2D current transformation matrix. Applying a
/// physical 3D CALayer instead produces a different face. Preserve the browser's flattened
/// matrix, including the perspective terms introduced by its fill-box transform origin.
public enum RobotProjection {
  private struct Bounds {
    var left: Double, top: Double, right: Double, bottom: Double
    var center: (Double, Double) { ((left + right) / 2, (top + bottom) / 2) }
    func transformed(_ m: [Double]) -> Self {
      let corners = [(left, top), (right, top), (right, bottom), (left, bottom)]
      let xs = corners.map { m[0] * $0.0 + m[2] * $0.1 + m[4] }
      let ys = corners.map { m[1] * $0.0 + m[3] * $0.1 + m[5] }
      return .init(left: xs.min()!, top: ys.min()!, right: xs.max()!, bottom: ys.max()!)
    }
  }
  public static func faceMatrix(_ node: RobotNode, poses: [String: RobotPose]) -> [Double] {
    let (x, y) = bounds(node, poses: poses).center
    let angle = 14 * Double.pi / 180
    let cosine = cos(angle)
    let perspective = sin(angle) / 300
    let a = cosine + x * perspective
    let b = y * perspective
    return [
      a, b, 0, 1, 2 * cosine + x * (1 + 2 * perspective) - a * x,
      y * 2 * perspective - b * x,
    ]
  }
  private static func bounds(_ node: RobotNode, poses: [String: RobotPose]) -> Bounds {
    switch node.tag {
    case "rect":
      return .init(
        left: node["x"], top: node["y"], right: node["x"] + node["width"],
        bottom: node["y"] + node["height"])
    case "circle":
      return .init(
        left: node["cx"] - node["r"], top: node["cy"] - node["r"], right: node["cx"] + node["r"],
        bottom: node["cy"] + node["r"])
    case "line":
      return .init(
        left: min(node["x1"], node["x2"]), top: min(node["y1"], node["y2"]),
        right: max(node["x1"], node["x2"]), bottom: max(node["y1"], node["y2"]))
    case "polygon":
      let xs = stride(from: 0, to: node.points.count, by: 2).map { node.points[$0] }
      let ys = stride(from: 1, to: node.points.count, by: 2).map { node.points[$0] }
      return .init(left: xs.min()!, top: ys.min()!, right: xs.max()!, bottom: ys.max()!)
    default:
      let children = node.children.map { child -> Bounds in
        let box = bounds(child, poses: poses)
        if child.perspective { return box.transformed(faceMatrix(child, poses: poses)) }
        if let pose = poses[child.id] {
          var matrix = pose.matrix
          let x = child.origin[0]
          let y = child.origin[1]
          matrix[4] += x - matrix[0] * x - matrix[2] * y
          matrix[5] += y - matrix[1] * x - matrix[3] * y
          return box.transformed(matrix)
        }
        return box
      }
      return .init(
        left: children.map(\.left).min() ?? 50, top: children.map(\.top).min() ?? 50,
        right: children.map(\.right).max() ?? 50, bottom: children.map(\.bottom).max() ?? 50)
    }
  }
}
