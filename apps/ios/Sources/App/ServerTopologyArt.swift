import SwiftUI

// MARK: - W3 Server topology

/// The server as a live graph. This iPhone reaches the server, which fans out to its
/// database, task queue and bot computer; the bot computer offers a browser, files and
/// a terminal, and the AI model (the next stage) waits, dimmed. Links draw in
/// dependency order as each check passes and packets flow along healthy ones. A part
/// that isn't running turns red, its link breaks, and it says so; recovery draws back.
struct ServerTopologyArt: View {
  enum Status: Equatable { case hidden, checking, ok, problem }
  struct Part: Equatable {
    var key: String
    var status: Status
  }
  let parts: [Part]
  var host: String

  @Environment(\.wizardArtActive) private var active
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  // Where things sit, in points from the art's center.
  private static let phone = CGPoint(x: -134, y: 2)
  private static let server = CGPoint(x: -62, y: 2)
  private static let services: [(key: String, title: String, symbol: String, at: CGPoint)] = [
    ("database", "Database", "cylinder.split.1x2.fill", CGPoint(x: 26, y: -68)),
    ("queue", "Task queue", "tray.full.fill", CGPoint(x: 26, y: 2)),
    ("computer", "Bot computer", "desktopcomputer", CGPoint(x: 26, y: 72)),
  ]
  /// Chips are placed by their left edge, where their link ends.
  private static let chips: [(title: String, symbol: String, at: CGPoint)] = [
    ("Browser", "safari.fill", CGPoint(x: 90, y: 42)),
    ("Files", "folder.fill", CGPoint(x: 90, y: 72)),
    ("Terminal", "terminal.fill", CGPoint(x: 90, y: 102)),
  ]
  private static let model = CGPoint(x: 120, y: -62)
  private static let serverSize: CGFloat = 60
  private static let serviceSize: CGFloat = 42
  private static let chipWidth: CGFloat = 80

  private func status(_ key: String) -> Status {
    parts.first { $0.key == key }?.status ?? .hidden
  }
  private var allReady: Bool { !parts.isEmpty && parts.allSatisfy { $0.status == .ok } }
  private var computerReady: Bool { status("computer") == .ok }

  var body: some View {
    ZStack {
      links
      packets
      node(
        at: Self.phone, symbol: UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone",
        title: UIDevice.current.userInterfaceIdiom == .pad ? "This iPad" : "This iPhone",
        size: 44, status: .ok, delay: 0)
      node(
        at: Self.server, symbol: "server.rack", title: "Server", detail: host,
        size: Self.serverSize, status: status("server"), delay: 0.25, shared: true)
      ForEach(Array(Self.services.enumerated()), id: \.element.key) { index, service in
        node(
          at: service.at, symbol: service.symbol, title: service.title, size: Self.serviceSize,
          status: status(service.key), delay: 0.3)
      }
      ForEach(Array(Self.chips.enumerated()), id: \.element.title) { index, chip in
        TopologyChip(title: chip.title, symbol: chip.symbol, shown: computerReady)
          .animation(spring.delay(0.25 + Double(index) * 0.09), value: computerReady)
          .frame(width: Self.chipWidth, alignment: .leading)
          .offset(x: chip.at.x + Self.chipWidth / 2, y: chip.at.y)
      }
      TopologyNode(
        symbol: "sparkles", title: "AI model", detail: "next", size: Self.serviceSize,
        status: allReady ? .ok : .hidden, tint: WizardStage.model.accent, future: true
      )
      .animation(spring.delay(0.55), value: allReady)
      .offset(x: Self.model.x, y: Self.model.y)
    }
    .frame(width: WizardArt.size.width, height: WizardArt.size.height)
    .accessibilityHidden(true)
  }

  private var spring: Animation {
    reduceMotion ? .easeOut(duration: 0.25) : .bouncy(duration: 0.55, extraBounce: 0.16)
  }

  private func node(
    at point: CGPoint, symbol: String, title: String, detail: String? = nil, size: CGFloat,
    status: Status, delay: Double, shared: Bool = false
  ) -> some View {
    TopologyNode(
      symbol: symbol, title: title, detail: detail, size: size, status: status,
      tint: WizardStage.server.accent, shared: shared
    )
    .animation(spring.delay(status == .hidden ? 0 : delay), value: status == .hidden)
    .offset(x: point.x, y: point.y)
  }

