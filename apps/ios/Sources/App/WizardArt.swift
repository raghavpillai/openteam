import SwiftUI

/// The wizard's illustrations, drawn from the app's own robots and UI. The backdrop
/// lays each out at `size`, scaled to the header. Pieces tagged with `wizardShared`
/// (the card, provider icons) carry into the next step's art. Anything that moves
/// reads `wizardArtActive`, so it stops in the background or with Reduce Motion.
enum WizardArt {
  static let size = CGSize(width: 330, height: 236)
  /// The art header's height on each page, under the bars.
  static let headerHeight: CGFloat = 262
}

// MARK: - W0 Welcome

/// Two of the app's robots drop in on staggered springs beside the wizard's own robot
/// (the mascot, drawn by the backdrop), then float.
struct WelcomeArt: View {
  var body: some View {
    ZStack {
      FloatingRobot(color: "1685ED", kind: "tv-head", size: 104, tilt: -8, phase: 0)
        .modifier(RobotDrop(delay: 0.26, spin: -16))
        .offset(x: -108, y: 22)
      FloatingRobot(color: "FF9912", kind: "helmet", size: 104, tilt: 9, phase: 2.1)
        .modifier(RobotDrop(delay: 0.4, spin: 18))
        .offset(x: 110, y: 26)
    }
    .frame(width: WizardArt.size.width, height: WizardArt.size.height)
    .accessibilityHidden(true)
  }
}

/// One of the app's robots, bobbing gently while the art is active.
struct FloatingRobot: View {
  @Environment(\.wizardArtActive) private var active
  let color: String
  let kind: String
  let size: CGFloat
  var tilt: Double = 0
  var phase: Double = 0
  var body: some View {
    TimelineView(.animation(paused: !active)) { timeline in
      let t = timeline.date.timeIntervalSinceReferenceDate
      BotGlyph(color: Color(hex: color), kind: kind, size: size, mode: active ? .idle : .still)
        .rotationEffect(.degrees(tilt + (active ? sin(t * 0.9 + phase) * 3 : 0)))
        .offset(y: active ? sin(t * 1.4 + phase) * 6 : 0)
    }
    .frame(width: size, height: size)
    .shadow(color: .black.opacity(0.12), radius: 14, y: 10)
  }
}

// MARK: - W1/W2 Terminal

/// The end of setup in a terminal, with the line this screen asks for lit up.
struct TerminalArt: View {
  enum Line { case server, username }
  let highlight: Line
  var server = "http://192.168.1.20:8787"
  var username = "sam"
  @Environment(\.wizardArtNamespace) private var namespace
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 6) {
        ForEach(["FF5F57", "FEBC2E", "28C840"], id: \.self) { Circle().fill(Color(hex: $0)) }
          .frame(width: 9, height: 9)
        Spacer()
        Text("Terminal").font(.system(size: 10, weight: .medium)).foregroundStyle(.white.opacity(0.4))
        Spacer()
        Color.clear.frame(width: 39, height: 1)
      }
      .padding(.horizontal, 12).padding(.vertical, 10)
      VStack(alignment: .leading, spacing: 7) {
        Text("$ openteam setup").foregroundStyle(.white.opacity(0.45))
        Text("…").foregroundStyle(.white.opacity(0.3))
        HStack(spacing: 6) {
          Text("✓").foregroundStyle(Color(hex: "3DDC84"))
          Text("OpenTeam is ready").foregroundStyle(.white.opacity(0.9))
        }
        line("Server", server, lit: highlight == .server)
        line("Username", username, lit: highlight == .username)
      }
      .font(.system(size: 12.5, weight: .regular, design: .monospaced))
      .padding(.horizontal, 14).padding(.bottom, 16)
    }
    .frame(width: 300, alignment: .leading)
    .background {
      RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color(hex: "17171A"))
        .overlay {
          RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(.white.opacity(0.08))
        }
        .shadow(color: Color(hex: "1B3B7A").opacity(0.28), radius: 22, y: 14)
        .wizardShared("card", in: namespace)
    }
    .rotationEffect(.degrees(-2))
    .environment(\.colorScheme, .dark)
    .animation(.snappy, value: highlight)
    .animation(.smooth, value: username)
    .accessibilityHidden(true)
  }
  private func line(_ label: String, _ value: String, lit: Bool) -> some View {
    HStack(spacing: 0) {
      Text(label.padding(toLength: 10, withPad: " ", startingAt: 0))
        .foregroundStyle(.white.opacity(lit ? 0.75 : 0.35))
      Text(value).foregroundStyle(lit ? .white : .white.opacity(0.35))
        .fontWeight(lit ? .semibold : .regular)
        .lineLimit(1).minimumScaleFactor(0.7)
        .contentTransition(.interpolate)
    }
    .padding(.horizontal, 6).padding(.vertical, 4)
    .background {
      if lit {
        RoundedRectangle(cornerRadius: 6).fill(WizardStage.server.accent.opacity(0.42))
          .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(WizardStage.server.accent))
          .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: .leading)))
      }
    }
    .padding(.horizontal, -6)
  }
}

