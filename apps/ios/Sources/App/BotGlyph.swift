import SwiftUI
import UIKit

struct BotGlyph: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.scenePhase) private var scenePhase
  @State private var inViewport = true
  var color: Color
  var kind = "chip"
  var size: CGFloat = 48
  var mode: RobotAvatarMode = .still
  var forceReducedMotion = false
  var sampleTime: Double? = nil
  /// A solid, expanded silhouette for transparent group-avatar knockout masks.
  var cutout: CGFloat? = nil
  /// Tapping the robot plays a small reaction. Leave off inside buttons and rows.
  var pokeable = false
  /// Offsets the loops per Bot, so a list of avatars never moves in lockstep.
  var seed: String? = nil
  var body: some View {
    RobotSurface(
      color: UIColor(color), shape: RobotShape(icon: kind), mode: mode,
      reduced: reduceMotion || forceReducedMotion, active: scenePhase == .active && inViewport,
      sampleTime: sampleTime, outline: cutout.map { $0 * 108 / size }, pokeable: pokeable,
      seed: seed
    )
    .frame(width: size, height: size).accessibilityHidden(true)
    .onScrollVisibilityChange(threshold: 0.01) { inViewport = $0 }
  }
}
private struct RobotSurface: UIViewRepresentable {
  var color: UIColor, shape: RobotShape, mode: RobotAvatarMode, reduced: Bool, active: Bool
  var sampleTime: Double?
  var outline: CGFloat?
  var pokeable: Bool
  var seed: String?
  func makeUIView(context: Context) -> NativeRobotView { NativeRobotView(shape: shape) }
  func updateUIView(_ view: NativeRobotView, context: Context) {
    view.configure(
      color: color, shape: shape, mode: mode, reduced: reduced, active: active,
      sampleTime: sampleTime, outline: outline, pokeable: pokeable, seed: seed)
  }
  static func dismantleUIView(_ view: NativeRobotView, coordinator: ()) { view.stop() }
}

