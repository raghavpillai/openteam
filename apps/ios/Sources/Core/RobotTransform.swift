import Foundation

/// A CSS 2D matrix(a, b, c, d, tx, ty): x' = a·x + c·y + tx, y' = b·x + d·y + ty.
public struct RobotAffine: Sendable, Equatable {
  public var a = 1.0, b = 0.0, c = 0.0, d = 1.0, tx = 0.0, ty = 0.0
  public static let identity = Self()
  public init(a: Double = 1, b: Double = 0, c: Double = 0, d: Double = 1, tx: Double = 0, ty: Double = 0) {
    (self.a, self.b, self.c, self.d, self.tx, self.ty) = (a, b, c, d, tx, ty)
  }
  public var values: [Double] { [a, b, c, d, tx, ty] }
  /// `self` applied after `inner`, as in a CSS transform list "self inner".
  public func concatenating(_ inner: Self) -> Self {
    .init(
      a: a * inner.a + c * inner.b, b: b * inner.a + d * inner.b,
      c: a * inner.c + c * inner.d, d: b * inner.c + d * inner.d,
      tx: a * inner.tx + c * inner.ty + tx, ty: b * inner.tx + d * inner.ty + ty)
  }
  public static func translation(_ x: Double, _ y: Double) -> Self { .init(tx: x, ty: y) }
  public init(_ op: RobotOp) {
    switch op {
    case .translate(let x, let y): self.init(tx: x, ty: y)
    case .scale(let x, let y): self.init(a: x, d: y)
    case .rotate(let degrees):
      let angle = degrees * .pi / 180
      self.init(a: cos(angle), b: sin(angle), c: -sin(angle), d: cos(angle))
    }
  }
  public init(_ ops: [RobotOp]) {
    self = ops.reduce(.identity) { $0.concatenating(Self($1)) }
  }
  /// The same transform expressed about `origin` instead of (0, 0).
  public func about(_ origin: (Double, Double)) -> Self {
    Self.translation(origin.0, origin.1).concatenating(self).concatenating(
      .translation(-origin.0, -origin.1))
  }
  public func approximatelyEquals(_ other: Self, tolerance: Double = 1e-9) -> Bool {
    zip(values, other.values).allSatisfy { abs($0 - $1) < tolerance }
  }

  // CSS Transforms: interpolation of 2D matrices, by decomposition.
  private struct Decomposed {
    var translate = (0.0, 0.0), scale = (1.0, 1.0), angle = 0.0
    var m11 = 1.0, m12 = 0.0, m21 = 0.0, m22 = 1.0
  }
  private var decomposed: Decomposed {
    var row0 = (a, b)
    var row1 = (c, d)
    var out = Decomposed()
    out.translate = (tx, ty)
    out.scale = (hypot(row0.0, row0.1), hypot(row1.0, row1.1))
    if row0.0 * row1.1 - row0.1 * row1.0 < 0 {
      if row0.0 < row1.1 { out.scale.0 = -out.scale.0 } else { out.scale.1 = -out.scale.1 }
    }
    if out.scale.0 != 0 { row0 = (row0.0 / out.scale.0, row0.1 / out.scale.0) }
    if out.scale.1 != 0 { row1 = (row1.0 / out.scale.1, row1.1 / out.scale.1) }
    out.angle = atan2(row0.1, row0.0)
    if out.angle != 0 {
      let sn = -row0.1
      let cs = row0.0
      let m = (row0.0, row0.1, row1.0, row1.1)
      row0 = (cs * m.0 + sn * m.2, cs * m.1 + sn * m.3)
      row1 = (-sn * m.0 + cs * m.2, -sn * m.1 + cs * m.3)
    }
    (out.m11, out.m12, out.m21, out.m22) = (row0.0, row0.1, row1.0, row1.1)
    out.angle = out.angle * 180 / .pi
    return out
  }
  public func mixed(with other: Self, by t: Double) -> Self {
    // No clamping: an easing that overshoots carries the interpolation past its ends.
    if t == 0 { return self }
    if t == 1 { return other }
    var from = decomposed
    var to = other.decomposed
    if (from.scale.0 < 0 && to.scale.1 < 0) || (from.scale.1 < 0 && to.scale.0 < 0) {
      from.scale = (-from.scale.0, -from.scale.1)
      from.angle += from.angle < 0 ? 180 : -180
    }
    if from.angle == 0 { from.angle = 360 }
    if to.angle == 0 { to.angle = 360 }
    if abs(from.angle - to.angle) > 180 {
      if from.angle > to.angle { from.angle -= 360 } else { to.angle -= 360 }
    }
    func mix(_ x: Double, _ y: Double) -> Double { x + (y - x) * t }
    let m11 = mix(from.m11, to.m11), m12 = mix(from.m12, to.m12)
    let m21 = mix(from.m21, to.m21), m22 = mix(from.m22, to.m22)
    let translate = (mix(from.translate.0, to.translate.0), mix(from.translate.1, to.translate.1))
    let scale = (mix(from.scale.0, to.scale.0), mix(from.scale.1, to.scale.1))
    let angle = mix(from.angle, to.angle) * .pi / 180
    var out = Self(a: m11, b: m12, c: m21, d: m22)
    out.tx = translate.0 * m11 + translate.1 * m21
    out.ty = translate.0 * m12 + translate.1 * m22
    out = out.concatenating(.init(a: cos(angle), b: sin(angle), c: -sin(angle), d: cos(angle)))
    out.a *= scale.0
    out.b *= scale.0
    out.c *= scale.1
    out.d *= scale.1
    return out
  }
}

