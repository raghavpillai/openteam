import SwiftUI

/// Question card colors: the draft card's ink at the alphas the desktop card uses.
enum QuestionPalette {
  static let text = DraftPalette.text
  static let secondary = DraftPalette.secondary
  static let tertiary = DraftPalette.tertiary
  static let inverted = DraftPalette.inverted
  static let fill = DraftPalette.color("1c1c1c0d", "f5f5f50d")
  static let fillPressed = DraftPalette.color("1c1c1c17", "f5f5f517")
  static let fillSelected = DraftPalette.color("1c1c1c1c", "f5f5f51f")
  static let outline = DraftPalette.color("1c1c1c33", "f5f5f538")
  static let control = DraftPalette.color("1c1c1c4d", "f5f5f552")
  static let green = DraftPalette.green
  static let greenFill = DraftPalette.color("14c16f24", "14c37026")
  /// The Skip button in flight: solid, where the chip it becomes is a faint tint.
  static let blob = DraftPalette.color("c2c2c2", "5c5c5c")
}

/// Curves and durations of the question card. The desktop card follows the same choreography.
enum QuestionMotion {
  /// QA builds only: `--qa-question-motion-speed 0.25` plays the card's motion at a fraction of
  /// its speed, so every frame can be stepped through. Always 1 otherwise.
  static let speed: Double = {
    #if DEBUG
      let arguments = ProcessInfo.processInfo.arguments
      if arguments.contains("--ui-testing"), let index = arguments.firstIndex(of: "--qa-question-motion-speed"),
        arguments.indices.contains(index + 1), let value = Double(arguments[index + 1]), value > 0 {
        return value
      }
    #endif
    return 1
  }()
  private static func paced(_ animation: Animation) -> Animation { speed == 1 ? animation : animation.speed(speed) }
  static func seconds(_ value: Double) -> Double { value / speed }
  static func pause(_ value: Double) -> Duration { .milliseconds(Int(value * 1000 / speed)) }

  /// The card closing around its receipt: the rows glide and the card's height follows on the
  /// same spring, so the edge never runs into a row. The height stops at its target (a row's
  /// height cannot overshoot without the transcript bouncing), which it reaches after 0.21 s.
  static let settle = paced(.spring(response: 0.32, dampingFraction: 0.8))
  /// A request leaves once the card has closed, because the list does not follow a height that
  /// changes while it reconfigures the row for the confirmed message.
  static let hold = pause(0.28)
  /// The card starts to close a moment after the parts it leaves behind start to melt, so they
  /// are nearly gone before anything slides over them. Skip waits longer: its blob lifts off
  /// before the card closes under it.
  static let lead = 0.04
  static let liftOff = 0.08
  static let skipHold = pause(0.32)
  /// A single choice shows its filled radio for this long before it turns into the receipt.
  static let pick = pause(0.11)
  /// A question closed from elsewhere closes once the transcript has been still for this long,
  /// and no later than `quietCap` after it was closed. A sent message keeps the list busy for
  /// its 0.35 s scroll and up to two 0.24 s row animations; an arriving one for the 0.45-0.65 s
  /// its scroll takes to settle, which can start a few frames after the message is stored.
  static let quiet = 0.75
  static let quietAfterArrival = 1.2
  static let quietCap = 3.0

  static let stagger = 0.03
  static let arrive = paced(.spring(response: 0.36, dampingFraction: 0.7))
  static let pressDown = paced(.easeOut(duration: 0.09))
  static let pressUp = paced(.spring(response: 0.3, dampingFraction: 0.5))
  static let blobIn = paced(.spring(response: 0.28, dampingFraction: 0.55))
  static let blobOut = paced(.easeIn(duration: 0.13))
  static let checkDraw = paced(.easeOut(duration: 0.16)).delay(seconds(0.08))
  static let checkRetract = paced(.easeIn(duration: 0.07))
  static let highlight = paced(.easeOut(duration: 0.18))
  /// A chosen control turning into the green receipt check.
  static let receipt = paced(.spring(response: 0.3, dampingFraction: 0.6))
  static let melt = paced(.easeOut(duration: 0.1))
  static let unmelt = paced(.spring(response: 0.32, dampingFraction: 0.78))
  static let meltStagger = 0.012
  /// The chip's icon and label resolving once the blob has landed.
  static let chip = paced(.spring(response: 0.26, dampingFraction: 0.7))
  static let quick = paced(.easeOut(duration: 0.12))
  static let blobSize: CGFloat = 24
}

