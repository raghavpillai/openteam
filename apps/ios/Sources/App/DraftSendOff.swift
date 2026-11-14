import SwiftUI

/// The draft card's send-off, played only on the device that pressed Send: the Send pill gathers
/// into a blob and waits; on the confirmation it swallows the letter, the card closes around it,
/// and it slings at full speed into the Sending badge, where it bursts gold and is the Sent badge.
/// The summary is written in its wake.
///
/// Discard is its quiet opposite, on the same clock through the gulp and the close: the Discard
/// pill gathers into a grey blob, swallows the letter as the card closes, and is tossed: a small
/// hop, then out through the bottom of the card. The summary and the Discarded badge fade in
/// once it has gone.
enum DraftSendOff: Equatable {
  case idle
  case pressed
  case reverting
  /// The letter goes into the blob and the card closes. The date is the confirmation.
  case swallowing(Date)
  /// Wind-up, sling and the gold burst, on the same clock.
  case slinging(Date)

  /// The blob is held this long after the tap, so a fast server can't skip the press.
  static let minimumHold = 0.3
  static let discardHold = 0.2
  // Seconds after the confirmation. The letter is inside the blob before the card starts to close.
  static let gulp = 0.15
  static let close = (delay: 0.15, duration: 0.22)
  static let windUp = 0.29
  static let sling = 0.37
  static let hit = 0.53
  /// The solid gold stamp holds this long after the hit, then relaxes into the badge.
  static let stamp = 0.3
  static let relax = 0.2
  static let end = hit + stamp + relax + 0.01
  // Discard, after the same gulp and close: the blob leaves its place in one motion, up a little
  // and then down, out of the card.
  static let toss = (from: 0.31, to: 0.56)
  static let tossRise: CGFloat = 9
  /// The toss ends this far below the card's bottom edge.
  static let tossBelow: CGFloat = 60
  /// The card dips after the blob lets go of it.
  static let dip = 0.42
  /// The summary and the Discarded badge fade in, late enough not to show behind the falling blob.
  static let settling = (delay: 0.47, duration: 0.19)
  static let discardEnd = settling.delay + settling.duration + 0.02
  static let blob: CGFloat = 34
  /// As the card closes the blob settles this far down, onto the summary line and clear of the title.
  static let settle: CGFloat = 7
  /// Pure ease-in: the blob is fastest as it hits.
  static let launch = UnitCurve.bezier(
    startControlPoint: UnitPoint(x: 0.5, y: 0), endControlPoint: UnitPoint(x: 0.9, y: 0.4))

  var active: Bool { self != .idle }
  var confirmed: Bool {
    switch self {
    case .swallowing, .slinging: true
    default: false
    }
  }
}

/// A press of Send or Discard on a draft card that this device has not seen answered.
struct DraftPress: Equatable {
  let discards: Bool
  let at: Date
}

/// Frames the send-off travels between: the pressed pill, the summary line and the Sent badge.
struct DraftSendAnchors: PreferenceKey {
  static let defaultValue: [String: Anchor<CGRect>] = [:]
  static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) {
    value.merge(nextValue()) { $1 }
  }
}

/// Draws the send-off over the card, in the card's coordinate space. Until the wind-up the blob is
/// an ordinary view moved by implicit animations; only the sling runs a per-frame canvas, and that
/// canvas is the closed card's size.
struct DraftSendOffEffect: View {
  let phase: DraftSendOff
  /// Discard's send-off: the grey blob, which drops out of the card.
  let discards: Bool
  let pill: CGRect
  let badge: CGRect
  /// The card's frame; the blob rides its bottom edge, where the Send pill is unless a row sits under it.
  let card: CGRect
  /// How far the card still has to close.
  let closing: CGFloat
  /// False for the first frames after the press, so the pill is seen gathering into the blob.
  let gathered: Bool

  private var start: CGPoint { CGPoint(x: pill.minX + DraftSendOff.blob / 2, y: card.maxY - 12 - DraftSendOff.blob / 2) }
  /// Where the sling leaves from, in the closed card.
  private var launch: CGPoint { CGPoint(x: start.x, y: start.y + DraftSendOff.settle) }
  /// Aimed from the blob's place in the closed card, which is the same distance below the header
  /// whatever the open card's height.
  private func heading(from start: CGPoint) -> Double {
    discards ? .pi / 2 : atan2(badge.midY - start.y, badge.midX - start.x)
  }