// W3's server graph is in ServerTopologyArt.swift.

// MARK: - W4/W5 Chat test

/// A tiny chat with the model: "Reply with OK", typing, then "OK" and how long it took.
/// When it answers, the card turns dark: a bloom swells behind it, light sweeps
/// across it, and a check and confetti pop from its corner.
struct ChatArt: View {
  enum Reply: Equatable { case none, typing, ok(seconds: Double), failed }
  var reply: Reply
  /// Provider icons floating around the chat (W4), or the one being tested (W5).
  var marks: [ProviderMark.Kind] = []
  var model: String? = nil
  /// The payoff: the chat turns dark, glows and bursts once the model answers.
  var dark = false
  var celebrate = 0
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.wizardArtNamespace) private var namespace
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var asked = false
  private let shape = RoundedRectangle(cornerRadius: 26, style: .continuous)

  private struct Payoff {
    var lift: CGFloat = 1
    var sweep: CGFloat = -0.5
    var bloom: CGFloat = 0.5
    var glow: Double = 0
  }

  var body: some View {
    ZStack {
      card
        .keyframeAnimator(initialValue: Payoff(), trigger: reduceMotion ? 0 : celebrate) {
          view, value in
          view
            .overlay { LightSweep(progress: value.sweep).clipShape(shape).allowsHitTesting(false) }
            .scaleEffect(value.lift)
            .background {
              Circle()
                .fill(
                  RadialGradient(
                    colors: [
                      WizardPalette.success.opacity(0.5), WizardStage.model.accent.opacity(0.4),
                      .clear,
                    ], center: .center, startRadius: 0, endRadius: 170)
                )
                .frame(width: 340, height: 340)
                .scaleEffect(value.bloom)
                .opacity(value.glow)
                .blur(radius: 16)
                .allowsHitTesting(false)
            }
        } keyframes: { _ in
          KeyframeTrack(\.lift) {
            SpringKeyframe(1.06, duration: 0.24, spring: .snappy)
            SpringKeyframe(1, duration: 0.7, spring: .bouncy(duration: 0.5, extraBounce: 0.12))
          }
          KeyframeTrack(\.sweep) {
            MoveKeyframe(-0.5)
            CubicKeyframe(-0.5, duration: 0.12)
            CubicKeyframe(1.5, duration: 0.8)
          }
          KeyframeTrack(\.bloom) {
            MoveKeyframe(0.5)
            SpringKeyframe(1.25, duration: 0.6, spring: .smooth)
            SpringKeyframe(1.1, duration: 0.8, spring: .smooth)
          }
          KeyframeTrack(\.glow) {
            MoveKeyframe(0)
            CubicKeyframe(1, duration: 0.18)
            CubicKeyframe(0.6, duration: 0.5)
            CubicKeyframe(0, duration: 0.8)
          }
        }
        .overlay(alignment: .topTrailing) {
          ZStack {
            CelebrationBurst(
              trigger: celebrate,
              colors: [WizardStage.model.accent, .green, .orange, .pink, .yellow], delay: 0.16)
            if dark { WizardCheck(size: 40) }
          }
          .offset(x: 12, y: -14)
        }
      if model == nil {
        ForEach(Array(marks.prefix(2).enumerated()), id: \.element) { index, mark in
          FloatingMark(kind: mark, index: index)
            .offset(x: index == 0 ? 146 : -146, y: index == 0 ? -84 : 74)
        }
      }
    }
    .frame(width: WizardArt.size.width, height: WizardArt.size.height)
    .animation(.bouncy(duration: 0.5, extraBounce: 0.1), value: reply)
    .animation(.smooth(duration: 0.45), value: dark)
    .onAppear {
      withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .bouncy(duration: 0.5).delay(0.3)) {
        asked = true
      }
    }
    .accessibilityHidden(true)
  }

  private var card: some View {
    VStack(spacing: 0) {
      HStack(spacing: 9) {
        if let model {
          let kind = marks.first ?? .other
          ProviderGlyph(kind: kind, style: .natural)
            .wizardShared("mark-\(kind)", in: namespace)
            .frame(width: 20, height: 20)
          Text(model).font(.system(size: 15, weight: .semibold)).lineLimit(1)
        } else {
          Text("Test message").font(.system(size: 15, weight: .semibold))
        }
        Spacer(minLength: 8)
        if model != nil, !dark {
          Circle().fill(statusColor).frame(width: 8, height: 8)
            .shadow(color: statusColor.opacity(0.8), radius: 4)
        }
      }
      .foregroundStyle(.primary)
      .padding(.horizontal, 16).frame(height: 46)
      WizardDivider(inset: 0)
      VStack(spacing: 12) {
        HStack {
          Spacer(minLength: 40)
          if asked {
            Text("Reply with OK").font(.system(size: 16, weight: .medium))
              .foregroundStyle(.white)
              .padding(.horizontal, 15).padding(.vertical, 10)
              .background(WizardStage.model.accent.gradient, in: BubbleShape(mine: true))
              .transition(.scale(scale: 0.4, anchor: .bottomTrailing).combined(with: .opacity))
          }
        }
        .frame(height: 42)
        HStack(alignment: .center, spacing: 8) {
          switch reply {
          case .none: EmptyView()
          case .typing:
            if asked {
              TypingBubble().transition(.scale(scale: 0.5, anchor: .leading).combined(with: .opacity))
            }
          case .ok(let seconds):
            Text("OK").font(.system(size: 16, weight: .medium)).foregroundStyle(.primary)
              .padding(.horizontal, 17).padding(.vertical, 10)
              .background(Color.primary.opacity(0.08), in: BubbleShape(mine: false))
              .transition(.scale(scale: 0.4, anchor: .bottomLeading).combined(with: .opacity))
            LatencyChip(seconds: seconds)
              .transition(.scale(scale: 0.6, anchor: .leading).combined(with: .opacity))
          case .failed:
            Label("No reply", systemImage: "exclamationmark.circle.fill")
              .font(.system(size: 15, weight: .medium)).foregroundStyle(.red)
              .padding(.horizontal, 15).padding(.vertical, 10)
              .background(Color.red.opacity(0.1), in: BubbleShape(mine: false))
              .transition(.scale(scale: 0.5, anchor: .leading).combined(with: .opacity))
              .wizardShake(on: reply)
          }
          Spacer(minLength: 0)
        }
        .frame(height: 42)
      }
      .padding(16)
    }
    .frame(width: 292)
    .background {
      shape.fill(dark ? WizardPalette.payoff : WizardPalette.card)
        .overlay { shape.strokeBorder(dark ? Color.white.opacity(0.08) : WizardPalette.cardBorder) }
        .shadow(
          color: dark ? WizardStage.model.accent.opacity(0.6) : Color(hex: "3B1F8F").opacity(0.14),
          radius: dark ? 30 : 20, y: 12
        )
        .wizardShared("card", in: namespace)
    }
    .scaleEffect(dark ? 1.03 : 1)
    .environment(\.colorScheme, dark ? .dark : colorScheme)
  }

  private var statusColor: Color {
    switch reply {
    case .ok: return WizardPalette.success
    case .failed: return .red
    default: return WizardStage.model.accent
    }
  }
}