/// Reports the question card's height while it closes or reopens.
///
/// SwiftUI animates a layout change by drawing the old frames moving to the new ones, but tells
/// the hosting table cell the final size at once, which would jump the transcript. This layout
/// instead reports a height that moves from the open card's to the settled card's with the
/// animation, so the cell and the transcript follow it frame by frame.
struct QuestionCloseLayout: Layout {
  /// The list resized the row for a settled message: report the content's own height.
  var listDriven: Bool
  /// The content is laid out as a receipt.
  var settled: Bool
  /// The content's height at rest in each layout, as last measured.
  var openHeight: CGFloat?
  var closedHeight: CGFloat?
  /// 0 reports the open height, 1 the settled one.
  var amount: CGFloat
  var animatableData: CGFloat {
    get { amount }
    set { amount = newValue }
  }
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard let view = subviews.first else { return .zero }
    let natural = view.sizeThatFits(ProposedViewSize(width: proposal.width, height: nil))
    guard !listDriven else { return natural }
    let open = settled ? openHeight ?? natural.height : natural.height
    let closed = settled ? natural.height : closedHeight ?? natural.height
    return CGSize(width: natural.width, height: max(0, open + (closed - open) * min(1, max(0, amount))))
  }
  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    subviews.first?.place(at: bounds.origin, anchor: .topLeading,
      proposal: ProposedViewSize(width: bounds.width, height: nil))
  }
}

/// The prompt, and the chip of a closed question beside it. The prompt never rewraps to make
/// room: a chip that doesn't fit on its line goes below it.
struct QuestionHeaderLayout: Layout {
  /// The chip takes room once the card has settled; until then it lands over the open card.
  var reserve: Bool
  static let gap: CGFloat = 10
  static let rowGap: CGFloat = 8
  private func arrange(width: CGFloat, subviews: Subviews) -> (prompt: CGSize, chip: CGSize?, inline: Bool) {
    guard let prompt = subviews.first else { return (.zero, nil, true) }
    guard subviews.count > 1 else {
      return (prompt.sizeThatFits(ProposedViewSize(width: width, height: nil)), nil, true)
    }
    let chip = subviews[1].sizeThatFits(.unspecified)
    let line = prompt.sizeThatFits(.unspecified)
    let inline = line.width + Self.gap + chip.width <= width
    let size = prompt.sizeThatFits(
      ProposedViewSize(width: inline ? width - Self.gap - chip.width : width, height: nil))
    return (size, chip, inline)
  }
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard let width = proposal.width else { return subviews.first?.sizeThatFits(proposal) ?? .zero }
    let layout = arrange(width: width, subviews: subviews)
    guard reserve, let chip = layout.chip else { return CGSize(width: width, height: layout.prompt.height) }
    return CGSize(width: width, height: layout.inline
      ? max(layout.prompt.height, chip.height) : layout.prompt.height + Self.rowGap + chip.height)
  }
  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    guard let prompt = subviews.first else { return }
    let layout = arrange(width: bounds.width, subviews: subviews)
    let size = ProposedViewSize(width: layout.prompt.width, height: layout.prompt.height)
    guard subviews.count > 1, let chip = layout.chip else {
      return prompt.place(at: bounds.origin, anchor: .topLeading, proposal: size)
    }
    if layout.inline {
      prompt.place(at: CGPoint(x: bounds.minX, y: bounds.midY), anchor: .leading, proposal: size)
      subviews[1].place(at: CGPoint(x: bounds.maxX, y: bounds.midY), anchor: .trailing, proposal: .unspecified)
    } else {
      prompt.place(at: bounds.origin, anchor: .topLeading, proposal: size)
      subviews[1].place(
        at: CGPoint(x: bounds.maxX, y: bounds.minY + layout.prompt.height + Self.rowGap + chip.height / 2),
        anchor: .trailing, proposal: .unspecified)
    }
  }
}

