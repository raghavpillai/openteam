import Foundation

/// What one element shows on a frame.
public struct RobotElementFrame: Sendable, Equatable {
  /// The element's transform. For the face plate it is the complete projected matrix;
  /// for every other element it applies about the element's own origin.
  public var transform = RobotAffine.identity
  public var opacity = 1.0
  public var visible = true
  /// How much of a dashed stroke is drawn, 0 to 1.
  public var strokeEnd = 1.0
  /// Whether the element has no transform at all, as opposed to one that happens to be the
  /// identity. The desktop compares computed styles as text, so the two differ there.
  var plain = true
}

/// Something a robot did that its neighbours may turn to look at.
public enum RobotCue: String, Sendable { case cheer, fail, poke }
public enum RobotExpression: String, Sendable, CaseIterable { case joy, squint, dizzy, blush }

/// A flattened view of one robot's elements, built once per shape.
final class RobotRig: Sendable {
  struct Element: Sendable {
    var id: String
    var node: RobotNode?
    var modes: [Int], reducedModes: [Int]
    var origin: (Double, Double)
    var bridged: Bool
    var parent: String?
    var bounds: (Double, Double, Double, Double)
    /// An ellipse inside the blush group follows the group's expression.
    var blush: Bool
    var dizzyPath: Bool
  }
  let design: RobotArtwork.Design
  let elements: [Element]
  let index: [String: Int]
  let children: [String: [String]]
  let looks: [String], faces: [String], antennas: [String], mouths: [String]
  static let shared: [RobotShape: RobotRig] = Dictionary(
    uniqueKeysWithValues: RobotShape.allCases.map { ($0, RobotRig(RobotArtwork.shared[$0])) })
  init(_ design: RobotArtwork.Design) {
    self.design = design
    var elements: [Element] = [
      .init(
        id: "rig", node: nil, modes: design.rig.modes, reducedModes: design.rig.reducedModes,
        origin: (design.rig.origin[0], design.rig.origin[1]), bridged: false, parent: nil,
        bounds: (-4, -4, 104, 104), blush: false, dizzyPath: false),
      .init(
        id: "body", node: nil, modes: design.body.modes, reducedModes: design.body.reducedModes,
        origin: (design.body.origin[0], design.body.origin[1]), bridged: true, parent: "rig",
        bounds: (-4, -4, 104, 104), blush: false, dizzyPath: false),
    ]
    var children: [String: [String]] = [:]
    func add(_ node: RobotNode, parent: String, inherited: String?) {
      let role = node.expression ?? inherited
      elements.append(
        .init(
          id: node.id, node: node, modes: node.modes, reducedModes: node.reducedModes,
          origin: (node.origin[0], node.origin[1]), bridged: node.bridged, parent: parent,
          bounds: RobotGeometry.bounds(node), blush: role == "blush",
          dizzyPath: inherited == "dizzy" && node.tag == "path"))
      children[parent, default: []].append(node.id)
      for child in node.children { add(child, parent: node.id, inherited: role) }
    }
    for node in design.nodes { add(node, parent: "body", inherited: nil) }
    for node in design.glyphs { add(node, parent: "glyph", inherited: nil) }
    self.elements = elements
    self.children = children
    index = Dictionary(uniqueKeysWithValues: elements.enumerated().map { ($1.id, $0) })
    let nodes = elements.compactMap(\.node)
    looks = nodes.filter { $0.roles["look"] != nil }.map(\.id)
    faces = nodes.filter(\.perspective).map(\.id)
    antennas = nodes.filter { ["antenna", "glow", "pin"].contains($0.part) }.map(\.id)
    mouths = nodes.filter { $0.part == "mouth" }.map(\.id)
  }
  subscript(_ id: String) -> Element { elements[index[id]!] }
}