/// A band of light that crosses the card once, from `progress` -0.5 (left) to 1.5.
private struct LightSweep: View {
  var progress: CGFloat
  var body: some View {
    GeometryReader { proxy in
      LinearGradient(
        colors: [.clear, .white.opacity(0.34), .clear], startPoint: .leading, endPoint: .trailing
      )
      .frame(width: proxy.size.width * 0.45, height: proxy.size.height * 2.2)
      .rotationEffect(.degrees(18))
      .position(x: proxy.size.width * progress, y: proxy.size.height / 2)
    }
    .blendMode(.plusLighter)
  }
}

/// "1.2 s" with a bolt; the digits roll in.
private struct LatencyChip: View {
  let seconds: Double
  @State private var shown: Double = 0
  var body: some View {
    Label {
      Text(String(format: "%.1f s", shown)).contentTransition(.numericText(value: shown))
    } icon: {
      Image(systemName: "bolt.fill").symbolEffect(.bounce, value: shown)
    }
    .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WizardPalette.success)
    .padding(.horizontal, 9).padding(.vertical, 5)
    .background(WizardPalette.success.opacity(0.16), in: Capsule())
    .onAppear { withAnimation(.snappy(duration: 0.6).delay(0.15)) { shown = seconds } }
    .onChange(of: seconds) { _, value in withAnimation(.snappy) { shown = value } }
  }
}