/// Skip and Send answer side by side, or one above the other when large text makes them too wide
/// for the card. Neither is ever truncated to make room.
struct QuestionActionsLayout: Layout {
  static let gap: CGFloat = 6
  private func sizes(_ subviews: Subviews, width: CGFloat?) -> (row: Bool, sizes: [CGSize]) {
    let ideal = subviews.map { $0.sizeThatFits(.unspecified) }
    let row = ideal.reduce(0) { $0 + $1.width } + Self.gap * CGFloat(max(0, ideal.count - 1))
    guard let width, row > width else { return (true, ideal) }
    return (false, subviews.map { $0.sizeThatFits(ProposedViewSize(width: width, height: nil)) })
  }
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let layout = sizes(subviews, width: proposal.width)
    let gaps = Self.gap * CGFloat(max(0, subviews.count - 1))
    return layout.row
      ? CGSize(width: layout.sizes.reduce(0) { $0 + $1.width } + gaps, height: layout.sizes.map(\.height).max() ?? 0)
      : CGSize(width: layout.sizes.map(\.width).max() ?? 0, height: layout.sizes.reduce(0) { $0 + $1.height } + gaps)
  }
  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let layout = sizes(subviews, width: bounds.width)
    var x = bounds.minX, y = bounds.minY
    // Stacked, the primary action (last) goes on top.
    for index in layout.row ? Array(subviews.indices) : Array(subviews.indices.reversed()) {
      let size = layout.sizes[index]
      if layout.row {
        subviews[index].place(at: CGPoint(x: x, y: bounds.midY), anchor: .leading,
          proposal: ProposedViewSize(width: size.width, height: size.height))
        x += size.width + Self.gap
      } else {
        subviews[index].place(at: CGPoint(x: bounds.maxX, y: y), anchor: .topTrailing,
          proposal: ProposedViewSize(width: size.width, height: size.height))
        y += size.height + Self.gap
      }
    }
  }
}

struct QuestionCheck: Shape {
  func path(in rect: CGRect) -> Path {
    var path = Path()
    path.move(to: CGPoint(x: rect.minX, y: rect.minY + rect.height * 0.55))
    path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.36, y: rect.maxY - rect.height * 0.08))
    path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + rect.height * 0.12))
    return path
  }
}

/// A checkbox (multi-select) or a radio (single-select), and the green check either becomes when
/// its answer is sent. The fill is a blob that grows from the centre; the check draws after it.
struct QuestionControl: View {
  enum Phase { case off, on, sent }
  let multi: Bool
  let phase: Phase
  /// A custom answer has no control until it is sent.
  var ring = true
  let motion: Bool
  private func animation(_ rise: Animation, _ fall: Animation) -> Animation? {
    guard motion else { return nil }
    switch phase {
    case .off: return fall
    case .on: return rise
    case .sent: return QuestionMotion.receipt
    }
  }
  var body: some View {
    let on = phase == .on, sent = phase == .sent
    let corner: CGFloat = multi && !sent ? 7 : 11
    ZStack {
      RoundedRectangle(cornerRadius: corner, style: .continuous)
        .strokeBorder(on ? QuestionPalette.text : QuestionPalette.control, lineWidth: 1.5)
        .opacity(sent || !ring ? 0 : 1)
        .animation(animation(QuestionMotion.highlight, QuestionMotion.blobOut), value: phase)
      RoundedRectangle(cornerRadius: multi && on ? 7 : 11, style: .continuous)
        .fill(QuestionPalette.text)
        .scaleEffect(on ? 1 : sent ? 0.6 : 0.15).opacity(on ? 1 : 0)
        .animation(animation(QuestionMotion.blobIn, QuestionMotion.blobOut), value: phase)
      Circle().fill(QuestionPalette.greenFill)
        .scaleEffect(sent ? 1 : 0.45).opacity(sent ? 1 : 0)
        .animation(animation(QuestionMotion.blobIn, QuestionMotion.blobOut), value: phase)
      QuestionCheck().trim(from: 0, to: sent || (multi && on) ? 1 : 0)
        .stroke(sent ? QuestionPalette.green : QuestionPalette.inverted,
          style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
        .frame(width: 11, height: 11)
        .animation(animation(QuestionMotion.checkDraw, QuestionMotion.checkRetract), value: phase)
      if !multi {
        Circle().fill(QuestionPalette.inverted).frame(width: 8, height: 8)
          .scaleEffect(on ? 1 : 0.2).opacity(on ? 1 : 0)
          .animation(animation(QuestionMotion.blobIn, QuestionMotion.blobOut), value: phase)
      }
    }.frame(width: 22, height: 22).accessibilityHidden(true)
  }
}

/// The frame shared by an option and the custom answer: a tile while the question is open, and
/// nothing but its content once it is a receipt row.
struct QuestionTile: ViewModifier {
  let on: Bool
  var focused = false
  /// Receipt layout: no padding, no fill.
  let receipt: Bool
  let motion: Bool
  func body(content: Content) -> some View {
    let shape = RoundedRectangle(cornerRadius: 13, style: .continuous)
    content.padding(.horizontal, receipt ? 0 : 12).padding(.vertical, receipt ? 0 : 10)
      .frame(maxWidth: .infinity, minHeight: receipt ? 22 : 46, alignment: .leading)
      .background {
        ZStack {
          shape.fill(QuestionPalette.fill)
          shape.fill(QuestionPalette.fillSelected).opacity(on ? 1 : 0)
            .animation(motion ? QuestionMotion.highlight : nil, value: on)
          shape.strokeBorder(focused ? QuestionPalette.secondary : QuestionPalette.outline, lineWidth: 1)
            .opacity(on || focused ? 1 : 0)
            .animation(motion ? QuestionMotion.highlight : nil, value: on)
            .animation(motion ? QuestionMotion.highlight : nil, value: focused)
        }.opacity(receipt ? 0 : 1)
      }
      .contentShape(shape)
  }
}

/// Squishes under the finger and springs back with a little overshoot.
struct QuestionPressStyle: ButtonStyle {
  let motion: Bool
  var scale: CGFloat = 0.97
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed && motion ? scale : 1)
      .opacity(configuration.isPressed ? 0.82 : 1)
      .animation(motion ? (configuration.isPressed ? QuestionMotion.pressDown : QuestionMotion.pressUp) : nil,
        value: configuration.isPressed)
  }
}

