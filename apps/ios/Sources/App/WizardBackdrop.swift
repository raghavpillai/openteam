import SwiftUI

// One backdrop sits behind both first-run navigation stacks (sign-in W0–W2 and setup
// W3–W7). Pages are transparent at the top and opaque below, so the system push slides
// the text while the art stays put and morphs: the card, the provider icon and the
// guiding robot carry from step to step, and the mesh keeps drifting across stages.

// MARK: - Scene

/// What the first-run art shows. Each step maps to one scene; a change of case swaps
/// the illustration, other changes update it in place.
enum WizardScene: Equatable {
  case welcome
  case terminal(highlight: TerminalArt.Line, server: String, username: String)
  case server(parts: [ServerTopologyArt.Part], host: String)
  case chat(
    reply: ChatArt.Reply, marks: [ProviderMark.Kind], model: String?, dark: Bool, celebrate: Int)
  case deviceCode(code: String, kind: ProviderMark.Kind)
  case browser(kind: ProviderMark.Kind, host: String)
  case connecting(kind: ProviderMark.Kind, connected: Bool, waiting: Bool)
  /// `single`: the key is for one provider (OpenRouter), shown on its own.
  case key(provider: String, typed: Bool, accepted: Bool, single: Bool)
  case voice(on: Bool)
  case bot(avatar: FirstBot.Avatar, name: String, role: BotRole, shuffles: Int)
  case bots([BotGroupArt.Member])

  /// Where the wizard's green robot stands, relative to the art's center. It hops
  /// to the corner of each step's card and hands over to the new bot at the end.
  var mascot: WizardMascot.Placement {
    switch self {
    case .welcome: .init(x: 0, y: -6, size: 140, tilt: 0, float: 6)
    case .terminal: .init(x: 126, y: -84, size: 56, tilt: 12)
    case .server: .init(x: -62, y: -54, size: 34, tilt: -8)
    case .chat: .init(x: -154, y: -98, size: 48, tilt: -14)
    case .deviceCode: .init(x: -138, y: -62, size: 48, tilt: -14)
    case .browser: .init(x: -120, y: -94, size: 48, tilt: -14)
    case .connecting: .init(x: -66, y: -60, size: 46, tilt: -14)
    case .key: .init(x: -140, y: -70, size: 46, tilt: -14)
    case .voice: .init(x: -142, y: -64, size: 46, tilt: -14)
    case .bot: .init(x: -102, y: -25, size: 92, tilt: 0, shown: false)
    case .bots: .init(x: 0, y: -10, size: 92, tilt: 0, shown: false)
    }
  }
}

/// Where the page on top keeps its art: a transparent slot at the top of its scroll
/// view, which moves with scrolling and the keyboard.
struct WizardHeaderSlot: Equatable {
  /// The slot's top relative to the screen's: 0 at rest, negative once scrolled up.
  var minY: CGFloat
  /// The status and navigation bars, which the mesh runs under.
  var bars: CGFloat
  /// Accessibility text sizes leave out the art.
  var compact: Bool
  var height: CGFloat { bars + (compact ? 12 : WizardArt.headerHeight + 4) }
}

/// The first run's shared art state. Sign-in and setup publish their scene; the page
/// on top publishes its slot.
@MainActor @Observable final class WizardBackdrop {
  private(set) var stage: WizardStage = .server
  private(set) var scene: WizardScene = .welcome
  private(set) var slot: WizardHeaderSlot?
  private var placedBy: UUID?

  func show(_ scene: WizardScene, stage: WizardStage, reduceMotion: Bool) {
    guard scene != self.scene || stage != self.stage else { return }
    withAnimation(reduceMotion ? .easeOut(duration: 0.25) : .smooth(duration: 0.6)) {
      self.scene = scene
      self.stage = stage
    }
  }