/// A provider's app icon that bobs gently while the art is active.
private struct FloatingMark: View {
  @Environment(\.wizardArtActive) private var active
  @Environment(\.wizardArtNamespace) private var namespace
  let kind: ProviderMark.Kind
  let index: Int
  var body: some View {
    ProviderGlyph(kind: kind, style: .icon)
      .wizardShared("mark-\(kind)", in: namespace)
      .frame(width: 50, height: 50)
      .shadow(color: .black.opacity(0.12), radius: 10, y: 5)
      .rotationEffect(.degrees(index == 0 ? 10 : -9))
      .phaseAnimator(active ? [0.0, 1.0] : [0.0]) { view, phase in
        view.offset(y: -5 * phase)
      } animation: { _ in .smooth(duration: 1.6) }
  }
}

/// Three dots that rise in turn while the model "types".
private struct TypingBubble: View {
  @Environment(\.wizardArtActive) private var active
  var body: some View {
    HStack(spacing: 5) {
      ForEach(0..<3, id: \.self) { index in
        Circle().fill(Color.primary.opacity(0.45)).frame(width: 7, height: 7)
          .phaseAnimator(active ? [0.0, 1.0, 0.0] : [0.0]) { view, phase in
            view.offset(y: -3 * phase).opacity(0.4 + 0.6 * phase)
          } animation: { _ in .smooth(duration: 0.28).delay(Double(index) * 0.12) }
      }
    }
    .padding(.horizontal, 16).padding(.vertical, 15)
    .background(Color.primary.opacity(0.08), in: BubbleShape(mine: false))
  }
}

/// A chat bubble with one squared corner, like the app's messages.
struct BubbleShape: Shape {
  var mine: Bool
  func path(in rect: CGRect) -> Path {
    let radius = min(18, rect.height / 2)
    return Path(
      roundedRect: rect,
      cornerRadii: RectangleCornerRadii(
        topLeading: radius, bottomLeading: mine ? radius : 5, bottomTrailing: mine ? 5 : radius,
        topTrailing: radius), style: .continuous)
  }
}

// MARK: - W4a Sign-in