public enum RobotGeometry {
  /// Absolute path commands as exported: M, L, Q, C and Z with their coordinates.
  public static func commands(_ path: String) -> [(Character, [Double])] {
    var out: [(Character, [Double])] = []
    for token in path.split(separator: " ") {
      if let number = Double(token) {
        out[out.count - 1].1.append(number)
      } else if let command = token.first {
        out.append((command, []))
      }
    }
    return out
  }
  static func bounds(_ node: RobotNode) -> (Double, Double, Double, Double) {
    switch node.tag {
    case "rect": return (node["x"], node["y"], node["x"] + node["width"], node["y"] + node["height"])
    case "circle":
      return (node["cx"] - node["r"], node["cy"] - node["r"], node["cx"] + node["r"], node["cy"] + node["r"])
    case "ellipse":
      return (node["cx"] - node["rx"], node["cy"] - node["ry"], node["cx"] + node["rx"], node["cy"] + node["ry"])
    case "line":
      return (
        min(node["x1"], node["x2"]), min(node["y1"], node["y2"]), max(node["x1"], node["x2"]),
        max(node["y1"], node["y2"])
      )
    case "polygon":
      let xs = stride(from: 0, to: node.points.count, by: 2).map { node.points[$0] }
      let ys = stride(from: 1, to: node.points.count, by: 2).map { node.points[$0] }
      return (xs.min() ?? 50, ys.min() ?? 50, xs.max() ?? 50, ys.max() ?? 50)
    case "path":
      var xs: [Double] = []
      var ys: [Double] = []
      var current = (0.0, 0.0)
      for (command, v) in commands(node.path) {
        var points: [(Double, Double)] = []
        switch command {
        case "M", "L": points = [(v[0], v[1])]
        case "Q": points = [(v[0], v[1]), (v[2], v[3])]
        case "C": points = [(v[0], v[1]), (v[2], v[3]), (v[4], v[5])]
        default: continue
        }
        if points.count == 1 {
          xs.append(points[0].0)
          ys.append(points[0].1)
        } else {
          for step in 1...16 {
            let t = Double(step) / 16
            var work = [current] + points
            while work.count > 1 {
              work = (1..<work.count).map {
                (work[$0 - 1].0 + (work[$0].0 - work[$0 - 1].0) * t, work[$0 - 1].1 + (work[$0].1 - work[$0 - 1].1) * t)
              }
            }
            xs.append(work[0].0)
            ys.append(work[0].1)
          }
        }
        current = points.last!
      }
      return (xs.min() ?? 50, ys.min() ?? 50, xs.max() ?? 50, ys.max() ?? 50)
    default: return (50, 50, 50, 50)
    }
  }
}

/// The Swift counterpart of createRobotAvatarMotion plus the stylesheet's loops. It holds one
/// robot's state and is stepped by `advance(by:)`: poses bridge between modes, loops pause
/// while their bridge lands, and one-shot reactions and expressions layer on top.
public struct RobotMotion: Sendable {
  private struct BridgeRun: Sendable {
    var from: RobotAffine, fromOpacity: Double, to: RobotAffine, toOpacity: Double
    var timing: RobotBridge
    var elapsed = 0.0
    var fresh = true
  }
  private struct TransitionRun<Value: Sendable>: Sendable {
    var from: Value, to: Value
    var timing: RobotBridge
    var elapsed = 0.0
    var fresh = true
  }
  // As in a browser, anything started between two frames shows its first moment on the next
  // frame and only then begins to run; `fresh` marks a run that has not been shown yet.
  private struct Track: Sendable {
    var loopTime = 0.0
    var loopFresh = false
    var loopName: String?
    var bridge: BridgeRun?
    var shownTransform: RobotAffine?, shownOpacity: Double?
    var transform: TransitionRun<RobotAffine>?, opacity: TransitionRun<Double>?
  }
  enum ReactionValue: Sendable {
    case pose(RobotReactionFrame.Pose), spin(RobotReactionFrame.Spin), affine(RobotAffine)
    /// A look direction, for the eye wrapper, the face plate or the rig.
    case look(Double, Double)
  }
  private struct ReactionRun: Sendable {
    var target: String
    var frames: [(offset: Double, value: ReactionValue?, easing: String?)]
    var duration: Double, delay: Double, easing: String
    var elapsed = 0.0
    var isLook = false
    var fresh = true
  }
  private struct ExpressionRun: Sendable { var name: RobotExpression, start: Double, end: Double }