/// Core Animation vector layers mirror the desktop SVG element for element. CADisplayLink
/// steps the shared motion engine, which plays the desktop's own poses, loops and reactions;
/// no browser or video is embedded.
@MainActor final class NativeRobotView: UIView {
  private(set) var motion: RobotMotion
  private var pacer = RobotModePacer()
  private let root = CALayer()
  private var layers: [String: CALayer] = [:]
  private var dashed: [String: CAShapeLayer] = [:]
  private var inkLayers: [(CAShapeLayer, String, String, CGFloat)] = []
  private var link: CADisplayLink?, lastFrame: CFTimeInterval?
  private var active = true
  private var sampleTime: Double?
  private var sampled: (RobotShape, RobotAvatarMode, Double)?
  private var pokes = 0
  private var pokeTimes: [CFTimeInterval] = []
  private lazy var tap = UITapGestureRecognizer(target: self, action: #selector(poke))
  /// When this robot may next fidget on its own; owned by `RobotLife`.
  var nextFidget = CACurrentMediaTime() + .random(in: 1.5...11)
  var lastFidget = ""
  init(shape: RobotShape) {
    motion = .init(shape: shape)
    super.init(frame: .zero)
    isOpaque = false
    isUserInteractionEnabled = false
    // Hops and leans reach past the avatar's own box.
    clipsToBounds = false
    layer.addSublayer(root)
    root.anchorPoint = .zero
    root.bounds = CGRect(x: 0, y: 0, width: 108, height: 108)
    buildArtwork()
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  private var now: Double { CACurrentMediaTime() }
  private var live: Bool { active && window != nil }
  func configure(
    color: UIColor, shape: RobotShape, mode: RobotAvatarMode, reduced: Bool, active: Bool,
    sampleTime: Double?, faceColor: UIColor? = nil, outline: CGFloat? = nil,
    pokeable: Bool = false, seed: String? = nil
  ) {
    let changedShape = motion.shape != shape
    motion.setShape(shape)
    if changedShape { buildArtwork() }
    motion.setReducedMotion(reduced)
    motion.phase = seed.map(Self.phase) ?? 0
    pacer.request(mode)
    self.active = active
    self.sampleTime = sampleTime
    isUserInteractionEnabled = pokeable
    if pokeable, tap.view == nil { addGestureRecognizer(tap) }
    syncMode()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let resolved = color.resolvedColor(with: traitCollection)
    var r: CGFloat = 0
    var g: CGFloat = 0
    var b: CGFloat = 0
    var a: CGFloat = 0
    resolved.getRed(&r, green: &g, blue: &b, alpha: &a)
    let rgb =
      (Int((r * 255).rounded()) << 16) | (Int((g * 255).rounded()) << 8) | Int((b * 255).rounded())
    let face = faceColor ?? UIColor(Color(hex: rgb == 0 || rgb == 0x242424 ? "F2F2F2" : "1B1B1D"))
    func paint(_ key: String) -> CGColor? {
      if key == "none" { return nil }
      if key == "currentColor" { return resolved.cgColor }
      if key.hasPrefix("#") { return UIColor(Color(hex: String(key.dropFirst()))).cgColor }
      return face.cgColor
    }
    for (layer, fill, stroke, width) in inkLayers {
      layer.fillColor = outline != nil && fill != "none" ? UIColor.black.cgColor : paint(fill)
      layer.strokeColor = outline != nil ? UIColor.black.cgColor : paint(stroke)
      layer.lineWidth = outline.map { (stroke == "none" ? 0 : width) + 2 * $0 } ?? width
    }
    CATransaction.commit()
    applyPose()
    updateClock()
  }
  /// A stable phase for a seed: one of four quarter-breaths, as on the desktop.
  private static func phase(_ seed: String) -> Double {
    var hash: UInt32 = 2_166_136_261
    for unit in seed.utf16 { hash = (hash ^ UInt32(unit)) &* 16_777_619 }
    return Double(hash % 4) * 1.15
  }
  private func syncMode() {
    motion.setMode(live ? pacer.shown(at: now) : .still, animate: live)
    if live { RobotLife.shared.add(self) } else { RobotLife.shared.remove(self) }
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    root.position = .zero
    root.transform = CATransform3DMakeScale(bounds.width / 108, bounds.height / 108, 1)
    // Each display reports its own scale; layers built off screen catch up here.
    for (layer, _, _, _) in inkLayers where layer.contentsScale != traitCollection.displayScale {
      layer.contentsScale = traitCollection.displayScale
    }
    CATransaction.commit()
  }
  override func didMoveToWindow() {
    super.didMoveToWindow()
    syncMode()
    applyPose()
    updateClock()
  }
  func stop() {
    link?.invalidate()
    link = nil
    lastFrame = nil
  }
  private func updateClock() {
    guard live, motion.isAnimating || pacer.isPending, sampleTime == nil else {
      stop()
      return
    }
    if link == nil {
      let link = CADisplayLink(target: TickProxy(self), selector: #selector(TickProxy.tick(_:)))
      link.preferredFrameRateRange = .init(minimum: 30, maximum: 120, preferred: 60)
      link.add(to: .main, forMode: .common)
      self.link = link
    }
  }
  @MainActor private class TickProxy {
    weak var view: NativeRobotView?
    init(_ view: NativeRobotView) { self.view = view }
    @objc func tick(_ link: CADisplayLink) { view?.tick(link) }
  }
  private func tick(_ link: CADisplayLink) {
    if let lastFrame { motion.advance(by: link.timestamp - lastFrame) }
    lastFrame = link.timestamp
    motion.setMode(live ? pacer.shown(at: now) : .still, animate: live)
    if let cue = motion.pendingCue {
      motion.pendingCue = nil
      RobotLife.shared.cue(cue, from: self)
    }
    applyPose()
    if !motion.isAnimating && !pacer.isPending { stop() }
  }

  // MARK: Life
  var isResting: Bool { live && motion.mode == .idle && motion.isSettled }
  var looksAround: Bool { live && [.idle, .waiting, .done, .failed].contains(motion.mode) }
  /// Run something on the motion engine and keep the clock going for it.
  func act(_ body: (inout RobotMotion) -> Void) {
    guard live else { return }
    body(&motion)
    updateClock()
  }
  @objc func poke() {
    guard live else { return }
    let time = now
    pokeTimes = pokeTimes.filter { time - $0 < 2.6 } + [time]
    if pokeTimes.count >= 5 {
      // Five quick pokes in a row: spiral eyes and a woozy sway.
      pokeTimes = []
      motion.play("dizzy", interrupt: true)
      motion.pendingCue = .poke
    } else {
      motion.poke(pokes)
      pokes += 1
    }
    nextFidget = max(nextFidget, time + 6)
    updateClock()
  }

  private func applyPose() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    var frames = motion.frames()
    if let sampleTime {
      // A fixed moment of a mode's loop, for the motion lab and its screenshots.
      var sample = RobotMotion(shape: motion.shape, mode: .still)
      sample.setReducedMotion(motion.reducedMotion)
      sample.setMode(motion.mode, animate: false)
      sample.advance(by: sampleTime)
      frames = sample.frames()
    }
    for (id, layer) in layers {
      guard let frame = frames[id] else { continue }
      let m = frame.transform
      layer.setAffineTransform(.init(a: m.a, b: m.b, c: m.c, d: m.d, tx: m.tx, ty: m.ty))
      layer.opacity = Float(frame.opacity)
      layer.isHidden = !frame.visible
      dashed[id]?.strokeEnd = frame.strokeEnd
    }
    CATransaction.commit()
  }
  private func buildArtwork() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    root.sublayers?.forEach { $0.removeFromSuperlayer() }
    layers = [:]
    dashed = [:]
    inkLayers = []
    let design = RobotArtwork.shared[motion.shape]
    // The artwork is drawn in the desktop's view box, which starts at (-4, -4).
    let content = CALayer()
    content.anchorPoint = .zero
    content.position = CGPoint(x: 4, y: 4)
    content.bounds = CGRect(x: 0, y: 0, width: 100, height: 100)
    root.addSublayer(content)
    func group(_ id: String, _ origin: [Double]) -> CALayer {
      let layer = CALayer()
      layer.bounds = content.bounds
      layer.anchorPoint = CGPoint(x: origin[0] / 100, y: origin[1] / 100)
      layer.position = CGPoint(x: origin[0], y: origin[1])
      layers[id] = layer
      return layer
    }
    let rig = group("rig", design.rig.origin)
    content.addSublayer(rig)
    let body = group("body", design.body.origin)
    rig.addSublayer(body)
    for node in design.nodes { body.addSublayer(makeLayer(node)) }
    for node in design.glyphs { rig.addSublayer(makeLayer(node)) }
    CATransaction.commit()
  }
  private func makeLayer(_ node: RobotNode) -> CALayer {
    let layer: CALayer
    if node.tag == "g" {
      layer = CALayer()
    } else {
      let shape = CAShapeLayer()
      shape.path = Self.path(node)
      shape.lineWidth = node.strokeWidth
      shape.lineCap = CAShapeLayerLineCap(rawValue: node.strokeLinecap)
      shape.lineJoin = CAShapeLayerLineJoin(rawValue: node.strokeLinejoin)
      shape.contentsScale = traitCollection.displayScale
      inkLayers.append(
        (shape, node.tag == "line" ? "none" : node.fill, node.stroke, node.strokeWidth))
      if node.dashed { dashed[node.id] = shape }
      layer = shape
    }
    layer.bounds = CGRect(x: 0, y: 0, width: 100, height: 100)
    // The face plate's projected matrix already contains its origin.
    let origin = node.perspective ? CGPoint.zero : CGPoint(x: node.origin[0], y: node.origin[1])
    layer.anchorPoint = CGPoint(x: origin.x / 100, y: origin.y / 100)
    layer.position = origin
    layers[node.id] = layer
    if !node.transform.isEmpty, let shape = layer as? CAShapeLayer, let path = shape.path {
      // An SVG transform attribute is part of the shape itself.
      var transform = Self.svgTransform(node.transform)
      shape.path = path.copy(using: &transform)
    }
    for child in node.children { layer.addSublayer(makeLayer(child)) }
    return layer
  }
  static func path(_ node: RobotNode) -> CGPath {
    let path = CGMutablePath()
    switch node.tag {
    case "rect":
      let rect = CGRect(x: node["x"], y: node["y"], width: node["width"], height: node["height"])
      let rx = min(node["rx"], rect.width / 2)
      let ry = min(node.geometry["ry"] ?? rx, rect.height / 2)
      path.addRoundedRect(in: rect, cornerWidth: rx, cornerHeight: ry)
    case "circle":
      path.addEllipse(
        in: CGRect(
          x: node["cx"] - node["r"], y: node["cy"] - node["r"], width: node["r"] * 2,
          height: node["r"] * 2))
    case "ellipse":
      path.addEllipse(
        in: CGRect(
          x: node["cx"] - node["rx"], y: node["cy"] - node["ry"], width: node["rx"] * 2,
          height: node["ry"] * 2))
    case "line":
      path.move(to: CGPoint(x: node["x1"], y: node["y1"]))
      path.addLine(to: CGPoint(x: node["x2"], y: node["y2"]))
    case "polygon":
      for i in stride(from: 0, to: node.points.count - 1, by: 2) {
        let point = CGPoint(x: node.points[i], y: node.points[i + 1])
        if i == 0 { path.move(to: point) } else { path.addLine(to: point) }
      }
      path.closeSubpath()
    case "path":
      for (command, v) in RobotGeometry.commands(node.path) {
        switch command {
        case "M": path.move(to: CGPoint(x: v[0], y: v[1]))
        case "L": path.addLine(to: CGPoint(x: v[0], y: v[1]))
        case "Q": path.addQuadCurve(to: CGPoint(x: v[2], y: v[3]), control: CGPoint(x: v[0], y: v[1]))
        case "C":
          path.addCurve(
            to: CGPoint(x: v[4], y: v[5]), control1: CGPoint(x: v[0], y: v[1]),
            control2: CGPoint(x: v[2], y: v[3]))
        default: path.closeSubpath()
        }
      }
    default: break
    }
    return path
  }
  private static func svgTransform(_ source: String) -> CGAffineTransform {
    let regex = try! NSRegularExpression(pattern: "(translate|scale|rotate)\\(([^)]+)\\)")
    let text = source as NSString
    var transform = CGAffineTransform.identity
    for match in regex.matches(in: source, range: NSRange(location: 0, length: text.length)) {
      let args = text.substring(with: match.range(at: 2)).split { $0 == " " || $0 == "," }
        .compactMap { Double($0) }
      guard let first = args.first else { continue }
      switch text.substring(with: match.range(at: 1)) {
      case "translate":
        transform = transform.translatedBy(x: first, y: args.count > 1 ? args[1] : 0)
      case "scale": transform = transform.scaledBy(x: first, y: args.count > 1 ? args[1] : first)
      case "rotate": transform = transform.rotated(by: first * .pi / 180)
      default: break
      }
    }
    return transform
  }
}

/// What idle robots do on their own, and how they notice each other: the Swift counterpart
/// of the desktop's interaction module. Each robot fidgets every so often, and at most one
/// starts at a time across the screen; neighbours turn to look when one is poked, cheers or
/// fails.
@MainActor final class RobotLife {
  static let shared = RobotLife()
  private let robots = NSHashTable<NativeRobotView>.weakObjects()
  private var timer: Timer?
  private var lastFidget = 0.0
  private static let fidgets: [(String, Int)] = [
    ("look", 4), ("doubleBlink", 2), ("tiltLeft", 1), ("tiltRight", 1), ("hop", 1),
    ("sleepy", 1), ("hum", 1), ("antenna", 1),
  ]
  func add(_ robot: NativeRobotView) {
    robots.add(robot)
    guard timer == nil else { return }
    timer = Timer.scheduledTimer(withTimeInterval: 1.1, repeats: true) { _ in
      Task { @MainActor in RobotLife.shared.fidget() }
    }
  }
  func remove(_ robot: NativeRobotView) {
    robots.remove(robot)
    if robots.count == 0 {
      timer?.invalidate()
      timer = nil
    }
  }
  private func fidget() {
    let now = CACurrentMediaTime()
    guard now - lastFidget >= 2.2 else { return }
    let due = robots.allObjects.filter { $0.isResting && now >= $0.nextFidget }
    guard let robot = due.randomElement() else { return }
    lastFidget = now
    robot.nextFidget = now + .random(in: 9...22)
    let options = Self.fidgets.filter {
      $0.0 != robot.lastFidget && ($0.0 != "antenna" || robot.motion.hasAntenna)
    }
    var roll = Int.random(in: 0..<options.reduce(0) { $0 + $1.1 })
    let name = options.first { option in
      roll -= option.1
      return roll < 0
    }?.0 ?? "look"
    robot.lastFidget = name
    robot.act { motion in
      guard name == "look" else {
        motion.play("fidget." + name)
        return
      }
      let side: Double = Bool.random() ? 1 : -1
      motion.lookAround([
        (-0.85 * side, .random(in: 0.05...0.3), .random(in: 0.62...0.9)),
        (0.8 * side, .random(in: -0.35...0), .random(in: 0.56...0.82)),
      ])
    }
  }
  #if DEBUG
    /// The motion lab's stand-in for a tap, on the second robot it shows.
    func demoPoke() {
      let all = robots.allObjects.sorted { $0.convert(CGPoint.zero, to: nil).y < $1.convert(CGPoint.zero, to: nil).y || ($0.convert(CGPoint.zero, to: nil).y == $1.convert(CGPoint.zero, to: nil).y && $0.convert(CGPoint.zero, to: nil).x < $1.convert(CGPoint.zero, to: nil).x) }
      all.dropFirst(all.count > 4 ? 4 : 0).first?.poke()
    }
  #endif
  /// Neighbours turn to see what a robot just did, each a beat after the last.
  func cue(_ kind: RobotCue, from source: NativeRobotView) {
    guard let window = source.window else { return }
    let from = source.convert(CGPoint(x: source.bounds.midX, y: source.bounds.midY), to: window)
    for robot in robots.allObjects where robot !== source && robot.window === window && robot.looksAround {
      let to = robot.convert(CGPoint(x: robot.bounds.midX, y: robot.bounds.midY), to: window)
      let dx = Double(from.x - to.x)
      let dy = Double(from.y - to.y)
      let distance = hypot(dx, dy)
      guard distance >= 1, distance <= 760 else { continue }
      let at = Double.random(in: 0.06...0.26) + distance * 0.00022
      let hold = (kind == .poke ? 0.76 : 1.3) + Double.random(in: 0...0.42)
      let smiles = kind == .cheer && Double.random(in: 0...1) < 0.55
      robot.act { motion in
        motion.lookAround([(dx / distance * 0.95, dy / distance * 0.95, hold)], delay: at)
        if smiles { motion.express(.joy, duration: 0.72, delay: at + 0.42) }
      }
    }
  }
}

struct BotActivityRow: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let bot: Bot
  let mode: RobotAvatarMode
  let visible: Bool
  var text: String?
  var body: some View {
    HStack {
      // Keep the row geometry while giving the desktop artwork the reference's
      // visual weight; its 108-unit canvas includes padding around the robot.
      BotGlyph(
        color: Color(hex: bot.color), kind: bot.icon, size: 36, mode: mode, pokeable: true,
        seed: bot.id)
        .frame(width: 32, height: 32).offset(x: -2, y: 1)
        .scaleEffect(visible || reduceMotion ? 1 : 0.3)
        .opacity(visible ? 1 : 0)
        .animation(
          reduceMotion ? nil : .easeOut(duration: visible ? 0.18 : 0.12), value: visible)
      if let text {
        Text(text).font(.body).foregroundStyle(NativePalette.muted)
          .opacity(visible ? 1 : 0)
      }
      Spacer(minLength: 0)
    }.frame(height: visible ? 50 : 0).padding(.top, visible ? 2 : 0)
      .padding(.bottom, visible ? 12 : 0)
      .clipped()
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(text ?? (bot.name + (mode == .idle || mode == .waiting ? " needs input" : " is working")))
      .accessibilityIdentifier("bot-activity").accessibilityHidden(!visible)
  }
}