/// The device code, big, on a card; its characters roll in.
struct DeviceCodeArt: View {
  let code: String
  var kind: ProviderMark.Kind = .chatgpt
  @Environment(\.wizardArtNamespace) private var namespace
  @State private var shown = ""
  var body: some View {
    VStack(spacing: 14) {
      HStack(spacing: 8) {
        ProviderGlyph(kind: kind, style: .natural)
          .wizardShared("mark-\(kind)", in: namespace)
          .frame(width: 22, height: 22)
        Text("Your sign-in code").font(.system(size: 13, weight: .semibold))
          .foregroundStyle(.secondary)
      }
      Text(shown.isEmpty ? String(repeating: "·", count: code.count) : shown)
        .font(.system(size: 36, weight: .semibold, design: .monospaced)).tracking(3)
        .foregroundStyle(.primary)
        .lineLimit(1).minimumScaleFactor(0.5)
        .contentTransition(.numericText())
        .accessibilityLabel("Sign-in code \(code.map(String.init).joined(separator: " "))")
        .accessibilityIdentifier("device-code")
    }
    .padding(.horizontal, 26).padding(.vertical, 24)
    .frame(width: 300)
    .background {
      RoundedRectangle(cornerRadius: 22, style: .continuous).fill(WizardPalette.card)
        .shadow(color: Color(hex: "3B1F8F").opacity(0.14), radius: 20, y: 12)
        .wizardShared("card", in: namespace)
    }
    .onAppear { withAnimation(.snappy(duration: 0.5).delay(0.2)) { shown = code } }
    .onChange(of: code) { _, value in withAnimation(.snappy) { shown = value } }
  }
}

/// A small browser window showing the provider's sign-in page.
struct BrowserArt: View {
  @Environment(\.wizardArtActive) private var active
  @Environment(\.wizardArtNamespace) private var namespace
  var kind: ProviderMark.Kind
  var host: String
  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 6) {
        Image(systemName: "lock.fill").font(.system(size: 9))
        Text(host).font(.system(size: 11, weight: .medium)).lineLimit(1)
      }
      .foregroundStyle(.secondary)
      .padding(.horizontal, 12).padding(.vertical, 6)
      .background(Color.primary.opacity(0.06), in: Capsule())
      .padding(.vertical, 10)
      WizardDivider(inset: 0)
      VStack(spacing: 12) {
        ProviderGlyph(kind: kind, style: .mark)
          .wizardShared("mark-\(kind)", in: namespace)
          .frame(width: 40, height: 40)
        Text("Authorize OpenTeam").font(.system(size: 15, weight: .semibold))
          .foregroundStyle(.primary)
        RoundedRectangle(cornerRadius: 9, style: .continuous)
          .fill(kind == .claude ? Color(hex: "C96442") : Color.primary)
          .frame(width: 150, height: 32)
          .overlay {
            Text("Authorize").font(.system(size: 13, weight: .semibold))
              .foregroundStyle(kind == .claude ? .white : NativePalette.onPrimary)
          }
          .phaseAnimator(active ? [1.0, 1.05] : [1.0]) { view, scale in
            view.scaleEffect(scale)
          } animation: { _ in .smooth(duration: 0.9) }
      }
      .padding(.vertical, 18)
    }
    .frame(width: 260)
    .background {
      RoundedRectangle(cornerRadius: 18, style: .continuous).fill(WizardPalette.card)
        .shadow(color: Color(hex: "3B1F8F").opacity(0.14), radius: 20, y: 12)
        .wizardShared("card", in: namespace)
    }
    .accessibilityHidden(true)
  }
}

/// A provider's icon with a turning ring while waiting, or a check once connected.
struct ConnectingArt: View {
  @Environment(\.wizardArtActive) private var active
  @Environment(\.wizardArtNamespace) private var namespace
  var kind: ProviderMark.Kind
  var connected: Bool
  var waiting = true
  var body: some View {
    ZStack(alignment: .bottomTrailing) {
      ZStack {
        TimelineView(.animation(paused: !active || connected || !waiting)) { timeline in
          let angle = active ? timeline.date.timeIntervalSinceReferenceDate * 300 : 0
          Circle().trim(from: 0, to: 0.72)
            .stroke(
              WizardStage.model.accent.opacity(connected || !waiting ? 0 : 0.8),
              style: .init(lineWidth: 3, lineCap: .round)
            )
            .frame(width: 128, height: 128)
            .rotationEffect(.degrees(angle.truncatingRemainder(dividingBy: 360)))
        }
        ProviderGlyph(kind: kind, style: .icon)
          .wizardShared("mark-\(kind)", in: namespace)
          .frame(width: 96, height: 96)
          .shadow(color: .black.opacity(0.12), radius: 16, y: 8)
          .scaleEffect(connected ? 1.06 : 1)
      }
      if connected { WizardCheck(size: 44).offset(x: 6, y: 6) }
    }
    .animation(.bouncy, value: connected)
    .accessibilityHidden(true)
  }
}