  public static let transitionDuration = 0.32
  public private(set) var mode: RobotAvatarMode = .still
  public private(set) var shape: RobotShape
  public private(set) var reducedMotion = false
  /// The avatar's own offset into its loops, so a list of robots is never in lockstep.
  public var phase = 0.0
  /// Set when the robot does something neighbours may look at; the owner takes it.
  public var pendingCue: RobotCue?
  private var rig: RobotRig
  private var tracks: [String: Track] = [:]
  private var reactions: [ReactionRun] = []
  private var expressions: [ExpressionRun] = []
  private var clock = 0.0
  private var lastBlink = -Double.infinity
  private var artwork: RobotArtwork { .shared }

  public init(shape: RobotShape = .chip, mode: RobotAvatarMode = .still) {
    self.shape = shape
    rig = RobotRig.shared[shape]!
    setMode(mode, animate: false)
  }
  public var isAnimating: Bool {
    if reducedMotion { return false }
    return mode != .still || !reactions.isEmpty || !expressions.isEmpty
      || tracks.values.contains { $0.bridge != nil || $0.transform != nil || $0.opacity != nil }
  }
  public var elementIDs: [String] { rig.elements.map(\.id) }
  public mutating func setShape(_ shape: RobotShape) {
    guard self.shape != shape else { return }
    let (mode, reduced, phase) = (mode, reducedMotion, phase)
    self = .init(shape: shape)
    self.phase = phase
    reducedMotion = reduced
    setMode(mode, animate: false)
  }
  public mutating func setReducedMotion(_ reduced: Bool) {
    guard reduced != reducedMotion else { return }
    reducedMotion = reduced
    // The media query removes the loops; turning it back on starts them afresh.
    tracks = [:]
    reactions = []
    expressions = []
  }

  // MARK: Expressions
  private func shows(_ name: RobotExpression) -> Bool {
    expressions.contains { $0.name == name && $0.start <= clock && clock < $0.end }
  }
  private var faceExpression: RobotExpression? {
    shows(.dizzy) ? .dizzy : shows(.squint) ? .squint : shows(.joy) ? .joy : nil
  }
  /// Show a face (or blush) for a while; overlapping calls extend it.
  public mutating func express(_ name: RobotExpression, duration: Double, delay: Double = 0) {
    guard !reducedMotion else { return }
    expressions.append(.init(name: name, start: clock + delay, end: clock + delay + duration))
    if delay <= 0 { retarget(animated: true) }
  }

  // MARK: Resting state
  private func state(_ element: RobotRig.Element, mode: RobotAvatarMode) -> RobotState {
    artwork.states[(reducedMotion ? element.reducedModes : element.modes)[mode.index]]
  }
  /// The element's state with the expressions of the moment applied.
  private func target(_ element: RobotRig.Element) -> RobotState {
    var state = state(element, mode: mode)
    guard let node = element.node else { return state }
    let face = faceExpression
    if let layer = node.expression, let own = RobotExpression(rawValue: layer), own != .blush {
      if face == own {
        state.visible = true
        state.transform = []
      }
    } else if face != nil, ["eyes", "visor", "happy"].contains(node.part) {
      state.visible = false
    }
    if element.blush, shows(.blush) { state = self.state(element, mode: .done) }
    return state
  }
  private func loop(_ element: RobotRig.Element, _ state: RobotState) -> RobotLoop? {
    if reducedMotion { return nil }
    if element.dizzyPath, faceExpression == .dizzy {
      return .init(
        keyframes: "robot-spin", duration: 0.75, delay: 0, phased: false, easing: "linear",
        iterations: 0, fill: "none", alternate: false)
    }
    return state.loop
  }
  private static let spin = RobotKeyframeSet(
    transform: [
      .init(offset: 0, value: [.rotate(0)], easing: nil),
      .init(offset: 1, value: [.rotate(360)], easing: nil),
    ], opacity: [], dash: [])