  // MARK: Links

  private struct Link: Identifiable {
    let id: String
    let curve: TopologyCurve
    let shown: Bool
    let tone: TopologyLink.Tone
    var delay: Double = 0
  }

  private var linkList: [Link] {
    var list: [Link] = []
    let server = status("server")
    list.append(
      Link(
        id: "phone", curve: .between(Self.phone, Self.server, 22, Self.serverSize / 2),
        shown: server != .hidden, tone: tone(server)))
    for service in Self.services {
      let value = status(service.key)
      list.append(
        Link(
          id: service.key,
          curve: .between(Self.server, service.at, Self.serverSize / 2, Self.serviceSize / 2),
          shown: value != .hidden, tone: tone(value)))
    }
    for (index, chip) in Self.chips.enumerated() {
      list.append(
        Link(
          id: chip.title,
          curve: .between(Self.services[2].at, chip.at, Self.serviceSize / 2, 0),
          shown: computerReady, tone: .flowing, delay: 0.12 + Double(index) * 0.09))
    }
    list.append(
      Link(
        id: "model",
        curve: .between(Self.services[1].at, Self.model, Self.serviceSize / 2, Self.serviceSize / 2),
        shown: allReady, tone: .future, delay: 0.35))
    return list
  }

  private func tone(_ status: Status) -> TopologyLink.Tone {
    switch status {
    case .ok: return .flowing
    case .problem: return .broken
    case .checking, .hidden: return .waiting
    }
  }

  private var links: some View {
    ZStack {
      ForEach(linkList) { link in
        TopologyLink(curve: link.curve, shown: link.shown, tone: link.tone, delay: link.delay)
      }
    }
    .frame(width: WizardArt.size.width, height: WizardArt.size.height)
  }

  /// Packets along healthy links, and a quicker one toward the part being checked.
  private var packets: some View {
    TimelineView(.animation(minimumInterval: 1.0 / 60, paused: !active)) { timeline in
      let t = timeline.date.timeIntervalSinceReferenceDate
      Canvas { context, size in
        guard active else { return }
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        for (index, link) in linkList.enumerated() where link.shown {
          let speed: Double
          let color: Color
          switch link.tone {
          case .flowing:
            speed = 0.55
            color = WizardStage.server.accent
          case .waiting:
            speed = 1.3
            color = WizardStage.server.accent
          case .broken, .future: continue
          }
          for lane in 0..<2 {
            let phase = (t * speed + Double(index) * 0.29 + Double(lane) * 0.5)
              .truncatingRemainder(dividingBy: 1)
            let point = link.curve.point(at: phase)
            let fade = sin(phase * .pi)
            let dot = CGRect(x: center.x + point.x - 2.5, y: center.y + point.y - 2.5, width: 5, height: 5)
            context.fill(Path(ellipseIn: dot), with: .color(color.opacity(0.9 * fade)))
            context.fill(
              Path(ellipseIn: dot.insetBy(dx: -3, dy: -3)), with: .color(color.opacity(0.18 * fade)))
          }
        }
      }
    }
    .frame(width: WizardArt.size.width, height: WizardArt.size.height)
    .allowsHitTesting(false)
  }
}

/// A gentle S-curve between two nodes, from the right edge of one to the left of the other.
struct TopologyCurve: Equatable {
  var start: CGPoint
  var control1: CGPoint
  var control2: CGPoint
  var end: CGPoint

  static func between(
    _ from: CGPoint, _ to: CGPoint, _ fromHalf: CGFloat, _ toHalf: CGFloat
  ) -> TopologyCurve {
    let start = CGPoint(x: from.x + fromHalf + 3, y: from.y)
    let end = CGPoint(x: to.x - toHalf - 3, y: to.y)
    let reach = (end.x - start.x) * 0.55
    return TopologyCurve(
      start: start, control1: CGPoint(x: start.x + reach, y: start.y),
      control2: CGPoint(x: end.x - reach, y: end.y), end: end)
  }