  var body: some View {
    ZStack {
      switch phase {
      case .pressed, .reverting, .swallowing:
        DraftSendBlob(
          pill: pill, y: min(pill.midY, start.y), heading: heading(from: CGPoint(x: launch.x, y: launch.y - closing)),
          discards: discards, round: gathered && phase != .reverting, breathes: phase == .pressed, swallows: phase.confirmed)
      case .idle, .slinging: EmptyView()
      }
      // Mounted from the confirmation, though it draws nothing before the wind-up: setting the
      // canvas up costs a frame, which is better spent before anything moves.
      switch phase {
      case .swallowing(let confirmed), .slinging(let confirmed):
        DraftSendSling(
          confirmed: confirmed, launched: phase == .slinging(confirmed), start: launch, badge: badge,
          heading: heading(from: launch), discards: discards, card: card)
      default: EmptyView()
      }
    }
  }
}

/// The pressed pill as a blob: gathers, breathes while it waits, swells as it swallows. Send's is
/// the pill's own colour with the plane aimed at the badge; Discard's turns from the outlined pill
/// to solid grey with a cross.
private struct DraftSendBlob: View {
  let pill: CGRect
  let y: CGFloat
  let heading: Double
  let discards: Bool
  let round: Bool
  let breathes: Bool
  let swallows: Bool

  var body: some View {
    ZStack {
      Capsule().fill(discards ? (round ? DraftPalette.discarding : DraftPalette.fill) : DraftPalette.primary)
      if discards { Capsule().strokeBorder(DraftPalette.outline, lineWidth: 1).opacity(round ? 0 : 1) }
      // The label takes no room: wider than the blob, it would keep it from being a circle.
      Text(verbatim: discards ? "Discard" : "Send").font(.system(size: 15)).fixedSize()
        .frame(width: 0).opacity(round ? 0 : 1)
      // Aimed along the launch heading from the start; the glyph points up and to the right.
      Image(systemName: discards ? "xmark" : "paperplane.fill").font(.system(size: 14, weight: .semibold))
        .offset(x: discards ? 0 : -1, y: discards ? 0 : 0.5).rotationEffect(.radians(discards ? 0 : heading + .pi / 4))
        .scaleEffect(round ? 1 : 0.4).opacity(round ? 1 : 0)
    }
    .foregroundStyle(discards ? DraftPalette.text : DraftPalette.inverted)
    .frame(width: round ? DraftSendOff.blob : pill.width, height: DraftSendOff.blob)
    // The label goes with the pill, not past the blob's edge.
    .clipShape(Capsule())
    .phaseAnimator([1.0, 1.05]) { blob, scale in
      blob.scaleEffect(breathes ? scale : 1)
    } animation: { _ in .easeInOut(duration: 1.2) }
    .keyframeAnimator(initialValue: 1.0, trigger: swallows) { blob, scale in
      blob.scaleEffect(scale)
    } keyframes: { _ in
      CubicKeyframe(1.25, duration: DraftSendOff.gulp + 0.01)
      CubicKeyframe(1.08, duration: DraftSendOff.windUp - DraftSendOff.gulp - 0.01)
    }
    .position(x: pill.minX + (round ? DraftSendOff.blob : pill.width) / 2, y: y)
    .animation(.spring(response: 0.28, dampingFraction: 0.7), value: round)
    .offset(y: swallows ? DraftSendOff.settle : 0)
    .animation(
      .timingCurve(0.2, 0.9, 0.1, 1, duration: DraftSendOff.close.duration).delay(DraftSendOff.close.delay), value: swallows)
    .allowsHitTesting(false).accessibilityHidden(true)
  }
}

/// Wind-up, sling and burst. The head and the strand of goo trailing it share a blurred,
/// alpha-thresholded layer, and so do the gold splat and its drops, so they neck and merge; the
/// card's own shape clips it. Discard's blob is tossed through the same layer, out of the bottom
/// of the card, and nothing bursts.
private struct DraftSendSling: View {
  let confirmed: Date
  /// The plain blob has gone. It can go a frame before this timeline reaches the wind-up, and the
  /// blob is drawn here at rest for that frame rather than not at all.
  let launched: Bool
  let start: CGPoint
  let badge: CGRect
  let heading: Double
  let discards: Bool
  let card: CGRect
  /// The goo between the launch point and the head lets go this long after the head does.
  private static let cling = 0.07
  /// The splat pulling itself into the badge's shape: time, then width and height against the badge's.
  private static let splat: [(Double, CGFloat, CGFloat)] = [
    (0, 0.75, 1.9), (0.24, 1.5, 1.7), (0.56, 0.95, 0.9), (0.8, 1.03, 1.04), (1, 1, 1),
  ]
  /// Angle, distance, size: thrown wide, mostly down and back into the card, where there is room
  /// to see them.
  private static let drops: [(Double, CGFloat, CGFloat)] = [
    (0.35, 52, 13), (1.0, 66, 16), (2.15, 80, 17), (2.8, 58, 13), (3.4, 72, 15), (5.7, 46, 14),
  ]