  // MARK: Sampling
  private func segment<Value>(
    _ track: [RobotKeyframeTrack<Value>], _ progress: Double, _ fallback: String
  ) -> (Value?, Value?, Double)? {
    guard track.count > 1 else { return nil }
    var index = 1
    while index < track.count - 1, progress > track[index].offset { index += 1 }
    let a = track[index - 1]
    let b = track[index]
    let span = b.offset - a.offset
    let local = span > 0 ? min(1, max(0, (progress - a.offset) / span)) : 1
    return (a.value, b.value, RobotEasing.value(a.easing ?? fallback, local))
  }
  /// The element's own look: its resting state, moved by its loop.
  private func looped(_ element: RobotRig.Element, _ state: RobotState, time: Double)
    -> (RobotAffine, Double, Double, Bool)
  {
    var transform = RobotAffine(state.transform)
    var opacity = state.opacity
    var strokeEnd = 1.0
    var plain = state.transform.isEmpty
    guard let loop = loop(element, state), loop.duration > 0,
      let frames = loop.keyframes == "robot-spin" ? Self.spin : artwork.keyframes[loop.keyframes]
    else { return (transform, opacity, strokeEnd, plain) }
    var local = time - loop.delay + (loop.phased ? phase : 0)
    let total = loop.iterations == 0 ? Double.infinity : loop.duration * Double(loop.iterations)
    if local < 0 {
      guard ["both", "backwards"].contains(loop.fill) else { return (transform, opacity, strokeEnd, plain) }
      local = 0
    }
    var progress: Double
    if local >= total {
      guard ["both", "forwards"].contains(loop.fill) else { return (transform, opacity, strokeEnd, plain) }
      progress = 1
    } else {
      let iteration = (local / loop.duration).rounded(.down)
      progress = local / loop.duration - iteration
      if loop.alternate, Int(iteration) % 2 == 1 { progress = 1 - progress }
    }
    if let (a, b, t) = segment(frames.transform, progress, loop.easing) {
      transform = RobotTransformList.mixed(a ?? state.transform, b ?? state.transform, by: t)
      plain = false
    }
    if let (a, b, t) = segment(frames.opacity, progress, loop.easing) {
      opacity = (a ?? state.opacity) + ((b ?? state.opacity) - (a ?? state.opacity)) * t
    }
    if let (a, b, t) = segment(frames.dash, progress, loop.easing) {
      strokeEnd = 1 - ((a ?? 0) + ((b ?? 0) - (a ?? 0)) * t) / 100
    }
    return (transform, opacity, strokeEnd, plain)
  }
  private func lookRange(_ element: RobotRig.Element) -> Double {
    switch element.node?.limit {
    case 4: 3
    case 5: 3.5
    case 6, 6.5, 7: 4
    default: 3
    }
  }
  /// A reaction value as a transform about the element's origin.
  private func affine(_ value: ReactionValue, _ element: RobotRig.Element) -> RobotAffine {
    switch value {
    case .affine(let matrix): return matrix
    case .pose(let pose):
      return RobotAffine([
        .translate(pose.x, pose.y), .rotate(pose.rotation), .scale(pose.scaleX, pose.scaleY),
      ])
    case .spin(let spin):
      let matrix = RobotMatrix4.perspective(spin.depth).concatenating(.translation(0, spin.lift))
        .concatenating(.rotationY(spin.turn)).concatenating(.scale(spin.scaleX, spin.scaleY))
      return RobotAffine.translation(-element.origin.0, -element.origin.1).concatenating(
        matrix.flattened(about: element.origin)
      ).concatenating(.translation(element.origin.0, element.origin.1))
    case .look(let x, let y):
      if element.id == "rig" {
        return RobotAffine([.translate(x * 1.5, y), .rotate(x * 4), .scale(1, 1)])
      }
      let range = lookRange(element)
      return .translation(x * range, y * range * 0.75)
    }
  }
  private func mix(
    _ a: ReactionValue?, _ b: ReactionValue?, _ t: Double, _ element: RobotRig.Element,
    underlying: RobotAffine
  ) -> ReactionValue {
    func lerp(_ x: Double, _ y: Double) -> Double { x + (y - x) * t }
    let rests = underlying.approximatelyEquals(.identity)
    switch (a, b) {
    case (.look(let ax, let ay)?, .look(let bx, let by)?): return .look(lerp(ax, bx), lerp(ay, by))
    case (.pose(let p)?, .pose(let q)?):
      return .pose(
        .init(
          x: lerp(p.x, q.x), y: lerp(p.y, q.y), rotation: lerp(p.rotation, q.rotation),
          scaleX: lerp(p.scaleX, q.scaleX), scaleY: lerp(p.scaleY, q.scaleY)))
    case (.spin(let p)?, .spin(let q)?):
      return .spin(
        .init(
          depth: lerp(p.depth, q.depth), lift: lerp(p.lift, q.lift), turn: lerp(p.turn, q.turn),
          scaleX: lerp(p.scaleX, q.scaleX), scaleY: lerp(p.scaleY, q.scaleY)))
    // A missing keyframe is the element as it stands; at rest that is the identity of
    // whatever the other keyframe is, so the two interpolate function by function.
    case (nil, .pose(let q)?) where rests:
      return mix(.pose(.init(x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1)), .pose(q), t, element, underlying: underlying)
    case (.pose(let p)?, nil) where rests:
      return mix(.pose(p), .pose(.init(x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1)), t, element, underlying: underlying)
    case (nil, .spin(let q)?) where rests:
      return mix(.spin(.init(depth: q.depth, lift: 0, turn: 0, scaleX: 1, scaleY: 1)), .spin(q), t, element, underlying: underlying)
    case (.spin(let p)?, nil) where rests:
      // A spin ends having turned all the way round, which looks the same as at rest.
      return mix(.spin(p), .spin(.init(depth: p.depth, lift: 0, turn: p.turn, scaleX: 1, scaleY: 1)), t, element, underlying: underlying)
    default:
      let from = a.map { affine($0, element) } ?? underlying
      let to = b.map { affine($0, element) } ?? underlying
      return .affine(from.mixed(with: to, by: t))
    }
  }
  private func sample(_ run: ReactionRun, _ element: RobotRig.Element, underlying: RobotAffine)
    -> ReactionValue?
  {
    guard run.elapsed >= run.delay, run.duration > 0 else { return nil }
    let progress = RobotEasing.value(run.easing, min(1, (run.elapsed - run.delay) / run.duration))
    var frames = run.frames
    if frames.first.map({ $0.offset > 0 }) ?? true { frames.insert((0, nil, nil), at: 0) }
    if frames.last!.offset < 1 { frames.append((1, nil, nil)) }
    var index = 1
    while index < frames.count - 1, progress > frames[index].offset { index += 1 }
    let a = frames[index - 1]
    let b = frames[index]
    let span = b.offset - a.offset
    let local = span > 0 ? min(1, max(0, (progress - a.offset) / span)) : 1
    return mix(a.value, b.value, RobotEasing.value(a.easing ?? "linear", local), element, underlying: underlying)
  }