/// A part of the open card that the outcome leaves behind: it shrinks into itself and is gone.
/// While a card closed from elsewhere waits to close, the part is only dimmed.
struct QuestionMelt: ViewModifier {
  let gone: Bool
  var fading = false
  var delay = 0.0
  let motion: Bool
  func body(content: Content) -> some View {
    let level = gone ? 2 : fading ? 1 : 0
    content
      // The part moves as one piece when the card settles. Without this its text, shapes and
      // separately animated pieces each travel on their own and come apart on the way.
      .geometryGroup()
      .scaleEffect(x: level == 2 ? 0.93 : level == 1 ? 0.985 : 1, y: level == 2 ? 0.62 : level == 1 ? 0.985 : 1)
      .opacity(level == 2 ? 0 : level == 1 ? 0.38 : 1)
      .animation(motion
        ? (level == 2 ? QuestionMotion.melt.delay(QuestionMotion.seconds(delay))
          : level == 1 ? QuestionMotion.highlight : QuestionMotion.unmelt)
        : nil, value: level)
      .allowsHitTesting(level == 0)
      .accessibilityHidden(level != 0)
  }
}

/// Takes a melted part's room away once the card settles. The part stays in the view tree: a
/// view removed mid-animation is drawn from scratch for its transition, undoing the melt.
struct QuestionFold: ViewModifier {
  let folded: Bool
  /// The space above this part while it is shown.
  let gap: CGFloat
  func body(content: Content) -> some View {
    content.frame(height: folded ? 0 : nil, alignment: .top).padding(.top, folded ? 0 : gap)
  }
}

/// Options, the custom answer and the footer rise into a question that has just arrived.
struct QuestionArrival: ViewModifier {
  let staged: Bool
  let index: Int
  let motion: Bool
  func body(content: Content) -> some View {
    content
      .opacity(staged ? 0 : 1)
      .offset(y: staged ? 9 : 0)
      .scaleEffect(staged ? 0.955 : 1)
      .animation(motion ? QuestionMotion.arrive.delay(QuestionMotion.seconds(0.05 + Double(index) * QuestionMotion.stagger)) : nil,
        value: staged)
  }
}