  var body: some View {
    let card = card
    TimelineView(.animation) { timeline in
      // Drawn in step with the card (it is small), so taking over from the plain blob neither
      // leaves a gap nor doubles it while the card is still settling.
      Canvas { context, _ in
        context.translateBy(x: -card.minX, y: -card.minY)
        draw(&context, time: timeline.date.timeIntervalSince(confirmed))
      } symbols: {
        Image(systemName: "paperplane.fill").font(.system(size: 14, weight: .semibold))
          .foregroundStyle(DraftPalette.inverted).tag("plane")
        Image(systemName: "xmark").font(.system(size: 14, weight: .semibold))
          .foregroundStyle(DraftPalette.text).tag("cross")
        DraftStatusBadge(state: "sent", stamped: true).tag("stamp")
      }
    }
    .frame(width: card.width, height: card.height)
    .clipShape(RoundedRectangle(cornerRadius: 16))
    .offset(x: card.minX, y: card.minY)
    .allowsHitTesting(false).accessibilityHidden(true)
  }

  private static func unit(_ value: Double) -> Double { min(1, max(0, value)) }
  private static func mix(_ a: CGFloat, _ b: CGFloat, _ t: Double) -> CGFloat { a + (b - a) * t }

  private func point(_ distance: CGFloat) -> CGPoint {
    CGPoint(x: start.x + cos(heading) * distance, y: start.y + sin(heading) * distance)
  }
  private func blob(at center: CGPoint, along: CGFloat, across: CGFloat) -> Path {
    let rect = CGRect(x: -along / 2, y: -across / 2, width: along, height: across)
    return Path(ellipseIn: rect)
      .applying(CGAffineTransform(translationX: center.x, y: center.y).rotated(by: heading))
  }
  private func goo(_ context: inout GraphicsContext, _ paths: [Path], _ color: Color) {
    context.drawLayer { layer in
      layer.addFilter(.alphaThreshold(min: 0.5, color: color))
      layer.addFilter(.blur(radius: 4))
      layer.drawLayer { inner in
        for path in paths { inner.fill(path, with: .color(.white)) }
      }
    }
  }

  /// Discard's blob, tossed: it rises a little, then falls out through the bottom of the card,
  /// stretching with its speed and trailing the sling's strand of goo. Nothing is left behind.
  private func toss(_ context: inout GraphicsContext, time: Double) {
    let span = DraftSendOff.toss
    guard launched || time >= span.from, time < span.to + Self.cling else { return }
    let size = DraftSendOff.blob, rise = DraftSendOff.tossRise
    let drop = card.maxY + DraftSendOff.tossBelow - start.y
    let up = 2 * rise + 2 * sqrt(rise * rise + rise * drop), fall = drop + up
    func progress(_ at: Double) -> Double { Self.unit((at - span.from) / (span.to - span.from)) }
    func height(_ t: Double) -> CGFloat { start.y - up * t + fall * t * t }
    let t = progress(time), eased = min(1, t / 0.12)
    // Round at the top of the hop and as it lets go, long when it is fast.
    let speed = abs(2 * fall * t - up) / (2 * fall - up) * eased
    let plain = size * Self.mix(1.08, 1, eased)
    let head = CGPoint(x: start.x, y: height(t))
    var ink: [Path] = []
    if t < 1 { ink.append(blob(at: head, along: plain * (1 + 0.6 * speed), across: plain * (1 - 0.3 * speed))) }
    if time > span.from {
      // The strand, from where the blob was a moment ago to where it is.
      let from = height(progress(time - Self.cling)), length = abs(head.y - from)
      ink.append(blob(
        at: CGPoint(x: start.x, y: (from + head.y) / 2), along: length + 20,
        across: size * max(0.2, 0.78 - (length + 20) / 300)))
    }
    goo(&context, ink, DraftPalette.discarding)
    if t < 1, let cross = context.resolveSymbol(id: "cross") { context.draw(cross, at: head) }
  }