  /// Everything below reactions: resting state, transitions, loop and bridge.
  private func settled(_ element: RobotRig.Element) -> RobotElementFrame {
    let state = target(element)
    let track = tracks[element.id] ?? Track()
    var frame = RobotElementFrame()
    frame.visible = state.visible
    if let bridge = track.bridge {
      let t = RobotEasing.value(
        bridge.timing.easing,
        bridge.timing.duration > 0
          ? max(0, bridge.elapsed - bridge.timing.delay) / bridge.timing.duration : 1)
      frame.transform = bridge.from.mixed(with: bridge.to, by: t)
      frame.opacity = bridge.fromOpacity + (bridge.toOpacity - bridge.fromOpacity) * t
      frame.plain = false
      return frame
    }
    (frame.transform, frame.opacity, frame.strokeEnd, frame.plain) = looped(element, state, time: track.loopTime)
    // A CSS transition eases the resting value itself; loops on these elements leave it alone.
    if loop(element, state) == nil {
      if let run = track.transform {
        frame.transform = run.from.mixed(
          with: run.to, by: RobotEasing.value(run.timing.easing, run.elapsed / run.timing.duration))
      }
      if let run = track.opacity {
        let t = RobotEasing.value(run.timing.easing, run.elapsed / run.timing.duration)
        frame.opacity = run.from + (run.to - run.from) * t
      }
    }
    return frame
  }
  private func faceLook() -> (Double, Double) {
    var look = (0.0, 0.0)
    for run in reactions where run.isLook && run.target == "face" {
      if case .look(let x, let y)? = sample(run, rig["rig"], underlying: .identity) { look = (x, y) }
    }
    return look
  }
  /// The frame every element shows right now.
  public func frames() -> [String: RobotElementFrame] {
    var out: [String: RobotElementFrame] = [:]
    for element in rig.elements {
      var frame = settled(element)
      for run in reactions where run.target == element.id {
        if let value = sample(run, element, underlying: frame.transform) {
          frame.transform = affine(value, element)
          frame.plain = false
        }
      }
      // An overshooting bridge can carry opacity past its range; what is shown stays inside it.
      frame.opacity = min(1, max(0, frame.opacity))
      out[element.id] = frame
    }
    let look = faceLook()
    for id in rig.faces {
      let element = rig[id]
      let box = bounds(element, frames: out)
      let center = ((box.0 + box.2) / 2, (box.1 + box.3) / 2)
      // translate(look) perspective(300px) rotateY(14deg) translateX(2px) rotateY rotateX
      let matrix = RobotMatrix4.translation(look.0 * 2.4, look.1 * 1.8)
        .concatenating(.perspective(300)).concatenating(.rotationY(14))
        .concatenating(.translation(2, 0)).concatenating(.rotationY(look.0 * 17))
        .concatenating(.rotationX(-look.1 * 13))
      out[id]!.transform = matrix.flattened(about: center)
    }
    return out
  }
  public func frame(_ id: String) -> RobotElementFrame { frames()[id] ?? .init() }
  /// A group's fill box: its children's boxes under the transforms they show right now.
  private func bounds(_ element: RobotRig.Element, frames: [String: RobotElementFrame])
    -> (Double, Double, Double, Double)
  {
    guard let ids = rig.children[element.id], !ids.isEmpty else { return element.bounds }
    var box = (Double.infinity, Double.infinity, -Double.infinity, -Double.infinity)
    for id in ids {
      let child = rig[id]
      let inner = bounds(child, frames: frames)
      var matrix = frames[id]?.transform ?? .identity
      if child.node?.perspective != true { matrix = matrix.about(child.origin) }
      for (x, y) in [(inner.0, inner.1), (inner.2, inner.1), (inner.2, inner.3), (inner.0, inner.3)] {
        let px = matrix.a * x + matrix.c * y + matrix.tx
        let py = matrix.b * x + matrix.d * y + matrix.ty
        box = (min(box.0, px), min(box.1, py), max(box.2, px), max(box.3, py))
      }
    }
    return box
  }