  func point(at t: Double) -> CGPoint {
    let u = 1 - t
    let a = u * u * u
    let b = 3 * u * u * t
    let c = 3 * u * t * t
    let d = t * t * t
    return CGPoint(
      x: a * start.x + b * control1.x + c * control2.x + d * end.x,
      y: a * start.y + b * control1.y + c * control2.y + d * end.y)
  }

  func path(around center: CGPoint) -> Path {
    var path = Path()
    let shift = { (p: CGPoint) in CGPoint(x: p.x + center.x, y: p.y + center.y) }
    path.move(to: shift(start))
    path.addCurve(to: shift(end), control1: shift(control1), control2: shift(control2))
    return path
  }
}

private struct TopologyCurveShape: Shape {
  let curve: TopologyCurve
  func path(in rect: CGRect) -> Path { curve.path(around: CGPoint(x: rect.midX, y: rect.midY)) }
}

/// One link: it draws itself in from its source, breaks and dashes red when its part
/// is down, and stays faint and dotted for what comes next.
struct TopologyLink: View {
  enum Tone: Equatable { case waiting, flowing, broken, future }
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.colorScheme) private var scheme
  let curve: TopologyCurve
  let shown: Bool
  let tone: Tone
  var delay: Double = 0

  var body: some View {
    let shape = TopologyCurveShape(curve: curve)
    ZStack {
      if tone == .broken {
        // A gap in the middle, both ends dashed.
        shape.trim(from: 0, to: drawn * 0.4).stroke(color, style: style)
        shape.trim(from: 0.6, to: 0.6 + drawn * 0.4).stroke(color, style: style)
      } else {
        shape.trim(from: 0, to: drawn).stroke(color, style: style)
      }
    }
    .opacity(reduceMotion ? (shown ? 1 : 0) : 1)
    .animation(
      reduceMotion ? .easeOut(duration: 0.25) : .smooth(duration: 0.6).delay(shown ? delay : 0),
      value: shown
    )
    .animation(.smooth(duration: 0.4), value: tone)
  }

  /// With Reduce Motion the link fades in whole instead of drawing.
  private var drawn: CGFloat { reduceMotion || shown ? 1 : 0 }

  private var color: Color {
    switch tone {
    case .flowing: return WizardStage.server.accent.opacity(scheme == .dark ? 0.7 : 0.55)
    case .waiting: return Color.primary.opacity(0.22)
    case .broken: return Color(uiColor: .systemRed)
    case .future: return WizardStage.model.accent.opacity(0.45)
    }
  }
  private var style: StrokeStyle {
    switch tone {
    case .broken: return StrokeStyle(lineWidth: 2, lineCap: .round, dash: [4, 5])
    case .future: return StrokeStyle(lineWidth: 1.6, lineCap: .round, dash: [1.5, 5])
    case .waiting, .flowing: return StrokeStyle(lineWidth: 2, lineCap: .round)
    }
  }
}

/// A part of the server: an icon tile that pops in on a spring, pulses while it's
/// checked, rings and bounces when it passes, and turns red with "Not running" when
/// it doesn't.
struct TopologyNode: View {
  @Environment(\.wizardArtActive) private var active
  @Environment(\.wizardArtNamespace) private var namespace
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let symbol: String
  let title: String
  var detail: String? = nil
  let size: CGFloat
  let status: ServerTopologyArt.Status
  var tint: Color
  var shared = false
  /// A dimmed preview of the next stage.
  var future = false
  @State private var passes = 0