  /// Scrolling moves the art directly; a different page taking over glides it.
  func place(_ slot: WizardHeaderSlot, by page: UUID, reduceMotion: Bool) {
    let handover = placedBy != nil && placedBy != page
    placedBy = page
    guard slot != self.slot else { return }
    if handover, self.slot != nil {
      withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .smooth(duration: 0.5)) {
        self.slot = slot
      }
    } else {
      var transaction = Transaction()
      transaction.disablesAnimations = true
      withTransaction(transaction) { self.slot = slot }
    }
  }
}

// MARK: - Backdrop

/// The page color, the stage's drifting mesh under the bars, and the scene's art, with
/// scroll and keyboard parallax.
struct WizardBackdropView: View {
  @Environment(WizardBackdrop.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.scenePhase) private var scenePhase
  @Namespace private var shared

  /// Motion runs only while the app is in front and Reduce Motion is off.
  private var active: Bool { !reduceMotion && scenePhase == .active }

  var body: some View {
    GeometryReader { proxy in
      ZStack(alignment: .top) {
        WizardPalette.page
        if let slot = model.slot {
          let top = slot.minY
          // Scrolled out from under the page: nothing here is seen, so nothing runs.
          let seen = top + slot.height > 0
          StageMesh(stage: model.stage, animated: active && seen)
            .frame(height: max(0, top + slot.height))
            .clipShape(
              UnevenRoundedRectangle(
                bottomLeadingRadius: 34, bottomTrailingRadius: 34, style: .continuous))
          if !slot.compact {
            art(width: proxy.size.width, top: top, bars: slot.bars)
              .environment(\.wizardArtActive, active && top > -220)
          }
        }
      }
    }
    .ignoresSafeArea()
    .environment(\.wizardArtNamespace, reduceMotion ? nil : shared)
    .accessibilityElement(children: .contain)
  }

  private func art(width: CGFloat, top: CGFloat, bars: CGFloat) -> some View {
    let fit = min(1, width / 360)
    let lift = max(0, -top)
    let pull = max(0, top)
    // The art drifts at half the page's speed, so the page slides over it; it shrinks
    // and fades as it's covered, and grows a little when the page is pulled down.
    let drift = reduceMotion ? 0 : lift * 0.5 - pull * 0.5
    let zoom = reduceMotion ? 1 : 1 - min(lift, 260) / 1300 + min(pull, 220) / 700
    let fade = reduceMotion ? 1 : 1 - min(lift / 240, 1) * 0.9
    return WizardSceneArt(scene: model.scene)
      .scaleEffect(fit * zoom)
      .frame(width: width, height: WizardArt.headerHeight)
      .opacity(fade)
      .offset(y: top + bars + 4 + drift)
  }
}

/// A mesh of the stage's tint and accent. It reads the clock directly, so the drift
/// never restarts, and cross-fades to a new stage's colors.
struct StageMesh: View {
  @Environment(\.colorScheme) private var scheme
  let stage: WizardStage
  let animated: Bool
  var body: some View {
    TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !animated)) { context in
      let t = context.date.timeIntervalSinceReferenceDate
      ZStack {
        StageMeshLayer(stage: stage, t: t, dark: scheme == .dark)
          .id(stage)
          .transition(.opacity)
      }
      .animation(.smooth(duration: 0.9), value: stage)
    }
  }
}

private struct StageMeshLayer: View {
  let stage: WizardStage
  let t: Double
  let dark: Bool
  var body: some View {
    let glow = stage.accent.opacity(dark ? 0.26 : 0.16)
    let soft = stage.accent.opacity(dark ? 0.12 : 0.07)
    let light = dark ? Color.clear : Color.white.opacity(0.55)
    ZStack {
      stage.tint
      MeshGradient(
        width: 3, height: 3,
        points: [
          [0, 0], [0.5, 0], [1, 0],
          [0, Float(0.5 + 0.1 * sin(t * 0.45))],
          [Float(0.5 + 0.14 * sin(t * 0.38)), Float(0.5 + 0.12 * cos(t * 0.31))],
          [1, Float(0.5 + 0.1 * cos(t * 0.41))],
          [0, 1], [0.5, 1], [1, 1],
        ],
        colors: [soft, light, glow, glow, light, soft, light, soft, glow])
    }
  }
}