  // MARK: Modes
  private func loopName(_ loop: RobotLoop?) -> String? {
    loop.map { String($0.keyframes.split(separator: "|").first ?? "") }
  }
  public mutating func setMode(_ next: RobotAvatarMode, animate: Bool = true) {
    guard mode != next || !animate else { return }
    let animated = animate && !reducedMotion
    let before = animated ? frames() : [:]
    let previous = mode
    mode = next
    for element in rig.elements {
      var track = tracks[element.id] ?? Track()
      let state = target(element)
      let name = loopName(loop(element, state))
      // A loop both modes share keeps running; any other starts from its beginning.
      if name != track.loopName {
        track.loopTime = 0
        track.loopFresh = name != nil
      }
      track.loopName = name
      track.bridge = nil
      if animated, element.bridged, let from = before[element.id] {
        let (to, toOpacity, _, plain) = looped(element, state, time: track.loopTime)
        if from.plain != plain || !from.transform.approximatelyEquals(to)
          || abs(from.opacity - toOpacity) > 1e-9
        {
          track.bridge = .init(
            from: from.transform, fromOpacity: from.opacity, to: to, toOpacity: toOpacity,
            timing: previous.isGlyph ? state.bridgeFromGlyph : state.bridge)
        }
      }
      tracks[element.id] = track
    }
    retarget(animated: animated)
    guard animated else { return }
    let awake = previous != .still
    if next == .done, awake, previous != .idle {
      play("celebrate")
      pendingCue = .cheer
    } else if next == .failed, awake {
      play("shake")
      pendingCue = .fail
    } else if next.isGlyph, !previous.isGlyph, awake {
      play("fold")
    } else if previous.isGlyph, !next.isGlyph, next != .still {
      play("land")
    }
  }
  /// Start CSS transitions for elements whose resting value just changed.
  private mutating func retarget(animated: Bool) {
    for element in rig.elements {
      guard let node = element.node, node.transition.transform != nil || node.transition.opacity != nil
      else { continue }
      var track = tracks[element.id] ?? Track()
      let state = target(element)
      let transform = RobotAffine(state.transform)
      if let timing = node.transition.transform, let shown = track.shownTransform,
        !shown.approximatelyEquals(transform)
      {
        var from = shown
        if let run = track.transform {
          from = run.from.mixed(
            with: run.to, by: RobotEasing.value(run.timing.easing, run.elapsed / run.timing.duration))
        }
        track.transform = animated ? .init(from: from, to: transform, timing: timing) : nil
      }
      if let timing = node.transition.opacity, let shown = track.shownOpacity,
        abs(shown - state.opacity) > 1e-9
      {
        var from = shown
        if let run = track.opacity {
          from = run.from + (run.to - run.from)
            * RobotEasing.value(run.timing.easing, run.elapsed / run.timing.duration)
        }
        track.opacity = animated ? .init(from: from, to: state.opacity, timing: timing) : nil
      }
      track.shownTransform = transform
      track.shownOpacity = state.opacity
      tracks[element.id] = track
    }
  }