/// How a question was closed without an answer.
struct QuestionChip: View {
  let reason: String
  let messageID: String
  /// False while the blob that becomes this chip is still on its way.
  let resolved: Bool
  let motion: Bool
  static func label(_ reason: String) -> String {
    reason == "moved-on" ? "Continued in chat" : reason == "superseded" ? "Replaced" : "Skipped"
  }
  var body: some View {
    HStack(spacing: 5) {
      Image(systemName: reason == "moved-on" ? "bubble.left"
        : reason == "superseded" ? "arrow.left.arrow.right" : "forward.end")
        .font(.system(size: 11, weight: .semibold)).accessibilityHidden(true)
      Text(Self.label(reason))
        .font(.footnote.weight(.medium))
        .accessibilityIdentifier("widget-dismissed-" + messageID)
        .accessibilityHint(reason == "moved-on" ? "This question closed when you sent a message."
          : reason == "superseded" ? "A newer question took its place."
          : "No answer was sent from this card.")
    }.foregroundStyle(QuestionPalette.secondary)
      .scaleEffect(resolved ? 1 : 0.7).opacity(resolved ? 1 : 0)
      .padding(.leading, 8).padding(.trailing, 10).padding(.vertical, 4)
      .background(QuestionPalette.fill.opacity(resolved ? 1 : 0), in: Capsule())
      .animation(motion ? QuestionMotion.chip : nil, value: resolved)
      .fixedSize()
  }
}

/// The blob that becomes a closed question's chip. Skip's is the Skip button itself: it gathers,
/// travels up the card on a slight arc and lands in the chip's place. A question closed from
/// elsewhere has no button to start from, so its chip buds out of the card's trailing edge.
struct QuestionChipFlight: Equatable {
  enum Kind { case skip, bud }
  var kind: Kind
  var started = Date()
  /// The pressed button, in the card's space.
  var from = CGRect.zero
  /// A failed skip flies back from wherever it is.
  var reversed: Date?
  var reversedTime = 0.0

  static let reverseSpeed = 1.2
  /// The blob leaves its place and reaches the chip's.
  var travel: (from: Double, to: Double) { kind == .skip ? (0.05, 0.27) : (0, 0.18) }
  /// The chip's icon and label resolve inside the landed blob.
  var resolve: Double { travel.to + 0.03 }
  var end: Double { travel.to + 0.17 }
  func time(at now: Date) -> Double {
    if let reversed {
      return max(0, reversedTime - now.timeIntervalSince(reversed) * Self.reverseSpeed * QuestionMotion.speed)
    }
    return now.timeIntervalSince(started) * QuestionMotion.speed
  }
}

/// Draws the flight over the card, in the card's space. The blob and the goo it trails share a
/// blurred, alpha-thresholded layer the size of the card, drawn only while the flight lasts.
struct QuestionChipGoo: View {
  let flight: QuestionChipFlight
  /// Where the chip is laid out. The blob gathers in place until this is known.
  let chip: CGRect?

  var body: some View {
    TimelineView(.animation) { timeline in
      Canvas { context, size in
        draw(&context, size: size, time: flight.time(at: timeline.date))
      } symbols: {
        Text("Skip").font(.subheadline.weight(.medium)).foregroundStyle(QuestionPalette.secondary).tag("label")
      }
    }.allowsHitTesting(false).accessibilityHidden(true)
  }

  private static func unit(_ value: Double) -> Double { min(1, max(0, value)) }
  private static func smooth(_ value: Double) -> Double {
    let t = unit(value)
    return t * t * (3 - 2 * t)
  }
  private static func mix(_ a: CGFloat, _ b: CGFloat, _ t: Double) -> CGFloat { a + (b - a) * t }
  private static func mix(_ a: CGPoint, _ b: CGPoint, _ t: Double) -> CGPoint {
    CGPoint(x: mix(a.x, b.x, t), y: mix(a.y, b.y, t))
  }
  /// The landed blob spreading into the chip: time, how far its width has got, and its squash.
  private static let landing: [(Double, CGFloat, CGFloat)] = [
    (0, 0, 1), (0.42, 1.1, 0.8), (0.72, 0.97, 1.06), (1, 1, 1),
  ]

  private func goo(_ context: inout GraphicsContext, opacity: Double, _ draw: (inout GraphicsContext) -> Void) {
    context.drawLayer { layer in
      layer.opacity = opacity
      layer.addFilter(.alphaThreshold(min: 0.5, color: QuestionPalette.blob))
      layer.addFilter(.blur(radius: 4))
      layer.drawLayer { inner in draw(&inner) }
    }
  }