/// A key card with the providers it can be for; the guessed one stands out. A key for
/// one provider (OpenRouter) shows just that provider's icon, larger.
struct KeyArt: View {
  var provider: String
  var typed: Bool
  var accepted: Bool
  var single = false
  @Environment(\.wizardArtNamespace) private var namespace
  var body: some View {
    VStack(spacing: single ? 18 : 16) {
      HStack(spacing: 12) {
        ProviderMark(kind: .key, size: 40, style: .icon)
          .symbolEffect(.bounce, value: typed)
        Text(typed ? "sk-••••••••••••" : "Your API key")
          .font(.system(size: 16, weight: .medium, design: typed ? .monospaced : .default))
          .foregroundStyle(typed ? .primary : .secondary)
          .contentTransition(.interpolate)
        Spacer(minLength: 0)
        if accepted { WizardCheck(size: 26) }
      }
      .padding(.horizontal, 14).frame(width: 280, height: 64)
      .background {
        RoundedRectangle(cornerRadius: 16, style: .continuous).fill(WizardPalette.card)
          .shadow(color: Color(hex: "3B1F8F").opacity(0.12), radius: 16, y: 10)
          .wizardShared("card", in: namespace)
      }
      if single {
        let kind = ProviderMark.kind(for: provider)
        HStack(spacing: 12) {
          ProviderGlyph(kind: kind, style: .icon)
            .wizardShared("mark-\(kind)", in: namespace)
            .frame(width: 54, height: 54)
            .shadow(color: .black.opacity(0.16), radius: 12, y: 6)
          VStack(alignment: .leading, spacing: 2) {
            Text(APIKeyProviders.option(provider)?.title ?? provider)
              .font(.system(size: 17, weight: .semibold)).foregroundStyle(.primary)
            Text(APIKeyProviders.option(provider)?.tagline ?? "Billed per use")
              .font(.system(size: 12, weight: .medium))
              .foregroundStyle(.secondary)
          }
        }
      } else {
        providerTiles
      }
    }
    .animation(.bouncy(duration: 0.4), value: provider)
    .animation(.smooth, value: typed)
    .animation(.bouncy, value: accepted)
    .accessibilityHidden(true)
  }

  private var providerTiles: some View {
    HStack(spacing: 14) {
      ForEach(APIKeyProviders.options) { option in
        let kind = ProviderMark.kind(for: option.id)
        let chosen = option.id == provider
        VStack(spacing: 6) {
          ProviderGlyph(kind: kind, style: .icon)
            .wizardShared("mark-\(kind)", in: namespace)
            .frame(width: 46, height: 46)
            .overlay {
              ProviderIconShape()
                .stroke(WizardStage.model.accent, lineWidth: chosen ? 2.5 : 0)
                .padding(-3)
            }
            .shadow(color: .black.opacity(chosen ? 0.14 : 0.06), radius: chosen ? 10 : 4, y: 4)
          Text(option.title).font(.system(size: 11, weight: .semibold))
            .foregroundStyle(chosen ? .primary : .secondary)
        }
        .scaleEffect(chosen ? 1.08 : 0.92)
        .opacity(chosen ? 1 : 0.6)
      }
    }
  }
}

// MARK: - W5b Web search