// MARK: - Scene art

/// The scene's illustration and the guiding robot, laid out at `WizardArt.size`.
struct WizardSceneArt: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let scene: WizardScene
  var body: some View {
    ZStack {
      Group {
        switch scene {
        case .welcome: WelcomeArt()
        case .terminal(let highlight, let server, let username):
          TerminalArt(highlight: highlight, server: server, username: username)
        case .server(let parts, let host): ServerTopologyArt(parts: parts, host: host)
        case .chat(let reply, let marks, let model, let dark, let celebrate):
          ChatArt(reply: reply, marks: marks, model: model, dark: dark, celebrate: celebrate)
        case .deviceCode(let code, let kind): DeviceCodeArt(code: code, kind: kind)
        case .browser(let kind, let host): BrowserArt(kind: kind, host: host)
        case .connecting(let kind, let connected, let waiting):
          ConnectingArt(kind: kind, connected: connected, waiting: waiting)
        case .key(let provider, let typed, let accepted, let single):
          KeyArt(provider: provider, typed: typed, accepted: accepted, single: single)
        case .voice(let on): VoiceArt(on: on)
        case .bot(let avatar, let name, let role, let shuffles):
          BotPreviewArt(avatar: avatar, name: name, role: role, shuffles: shuffles)
        case .bots(let bots): BotGroupArt(bots: bots)
        }
      }
      .transition(reduceMotion ? .opacity : .wizardArt)
      // With Reduce Motion the robot fades between places instead of travelling.
      WizardMascot(placement: scene.mascot, dropIn: scene == .welcome)
        .id(reduceMotion ? AnyHashable(scene.mascot) : AnyHashable(0))
        .transition(.opacity)
    }
    .frame(width: WizardArt.size.width, height: WizardArt.size.height)
  }
}

extension AnyTransition {
  /// An illustration arriving comes into focus from slightly small; one leaving
  /// blurs and grows away. Shared pieces inside move on their own.
  static var wizardArt: AnyTransition {
    .asymmetric(
      insertion: .modifier(
        active: FocusPull(blur: 5, scale: 0.96, opacity: 0),
        identity: FocusPull(blur: 0, scale: 1, opacity: 1)),
      removal: .modifier(
        active: FocusPull(blur: 5, scale: 1.04, opacity: 0),
        identity: FocusPull(blur: 0, scale: 1, opacity: 1)))
  }
  /// The app arriving after the first run, under the dissolving first-run screen
  /// (ScreenHandoff): it comes into focus and settles from slightly small.
  static var wizardArrival: AnyTransition {
    .asymmetric(
      insertion: .modifier(
        active: FocusPull(blur: 6, scale: 0.95, opacity: 1),
        identity: FocusPull(blur: 0, scale: 1, opacity: 1)),
      removal: .identity)
  }
}

struct FocusPull: ViewModifier {
  var blur: CGFloat
  var scale: CGFloat
  var opacity: Double
  func body(content: Content) -> some View {
    content.blur(radius: blur).scaleEffect(scale).opacity(opacity)
  }
}

// MARK: - Mascot

/// The wizard's own robot. It stays on stage the whole way, so it carries the eye
/// from one step to the next; on Welcome it drops in first.
struct WizardMascot: View {
  struct Placement: Hashable {
    var x: CGFloat
    var y: CGFloat
    var size: CGFloat
    var tilt: Double
    var shown = true
    /// How far it bobs, in points at its placed size.
    var float: CGFloat = 4
  }
  @Environment(\.wizardArtActive) private var active
  let placement: Placement
  var dropIn = false
  private let drawn: CGFloat = 140