public enum RobotTransformList {
  private static func kind(_ op: RobotOp) -> Int {
    switch op {
    case .translate: 0
    case .scale: 1
    case .rotate: 2
    }
  }
  private static func identity(like op: RobotOp) -> RobotOp {
    switch op {
    case .translate: .translate(0, 0)
    case .scale: .scale(1, 1)
    case .rotate: .rotate(0)
    }
  }
  private static func mix(_ a: RobotOp, _ b: RobotOp, _ t: Double) -> RobotOp {
    func mix(_ x: Double, _ y: Double) -> Double { x + (y - x) * t }
    switch (a, b) {
    case (.translate(let ax, let ay), .translate(let bx, let by)): return .translate(mix(ax, bx), mix(ay, by))
    case (.scale(let ax, let ay), .scale(let bx, let by)): return .scale(mix(ax, bx), mix(ay, by))
    case (.rotate(let x), .rotate(let y)): return .rotate(mix(x, y))
    default: return a
    }
  }
  /// CSS interpolation of two transform lists: matching functions interpolate one by one, a
  /// shorter list is padded with identities, and a mismatched remainder interpolates as matrices.
  public static func mixed(_ from: [RobotOp], _ to: [RobotOp], by t: Double) -> RobotAffine {
    var out = RobotAffine.identity
    var index = 0
    while index < max(from.count, to.count) {
      let a = index < from.count ? from[index] : nil
      let b = index < to.count ? to[index] : nil
      if let a, let b, kind(a) != kind(b) { break }
      let left = a ?? identity(like: b!)
      let right = b ?? identity(like: a!)
      out = out.concatenating(RobotAffine(mix(left, right, t)))
      index += 1
    }
    guard index < max(from.count, to.count) else { return out }
    let rest = RobotAffine(Array(from.dropFirst(index))).mixed(
      with: RobotAffine(Array(to.dropFirst(index))), by: t)
    return out.concatenating(rest)
  }
}

/// Just enough of a 4×4 matrix to reproduce how the browser flattens a CSS 3D transform on an
/// SVG element: it keeps the affine terms of the full matrix and drops depth and the divide.
struct RobotMatrix4 {
  /// Column-major, as CSS matrix3d(): m[column][row].
  var m: [[Double]] = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
  static let identity = Self()
  func concatenating(_ inner: Self) -> Self {
    var out = Self()
    for column in 0..<4 {
      for row in 0..<4 {
        out.m[column][row] = (0..<4).reduce(0) { $0 + m[$1][row] * inner.m[column][$1] }
      }
    }
    return out
  }
  static func translation(_ x: Double, _ y: Double) -> Self {
    var out = Self()
    out.m[3][0] = x
    out.m[3][1] = y
    return out
  }
  static func scale(_ x: Double, _ y: Double) -> Self {
    var out = Self()
    out.m[0][0] = x
    out.m[1][1] = y
    return out
  }
  static func perspective(_ depth: Double) -> Self {
    var out = Self()
    out.m[2][3] = -1 / depth
    return out
  }
  static func rotationY(_ degrees: Double) -> Self {
    let angle = degrees * .pi / 180
    var out = Self()
    out.m[0][0] = cos(angle)
    out.m[0][2] = -sin(angle)
    out.m[2][0] = sin(angle)
    out.m[2][2] = cos(angle)
    return out
  }
  static func rotationX(_ degrees: Double) -> Self {
    let angle = degrees * .pi / 180
    var out = Self()
    out.m[1][1] = cos(angle)
    out.m[1][2] = sin(angle)
    out.m[2][1] = -sin(angle)
    out.m[2][2] = cos(angle)
    return out
  }
  /// The 2D matrix the browser paints for this transform about `origin`, in the element's own
  /// coordinates (so it already includes the origin).
  func flattened(about origin: (Double, Double)) -> RobotAffine {
    let full = Self.translation(origin.0, origin.1).concatenating(self).concatenating(
      .translation(-origin.0, -origin.1))
    return .init(
      a: full.m[0][0], b: full.m[0][1], c: full.m[1][0], d: full.m[1][1], tx: full.m[3][0],
      ty: full.m[3][1])
  }
}

public enum RobotEasing {
  /// A CSS timing function by name or as "cubic-bezier(x1, y1, x2, y2)"; "steps(1)" holds.
  public static func value(_ name: String?, _ x: Double) -> Double {
    if x <= 0 { return 0 }
    if x >= 1 { return 1 }
    let name = name ?? "linear"
    switch name {
    case "linear": return x
    case "ease": return bezier(0.25, 0.1, 0.25, 1, x)
    case "ease-in": return bezier(0.42, 0, 1, 1, x)
    case "ease-out": return bezier(0, 0, 0.58, 1, x)
    case "ease-in-out": return bezier(0.42, 0, 0.58, 1, x)
    default:
      if name.hasPrefix("steps") { return 0 }
      let numbers = name.split(whereSeparator: { !"-.0123456789".contains($0) }).compactMap {
        Double($0)
      }
      return numbers.count == 4 ? bezier(numbers[0], numbers[1], numbers[2], numbers[3], x) : x
    }
  }
  static func bezier(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ x: Double) -> Double {
    var low = 0.0
    var high = 1.0
    for _ in 0..<40 {
      let t = (low + high) / 2
      let v = 1 - t
      if 3 * v * v * t * x1 + 3 * v * t * t * x2 + t * t * t < x { low = t } else { high = t }
    }
    let t = (low + high) / 2
    let v = 1 - t
    return 3 * v * v * t * y1 + 3 * v * t * t * y2 + t * t * t
  }
}