/// A bot looking something up: the question, then fresh results with their sources.
/// Same card as desktop's SearchVisual.
struct SearchArt: View {
  @Environment(\.wizardArtNamespace) private var namespace
  var brand: String
  var name: String
  var on: Bool
  private static let results = [
    ("The best meeting venues in Lisbon", "timeout.com"),
    ("Event spaces for groups of 20–40", "visitlisboa.com"),
    ("Top-rated offsite venues, 2026 reviews", "tripadvisor.com"),
  ]
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        WebProviderIcon(brand: brand, size: 22)
        Text("Web search").font(.system(size: 13, weight: .semibold))
        Spacer(minLength: 4)
        Text(name).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
        if on { WizardCheck(size: 20) }
      }
      Text("Find a venue in Lisbon for our team offsite.")
        .font(.system(size: 13, weight: .medium)).foregroundStyle(.white)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(WizardStage.search.accent.gradient, in: BubbleShape(mine: true))
        .frame(maxWidth: .infinity, alignment: .trailing)
      ForEach(Self.results, id: \.1) { title, site in
        HStack(alignment: .top, spacing: 9) {
          Image(systemName: "globe").font(.system(size: 12, weight: .semibold))
            .foregroundStyle(WizardStage.search.accent).padding(.top, 2)
          VStack(alignment: .leading, spacing: 1) {
            Text(title).font(.system(size: 12.5, weight: .semibold)).lineLimit(1)
            Text(site).font(.system(size: 11)).foregroundStyle(.secondary)
          }
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(WizardStage.search.tint.opacity(0.7), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      }
    }
    .padding(12)
    .frame(width: 300)
    .background {
      RoundedRectangle(cornerRadius: 20, style: .continuous).fill(WizardPalette.card)
        .shadow(color: Color(hex: "0B5560").opacity(0.12), radius: 16, y: 8)
        .wizardShared("card", in: namespace)
    }
    .animation(.bouncy, value: on)
    .accessibilityHidden(true)
  }
}

// MARK: - W6 Voice

/// A microphone with a live waveform and what it heard.
struct VoiceArt: View {
  @Environment(\.wizardArtActive) private var active
  @Environment(\.wizardArtNamespace) private var namespace
  var on: Bool
  var body: some View {
    VStack(spacing: 18) {
      HStack(spacing: 16) {
        ZStack(alignment: .bottomTrailing) {
          Circle().fill(WizardStage.voice.accent.gradient).frame(width: 72, height: 72)
            .overlay {
              Image(systemName: "mic.fill").font(.system(size: 30, weight: .semibold))
                .foregroundStyle(.white)
                .symbolEffect(.bounce, value: on)
            }
            .shadow(color: WizardStage.voice.accent.opacity(0.4), radius: 14, y: 8)
          if on { WizardCheck(size: 28).offset(x: 4, y: 4) }
        }
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !active)) { timeline in
          let t = active ? timeline.date.timeIntervalSinceReferenceDate : 0
          HStack(alignment: .center, spacing: 4) {
            ForEach(0..<14, id: \.self) { index in
              let wave = active ? abs(sin(t * 3.2 + Double(index) * 0.55)) : 0.5
              Capsule().fill(WizardStage.voice.accent.opacity(0.85))
                .frame(width: 5, height: 10 + 36 * wave * (0.55 + 0.45 * sin(Double(index) * 1.7)))
            }
          }
          .frame(height: 56)
        }
      }
      Text("“Remind me to send the invoices on Friday.”")
        .font(.system(size: 15, weight: .medium)).foregroundStyle(.primary)
        .padding(.horizontal, 15).padding(.vertical, 11)
        .background {
          BubbleShape(mine: false).fill(WizardPalette.card)
            .shadow(color: Color(hex: "7A3B0B").opacity(0.1), radius: 14, y: 8)
            .wizardShared("card", in: namespace)
        }
        .frame(width: 290, alignment: .leading)
    }
    .animation(.bouncy, value: on)
    .accessibilityHidden(true)
  }
}

// MARK: - W7 Bot preview

