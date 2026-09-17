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
  var body: some View {
    RobotSurface(
      color: UIColor(color), shape: RobotShape(icon: kind), mode: mode,
      reduced: reduceMotion || forceReducedMotion, active: scenePhase == .active && inViewport,
      sampleTime: sampleTime
    )
    .frame(width: size, height: size).accessibilityHidden(true)
    .onScrollVisibilityChange(threshold: 0.01) { inViewport = $0 }
  }
}
private struct RobotSurface: UIViewRepresentable {
  var color: UIColor, shape: RobotShape, mode: RobotAvatarMode, reduced: Bool, active: Bool
  var sampleTime: Double?
  func makeUIView(context: Context) -> NativeRobotView { NativeRobotView(shape: shape) }
  func updateUIView(_ view: NativeRobotView, context: Context) {
    view.configure(
      color: color, shape: shape, mode: mode, reduced: reduced, active: active,
      sampleTime: sampleTime)
  }
  static func dismantleUIView(_ view: NativeRobotView, coordinator: ()) { view.stop() }
}

/// Core Animation vector layers keep the desktop SVG's flattened face projection and nested part
/// transforms. CADisplayLink evaluates the shared keyframes; no browser or video is embedded.
@MainActor final class NativeRobotView: UIView {
  private var motion: RobotMotion
  private let root = CALayer()
  private var faceLayers: [(CALayer, RobotNode)] = []
  private var partLayers: [String: CALayer] = [:]
  private var inkLayers: [(CAShapeLayer, String, String)] = []
  private var link: CADisplayLink?, lastFrame: CFTimeInterval?
  private var active = true
  private var requestedMode: RobotAvatarMode = .still
  private var sampleTime: Double?
  init(shape: RobotShape) {
    motion = .init(shape: shape)
    super.init(frame: .zero)
    isOpaque = false
    isUserInteractionEnabled = false
    layer.addSublayer(root)
    root.anchorPoint = .zero
    root.bounds = CGRect(x: 0, y: 0, width: 108, height: 108)
    buildArtwork()
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  func configure(
    color: UIColor, shape: RobotShape, mode: RobotAvatarMode, reduced: Bool, active: Bool,
    sampleTime: Double?
  ) {
    let changedShape = motion.shape != shape
    motion.setShape(shape)
    if changedShape { buildArtwork() }
    motion.setReducedMotion(reduced)
    requestedMode = mode
    motion.setMode(active && window != nil ? mode : .still, animate: active && window != nil)
    self.active = active
    self.sampleTime = sampleTime
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
    let face = UIColor(Color(hex: rgb == 0 || rgb == 0x242424 ? "F2F2F2" : "1B1B1D"))
    func paint(_ key: String) -> CGColor? {
      if key == "none" { return nil }
      return (key == "currentColor" ? resolved : face).cgColor
    }
    for (layer, fill, stroke) in inkLayers {
      layer.fillColor = paint(fill)
      layer.strokeColor = paint(stroke)
    }
    CATransaction.commit()
    applyPose()
    updateClock()
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    root.position = .zero
    root.transform = CATransform3DMakeScale(bounds.width / 108, bounds.height / 108, 1)
    CATransaction.commit()
  }
  override func didMoveToWindow() {
    super.didMoveToWindow()
    motion.setMode(
      window != nil && active ? requestedMode : .still, animate: window != nil && active)
    applyPose()
    updateClock()
  }
  func stop() {
    link?.invalidate()
    link = nil
    lastFrame = nil
  }
  private func updateClock() {
    guard window != nil, active, motion.isAnimating, sampleTime == nil else {
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
    applyPose()
    if !motion.isAnimating { stop() }
  }
  private func applyPose() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let design = RobotArtwork.shared[motion.shape]
    var poses: [String: RobotPose] = [:]
    for part in design.parts {
      let pose =
        sampleTime.map {
          RobotKeyframes.pose(
            part, mode: motion.reducedMotion ? .still : motion.mode, time: $0, tempo: design.tempo)
        } ?? motion.pose(part.id)
      poses[part.id] = pose
      let m = pose.matrix
      partLayers[part.id]?.setAffineTransform(
        .init(a: m[0], b: m[1], c: m[2], d: m[3], tx: m[4], ty: m[5]))
      partLayers[part.id]?.opacity = Float(pose.opacity)
    }
    for (layer, node) in faceLayers {
      let m = RobotProjection.faceMatrix(node, poses: poses)
      layer.setAffineTransform(.init(a: m[0], b: m[1], c: m[2], d: m[3], tx: m[4], ty: m[5]))
    }
    CATransaction.commit()
  }
  private func buildArtwork() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    root.sublayers?.forEach { $0.removeFromSuperlayer() }
    partLayers = [:]
    inkLayers = []
    faceLayers = []
    let content = CALayer()
    content.anchorPoint = .zero
    content.position = CGPoint(x: 4, y: 4)
    content.bounds = CGRect(x: 0, y: 0, width: 100, height: 100)
    root.addSublayer(content)
    let body = CALayer()
    body.bounds = content.bounds
    body.position = CGPoint(x: 50, y: 50)
    content.addSublayer(body)
    partLayers["body"] = body
    for node in RobotArtwork.shared[motion.shape].nodes { body.addSublayer(makeLayer(node)) }
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
      shape.contentsScale = UIScreen.main.scale
      inkLayers.append((shape, node.tag == "line" ? "none" : node.fill, node.stroke))
      layer = shape
    }
    layer.bounds = CGRect(x: 0, y: 0, width: 100, height: 100)
    let origin =
      !node.part.isEmpty ? CGPoint(x: node.origin[0], y: node.origin[1]) : .zero
    layer.anchorPoint = CGPoint(x: origin.x / 100, y: origin.y / 100)
    layer.position = origin
    layer.opacity = Float(node.opacity)
    if node.perspective {
      faceLayers.append((layer, node))
    } else if !node.transform.isEmpty {
      layer.setAffineTransform(Self.svgTransform(node.transform))
    }
    if !node.part.isEmpty { partLayers[node.id] = layer }
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
    case "line":
      path.move(to: CGPoint(x: node["x1"], y: node["y1"]))
      path.addLine(to: CGPoint(x: node["x2"], y: node["y2"]))
    case "polygon":
      for i in stride(from: 0, to: node.points.count - 1, by: 2) {
        let point = CGPoint(x: node.points[i], y: node.points[i + 1])
        if i == 0 { path.move(to: point) } else { path.addLine(to: point) }
      }
      path.closeSubpath()
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

struct BotActivityRow: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let bot: Bot
  let state: RobotAvatarMode?
  @State private var displayed: RobotAvatarMode = .still
  @State private var visible = false
  var body: some View {
    HStack {
      BotGlyph(color: Color(hex: bot.color), kind: bot.icon, size: 32, mode: displayed)
      Spacer()
    }.frame(height: visible ? 54 : 0).padding(.top, visible ? 2 : 0)
      .padding(.bottom, visible ? 12 : 0)
      .opacity(visible ? 1 : 0).clipped()
      .accessibilityElement(children: .ignore).accessibilityLabel("Bot is \(displayed.rawValue)")
      .accessibilityIdentifier("bot-activity").accessibilityHidden(!visible)
      .task(id: state) {
        if let state {
          displayed = state
          visible = true
        } else {
          displayed = .still
          if visible && !reduceMotion {
            try? await Task.sleep(for: .seconds(RobotMotion.transitionDuration))
          }
          guard !Task.isCancelled else { return }
          visible = false
        }
      }
  }
}