  private func draw(_ context: inout GraphicsContext, size: CGSize, time: Double) {
    guard time < flight.end, flight.reversed == nil || time > 0 else { return }
    let blob = QuestionMotion.blobSize
    let span = flight.travel
    let skip = flight.kind == .skip
    let ink = GraphicsContext.Shading.color(.white)
    let from = skip
      ? CGPoint(x: flight.from.midX, y: flight.from.midY)
      : CGPoint(x: size.width + blob * 0.5, y: chip?.midY ?? 0)
    guard let chip, time >= span.from else {
      guard skip else { return }
      // The pressed button gathers into a blob, sinking a touch before it leaves.
      let gathered = Self.smooth(time / 0.07)
      let width = Self.mix(flight.from.width, blob, gathered), height = Self.mix(flight.from.height, blob, gathered)
      goo(&context, opacity: Self.unit(time / 0.04)) { layer in
        layer.fill(Path(roundedRect: CGRect(
          x: from.x - width / 2, y: from.y + 2 * gathered - height / 2, width: width, height: height),
          cornerRadius: height / 2), with: ink)
      }
      if let label = context.resolveSymbol(id: "label") {
        var text = context
        text.opacity = 1 - Self.unit(time / 0.06)
        text.draw(label, at: from)
      }
      return
    }
    let to = CGPoint(x: chip.midX, y: chip.midY)
    if time < span.to {
      // On the way: the head stretches along its path and drags a strand that thins as it goes.
      let distance = hypot(to.x - from.x, to.y - from.y)
      // Skip's path bows towards the middle of the card.
      let control = CGPoint(x: (from.x + to.x) / 2 - (skip ? distance * 0.16 : 0), y: (from.y + to.y) / 2)
      func point(_ at: Double) -> CGPoint {
        let u = skip ? Self.smooth((at - span.from) / (span.to - span.from))
          : 1 - pow(1 - Self.unit((at - span.from) / (span.to - span.from)), 2.4)
        return Self.mix(Self.mix(from, control, u), Self.mix(control, to, u), u)
      }
      let head = point(time), before = point(time - 0.012), tail = point(time - (skip ? 0.035 : 0.07))
      let speed = Self.unit(Double(hypot(head.x - before.x, head.y - before.y)) / 0.012 / Double(max(distance, 1)) / 5.6)
      let angle = atan2(head.y - before.y, head.x - before.x)
      let done = Self.unit((time - span.from) / (span.to - span.from))
      goo(&context, opacity: 1) { layer in
        let along = blob * (1 + 0.5 * speed), across = blob * (1 - 0.2 * speed)
        layer.fill(Path(ellipseIn: CGRect(x: -along / 2, y: -across / 2, width: along, height: across))
          .applying(CGAffineTransform(translationX: head.x, y: head.y).rotated(by: angle)), with: ink)
        var strand = Path()
        strand.move(to: tail)
        strand.addLine(to: head)
        layer.stroke(strand, with: ink,
          style: StrokeStyle(lineWidth: blob * (skip ? 0.84 - 0.28 * speed : 0.8 * (1 - done)), lineCap: .round))
        if !skip {
          // What is left on the edge the bud came from.
          let rest = blob * 0.62 * pow(1 - done, 0.8)
          layer.fill(Path(ellipseIn: CGRect(
            x: size.width + 3 - rest, y: to.y - rest, width: rest * 2, height: rest * 2)), with: ink)
        }
      }
      return
    }
    // Landed: the blob spreads into the chip with a small squash, then thins to the chip's tint.
    let at = Self.unit((time - span.to) / 0.13)
    let next = Self.landing.firstIndex { $0.0 >= at } ?? Self.landing.count - 1
    let a = Self.landing[max(0, next - 1)], b = Self.landing[next]
    let step = Self.smooth(b.0 > a.0 ? (at - a.0) / (b.0 - a.0) : 1)
    let width = Self.mix(blob, chip.width, Double(Self.mix(a.1, b.1, step)))
    let height = Self.mix(blob, chip.height, Self.smooth(at / 0.42)) * Self.mix(a.2, b.2, step)
    goo(&context, opacity: 1 - Self.smooth((time - flight.resolve) / (flight.end - flight.resolve))) { layer in
      layer.fill(Path(roundedRect: CGRect(x: to.x - width / 2, y: to.y - height / 2, width: width, height: height),
        cornerRadius: height / 2), with: ink)
    }
  }
}