/// The bot as it will appear: avatar, name, job and its first words. It wiggles on
/// Shuffle, bounces when the name changes, and the greeting reflows.
struct BotPreviewArt: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.wizardArtNamespace) private var namespace
  var avatar: FirstBot.Avatar
  var name: String
  var role: BotRole
  var shuffles = 0
  private struct Wiggle {
    var angle = 0.0
    var scale = 1.0
  }
  var body: some View {
    HStack(alignment: .center, spacing: 14) {
      VStack(spacing: 6) {
        BotGlyph(color: Color(hex: avatar.color), kind: avatar.shape, size: 92, mode: .idle)
          .id(avatar.shape + avatar.color)
          .transition(reduceMotion ? .opacity : .scale(scale: 0.5).combined(with: .opacity))
          // Reduce Motion holds the trigger still, so the wiggle never runs.
          .keyframeAnimator(initialValue: Wiggle(), trigger: reduceMotion ? 0 : shuffles) {
            view, value in
            view.rotationEffect(.degrees(value.angle)).scaleEffect(value.scale)
          } keyframes: { _ in
            KeyframeTrack(\.angle) {
              CubicKeyframe(-10, duration: 0.1)
              CubicKeyframe(9, duration: 0.12)
              CubicKeyframe(-5, duration: 0.12)
              SpringKeyframe(0, duration: 0.3, spring: .bouncy)
            }
            KeyframeTrack(\.scale) {
              CubicKeyframe(1.12, duration: 0.14)
              SpringKeyframe(1, duration: 0.45, spring: .bouncy)
            }
          }
          .shadow(color: .black.opacity(0.12), radius: 12, y: 8)
        Text(name.isEmpty ? "Your bot" : name).font(.system(size: 17, weight: .semibold))
          .foregroundStyle(.primary).lineLimit(1).minimumScaleFactor(0.6)
          .frame(maxWidth: 110)
          .contentTransition(.interpolate)
          .keyframeAnimator(initialValue: 1.0, trigger: reduceMotion ? "" : name) { view, scale in
            view.scaleEffect(scale)
          } keyframes: { _ in
            KeyframeTrack {
              CubicKeyframe(1.08, duration: 0.08)
              SpringKeyframe(1, duration: 0.3, spring: .snappy)
            }
          }
        Text(role.title).font(.system(size: 11, weight: .semibold))
          .foregroundStyle(WizardStage.bot.accent)
          .padding(.horizontal, 8).padding(.vertical, 3)
          .background(WizardStage.bot.accent.opacity(0.14), in: Capsule())
          .lineLimit(1)
          .contentTransition(.interpolate)
      }
      .frame(width: 116)
      // Typing updates the greeting as you go; a new job blurs its words over.
      ZStack(alignment: .topLeading) {
        Text(FirstBot.greeting(name: name, role: role))
          .font(.system(size: 14)).foregroundStyle(.primary)
          .fixedSize(horizontal: false, vertical: true)
          .contentTransition(.identity)
          .id(role.id)
          .transition(.wizardText(reduceMotion))
      }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .background {
          BubbleShape(mine: false).fill(WizardPalette.card)
            .shadow(color: Color(hex: "0B5A2E").opacity(0.1), radius: 14, y: 8)
            .wizardShared("card", in: namespace)
        }
        .frame(width: 190, alignment: .leading)
    }
    .animation(.bouncy(duration: 0.45), value: avatar)
    .animation(.smooth(duration: 0.35), value: role)
    .animation(.smooth(duration: 0.25), value: name)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Preview: \(name), \(role.title)")
    .accessibilityIdentifier("bot-preview")
  }
}

/// The server's bots, side by side.
struct BotGroupArt: View {
  struct Member: Equatable, Identifiable {
    let id: String
    let color: String
    let icon: String
  }
  var bots: [Member]
  var body: some View {
    HStack(spacing: -18) {
      ForEach(Array(bots.prefix(3).enumerated()), id: \.element.id) { index, bot in
        BotGlyph(color: Color(hex: bot.color), kind: bot.icon, size: index == 1 ? 104 : 84, mode: .idle)
          .shadow(color: .black.opacity(0.12), radius: 12, y: 8)
          .zIndex(index == 1 ? 1 : 0)
      }
    }
    .accessibilityHidden(true)
  }
}