  // MARK: Reactions
  private func frames(_ source: [RobotReactionFrame]) -> [(offset: Double, value: ReactionValue?, easing: String?)] {
    source.map { frame in
      (frame.offset, frame.spin.map { .spin($0) } ?? frame.pose.map { .pose($0) }, frame.easing)
    }
  }
  /// Play a one-shot reaction by its exported name, such as "poke0" or "fidget.hop".
  /// `interrupt` replaces whatever is playing, starting from the pose the robot is in.
  public mutating func play(_ name: String, interrupt: Bool = false) {
    guard !reducedMotion, let reaction = artwork.reactions[name] else { return }
    var rigFrames = frames(reaction.keyframes)
    if interrupt {
      let live = reactions.isEmpty ? RobotAffine.identity : frame("rig").transform
      reactions = []
      expressions = []
      if !live.approximatelyEquals(.identity) { rigFrames.insert((0, .affine(live), nil), at: 0) }
    }
    if !reaction.keyframes.isEmpty {
      reactions.append(
        .init(
          target: "rig", frames: rigFrames, duration: reaction.duration, delay: reaction.delay,
          easing: reaction.easing))
    }
    func add(_ part: RobotReaction.Part, to targets: [String]) {
      for target in targets {
        reactions.append(
          .init(
            target: target, frames: frames(part.keyframes), duration: part.duration,
            delay: reaction.delay + part.delay, easing: part.easing))
      }
    }
    if let antenna = reaction.antenna { add(antenna, to: rig.antennas) }
    for part in reaction.parts { add(part, to: part.target == "look" ? rig.looks : rig.mouths) }
    for expression in reaction.expressions {
      if let name = RobotExpression(rawValue: expression.name) {
        express(name, duration: expression.duration, delay: reaction.delay + expression.delay)
      }
    }
    retarget(animated: true)
  }
  /// The next click reaction in the cycle: a spin, a bounce and a nod.
  public mutating func poke(_ turn: Int) {
    play("poke\(turn % max(1, artwork.pokes))", interrupt: true)
    pendingCue = .poke
  }
  /// A quick blink; repeated calls within about a second are dropped.
  public mutating func blink() {
    guard !reducedMotion, clock - lastBlink >= 1.2 else { return }
    lastBlink = clock
    let shown = frames()
    for id in rig.looks {
      let closed = (shown[id]?.transform ?? .identity).concatenating(RobotAffine(.scale(1.06, 0.08)))
      reactions.append(
        .init(
          target: id, frames: [(0.45, .affine(closed), nil)], duration: 0.21, delay: 0,
          easing: "ease-in-out"))
    }
  }
  /// Look at a few spots in turn, holding each, then face front again: eyes snap, the face
  /// plate turns after them, and the body follows with a little overshoot.
  public mutating func lookAround(_ stops: [(x: Double, y: Double, hold: Double)], delay: Double = 0) {
    guard !reducedMotion, !stops.isEmpty else { return }
    let layers: [(targets: [String], move: Double, lag: Double, easing: String)] = [
      (rig.looks, 0.12, 0, "cubic-bezier(0.2, 0.9, 0.3, 1)"),
      (["face"], 0.28, 0.04, "cubic-bezier(0.3, 1.3, 0.6, 1)"),
      (["rig"], 0.42, 0.09, "cubic-bezier(0.3, 1.5, 0.55, 1)"),
    ]
    for layer in layers {
      let total = stops.reduce(0) { $0 + layer.move + $1.hold } + layer.move
      var frames: [(offset: Double, value: ReactionValue?, easing: String?)] = [
        (0, .look(0, 0), layer.easing)
      ]
      var at = 0.0
      for stop in stops {
        let x = max(-1.2, min(1.2, stop.x))
        let y = max(-1.2, min(1.2, stop.y))
        at += layer.move
        frames.append((at / total, .look(x, y), nil))
        at += stop.hold
        frames.append((at / total, .look(x, y), layer.easing))
      }
      frames.append((1, .look(0, 0), nil))
      for target in layer.targets {
        reactions.append(
          .init(
            target: target, frames: frames, duration: total, delay: delay + layer.lag,
            easing: "linear", isLook: true))
      }
    }
  }
  /// Whether nothing one-shot is playing, so an idle fidget may start.
  public var isSettled: Bool { reactions.isEmpty && expressions.isEmpty }
  public var hasAntenna: Bool { !rig.antennas.isEmpty }