  var body: some View {
    let unit = drawn / placement.size
    TimelineView(.animation(paused: !active)) { timeline in
      let t = timeline.date.timeIntervalSinceReferenceDate
      BotGlyph(color: Color(hex: "08C875"), kind: "chip", size: drawn, mode: active ? .idle : .still)
        .rotationEffect(.degrees(active ? sin(t * 0.9 + 1) * 3 : 0))
        .offset(y: active ? sin(t * 1.4 + 1) * placement.float * unit : 0)
    }
    .frame(width: drawn, height: drawn)
    .shadow(color: .black.opacity(0.14), radius: 14, y: 10)
    .modifier(RobotDrop(delay: 0.12, spin: 10, enabled: dropIn))
    // Drawn once at its largest size and scaled, so moving between places is one smooth
    // spring instead of a redraw.
    .scaleEffect(placement.size / drawn)
    .rotationEffect(.degrees(placement.tilt))
    .offset(x: placement.x, y: placement.y)
    .opacity(placement.shown ? 1 : 0)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

/// A robot dropping onto the stage: it falls in stretched, squashes as it lands and
/// settles with a wobble. Reduce Motion fades it in instead.
struct RobotDrop: ViewModifier {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var delay: Double
  var spin: Double = 12
  var enabled = true
  @State private var landed = false
  private struct Fall {
    var y: CGFloat = 0
    var stretch: CGFloat = 1
    var spin: Double = 0
    var shown: Double = 1
  }
  func body(content: Content) -> some View {
    content
      .keyframeAnimator(initialValue: Fall(), trigger: landed) { view, fall in
        view
          .scaleEffect(x: 2 - fall.stretch, y: fall.stretch, anchor: .bottom)
          .rotationEffect(.degrees(fall.spin))
          .offset(y: fall.y)
          .opacity(fall.shown)
      } keyframes: { _ in
        KeyframeTrack(\.shown) {
          MoveKeyframe(0)
          CubicKeyframe(1, duration: 0.18)
        }
        KeyframeTrack(\.y) {
          MoveKeyframe(-190)
          SpringKeyframe(0, duration: 0.62, spring: Spring(response: 0.42, dampingRatio: 0.58))
        }
        KeyframeTrack(\.stretch) {
          MoveKeyframe(1.12)
          CubicKeyframe(1.1, duration: 0.24)
          CubicKeyframe(0.84, duration: 0.1)
          SpringKeyframe(1, duration: 0.5, spring: .bouncy(duration: 0.45, extraBounce: 0.2))
        }
        KeyframeTrack(\.spin) {
          MoveKeyframe(-spin)
          SpringKeyframe(0, duration: 0.9, spring: .bouncy(duration: 0.6, extraBounce: 0.15))
        }
      }
      .opacity(landed || !enabled ? 1 : 0)
      .onAppear {
        guard enabled, !landed else { return }
        if reduceMotion {
          withAnimation(.easeOut(duration: 0.3).delay(delay)) { landed = true }
          return
        }
        Task { @MainActor in
          try? await Task.sleep(for: .seconds(delay))
          landed = true
        }
      }
  }
}

// MARK: - Shared elements

private struct WizardArtNamespaceKey: EnvironmentKey {
  static let defaultValue: Namespace.ID? = nil
}

extension EnvironmentValues {
  /// The backdrop's namespace for pieces that carry between scenes. Nil with Reduce
  /// Motion, so scenes simply cross-fade.
  var wizardArtNamespace: Namespace.ID? {
    get { self[WizardArtNamespaceKey.self] }
    set { self[WizardArtNamespaceKey.self] = newValue }
  }
}

extension View {
  /// Carries this piece (the card, a provider icon) into the next scene's piece with
  /// the same id: it moves and resizes there instead of fading out and in.
  @ViewBuilder func wizardShared(_ id: String, in namespace: Namespace.ID?) -> some View {
    if let namespace {
      matchedGeometryEffect(id: id, in: namespace)
    } else {
      self
    }
  }
}