  private var problem: Bool { status == .problem }
  private var red: Color { Color(uiColor: .systemRed) }

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
    Image(systemName: symbol)
      .font(.system(size: size * 0.42, weight: .semibold))
      .foregroundStyle(problem ? AnyShapeStyle(red) : AnyShapeStyle(tint.gradient))
      .symbolEffect(.bounce, value: passes)
      .symbolEffect(.pulse, options: .repeating, isActive: status == .checking && active)
      .contentTransition(.symbolEffect(.replace))
      .frame(width: size, height: size)
      .background {
        shape.fill(WizardPalette.card)
          .shadow(color: Color(hex: "1B3B7A").opacity(future ? 0.06 : 0.16), radius: size * 0.3, y: size * 0.14)
          .wizardShared(shared ? "card" : "node-" + title, in: shared ? namespace : nil)
      }
      .overlay {
        shape.strokeBorder(
          problem ? red.opacity(0.9) : future ? tint.opacity(0.5) : .clear,
          style: StrokeStyle(lineWidth: problem ? 1.5 : 1, dash: future ? [3, 3] : []))
      }
      .background {
        // The ring that spreads out as the part passes its check.
        shape.stroke(WizardPalette.success, lineWidth: 2)
          .keyframeAnimator(initialValue: Ring(), trigger: passes) { view, ring in
            view.scaleEffect(ring.scale).opacity(ring.opacity)
          } keyframes: { _ in
            KeyframeTrack(\.scale) {
              MoveKeyframe(1)
              SpringKeyframe(1.65, duration: 0.7, spring: .smooth)
            }
            KeyframeTrack(\.opacity) {
              MoveKeyframe(0.85)
              CubicKeyframe(0, duration: 0.7)
            }
          }
      }
      .overlay(alignment: .topTrailing) { badge.offset(x: 5, y: -5) }
      .overlay(alignment: .top) {
        VStack(spacing: 1) {
          Text(title).font(.system(size: 10.5, weight: .semibold))
            .foregroundStyle(problem ? AnyShapeStyle(red) : AnyShapeStyle(.primary.opacity(future ? 0.5 : 0.85)))
          if problem {
            Text("Not running").font(.system(size: 8, weight: .bold))
              .foregroundStyle(.white)
              .padding(.horizontal, 5).padding(.vertical, 1.5)
              .background(red, in: Capsule())
              .transition(.scale(scale: 0.6).combined(with: .opacity))
          } else if let detail {
            Text(detail).font(.system(size: 8, weight: .medium, design: future ? .default : .monospaced))
              .foregroundStyle(.secondary)
              .lineLimit(1).truncationMode(.middle)
              .frame(maxWidth: 92)
          }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(width: 96)
        .offset(y: size + 3)
      }
      .opacity(status == .hidden ? 0 : future ? 0.75 : 1)
      .scaleEffect(status == .hidden && !reduceMotion ? 0.35 : 1)
      .animation(.bouncy(duration: 0.45), value: problem)
      .onChange(of: status) { before, after in
        guard after == .ok, before != .ok, !reduceMotion else { return }
        passes += 1
      }
  }

  private struct Ring {
    var scale: CGFloat = 1
    var opacity: Double = 0
  }

  @ViewBuilder private var badge: some View {
    switch status {
    case .ok where !future:
      Image(systemName: "checkmark.circle.fill").font(.system(size: size * 0.32))
        .foregroundStyle(.white, WizardPalette.success)
        .transition(.scale(scale: 0.3).combined(with: .opacity))
    case .problem:
      Image(systemName: "exclamationmark.circle.fill").font(.system(size: size * 0.32))
        .foregroundStyle(.white, red)
        .transition(.scale(scale: 0.3).combined(with: .opacity))
    default: EmptyView()
    }
  }
}

/// What the bot computer gives a bot: a small labelled capsule.
private struct TopologyChip: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let title: String
  let symbol: String
  let shown: Bool
  var body: some View {
    Label(title, systemImage: symbol)
      .labelStyle(TopologyChipLabel())
      .font(.system(size: 10, weight: .semibold))
      .foregroundStyle(.primary.opacity(0.8))
      .padding(.horizontal, 8).frame(height: 22)
      .background(WizardPalette.card, in: Capsule())
      .overlay { Capsule().strokeBorder(Color.primary.opacity(0.08)) }
      .shadow(color: Color(hex: "1B3B7A").opacity(0.1), radius: 6, y: 3)
      .opacity(shown ? 1 : 0)
      .scaleEffect(shown || reduceMotion ? 1 : 0.4, anchor: .leading)
  }
}

private struct TopologyChipLabel: LabelStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 4) {
      configuration.icon.foregroundStyle(WizardStage.server.accent)
      configuration.title
    }
  }
}