  public mutating func advance(by delta: Double) {
    guard isAnimating, delta > 0, delta.isFinite else { return }
    clock += delta
    let faceBefore = faceExpression
    let blushBefore = shows(.blush)
    expressions.removeAll { $0.end <= clock }
    for index in reactions.indices {
      if reactions[index].fresh { reactions[index].fresh = false } else { reactions[index].elapsed += delta }
    }
    reactions.removeAll { $0.elapsed >= $0.delay + $0.duration }
    for element in rig.elements {
      guard var track = tracks[element.id] else { continue }
      if var bridge = track.bridge {
        if bridge.fresh { bridge.fresh = false } else { bridge.elapsed += delta }
        // The loop underneath stays paused through the frame its bridge lands on.
        track.bridge = bridge.elapsed >= bridge.timing.delay + bridge.timing.duration ? nil : bridge
      } else if track.loopFresh {
        track.loopFresh = false
      } else {
        track.loopTime += delta
      }
      if var run = track.transform {
        if run.fresh { run.fresh = false } else { run.elapsed += delta }
        track.transform = run.elapsed >= run.timing.duration ? nil : run
      }
      if var run = track.opacity {
        if run.fresh { run.fresh = false } else { run.elapsed += delta }
        track.opacity = run.elapsed >= run.timing.duration ? nil : run
      }
      tracks[element.id] = track
    }
    if faceBefore != faceExpression || blushBefore != shows(.blush) {
      // The spirals of a dizzy face start turning when the face appears.
      for element in rig.elements where element.dizzyPath {
        tracks[element.id]?.loopTime = 0
        tracks[element.id]?.loopFresh = true
      }
      retarget(animated: true)
    }
  }
}