  private func draw(_ context: inout GraphicsContext, time: Double) {
    if discards { return toss(&context, time: time) }
    guard launched || time >= DraftSendOff.windUp else { return }
    let size = DraftSendOff.blob
    let to = CGPoint(x: badge.midX, y: badge.midY)
    // Pulled back 7 pt, then a straight line into the badge.
    let run = hypot(to.x - start.x, to.y - start.y) + 7
    let flight = DraftSendOff.hit - DraftSendOff.sling
    func travelled(_ at: Double) -> Double { DraftSendOff.launch.value(at: Self.unit((at - DraftSendOff.sling) / flight)) }
    let since = time - DraftSendOff.hit

    let wind = 1 - pow(1 - Self.unit((time - DraftSendOff.windUp) / (DraftSendOff.sling - DraftSendOff.windUp)), 2)
    let gone = travelled(time)
    let pull = Self.unit(gone / 0.4)
    let head = point(-7 * wind + run * gone)
    var ink: [Path] = []
    if since < 0 {
      ink.append(blob(
        at: head,
        along: size * (time < DraftSendOff.sling ? Self.mix(1.08, 0.8, wind) : Self.mix(0.8, 2.4, pull)),
        across: size * (time < DraftSendOff.sling ? Self.mix(1.08, 1.15, wind) : Self.mix(1.15, 0.55, pull))))
    }
    if time > DraftSendOff.sling, since < Self.cling {
      // The tail: stretched thin off the launch point, then whipping after the head and into the hit.
      let from = -7 + run * travelled(time - Self.cling), length = -7 + run * gone - from
      ink.append(blob(
        at: point(from + length / 2), along: length + 20, across: size * max(0.2, 0.78 - (length + 20) / 300)))
    }
    if !ink.isEmpty { goo(&context, ink, DraftPalette.primary) }
    if since < 0, let plane = context.resolveSymbol(id: "plane") {
      var glyph = context
      glyph.translateBy(x: head.x, y: head.y)
      glyph.rotate(by: .radians(heading + .pi / 4))
      glyph.draw(plane, at: CGPoint(x: -1, y: 0.5))
    }
    guard since >= 0 else { return }

    // The hit: the blob bursts gold over the Sending badge. The splat pulls itself into the
    // badge's shape, stamped "Sent", while drops fly off it; then the stamp relaxes into the badge.
    let fade = Self.unit((since - DraftSendOff.stamp) / DraftSendOff.relax)
    let solid = 1 - fade * fade * (3 - 2 * fade)
    if since < DraftSendOff.stamp {
      let at = since / DraftSendOff.stamp
      let next = Self.splat.firstIndex { $0.0 >= at } ?? Self.splat.count - 1
      let a = Self.splat[max(0, next - 1)], b = Self.splat[next]
      var step = b.0 > a.0 ? (at - a.0) / (b.0 - a.0) : 1
      step = next == 1 ? 1 - pow(1 - step, 3) : step * step * (3 - 2 * step)
      let width = badge.width * Self.mix(a.1, b.1, step), height = badge.height * Self.mix(a.2, b.2, step)
      var gold = [Path(
        roundedRect: CGRect(x: to.x - width / 2, y: to.y - height / 2, width: width, height: height),
        cornerRadius: min(width, height) / 2)]
      for (index, drop) in Self.drops.enumerated() {
        let flown = since / (0.28 + Double(index % 3) * 0.05)
        guard flown < 1 else { continue }
        let reach = drop.1 * (1 - pow(1 - flown, 3)), width = drop.2 * (1 - pow(flown, 1.6))
        gold.append(Path(ellipseIn: CGRect(
          x: to.x + cos(drop.0) * reach - width / 2, y: to.y + sin(drop.0) * reach - width / 2, width: width, height: width)))
      }
      goo(&context, gold, DraftPalette.sentSolid)
    } else {
      context.opacity = solid
      context.fill(Path(roundedRect: badge, cornerRadius: badge.height / 2), with: .color(DraftPalette.sentSolid))
    }
    if let stamp = context.resolveSymbol(id: "stamp") {
      let shown = Self.unit((since - 0.04) / 0.2)
      var label = context
      label.opacity = Self.unit((since - 0.04) / 0.08) * solid
      label.translateBy(x: to.x, y: to.y)
      let scale = 1 + 0.5 * pow(1 - shown, 3) * cos(shown * .pi * 1.5)
      label.scaleBy(x: scale, y: scale)
      label.draw(stamp, at: .zero)
    }
  }
}
