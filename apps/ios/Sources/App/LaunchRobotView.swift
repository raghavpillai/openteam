import SwiftUI

/// View-owned animation state keeps the launch fade in the window's transaction.
struct LaunchContentView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var showingLaunch = true
  @State private var launchOpacity = 1.0
  @State private var dismissing = false
  /// The first run's art, shared by sign-in and setup so it carries across both.
  @State private var backdrop = WizardBackdrop()

  /// Sign-in and first-run setup sit on the wizard's backdrop.
  private var wizard: Bool {
    store.phase == .signedOut || (store.phase == .ready && store.onboarding == .showing)
  }
  private enum Screen: Equatable { case none, signIn, onboarding, home }
  private var screen: Screen {
    guard !showingLaunch || dismissing else { return .none }
    switch store.phase {
    case .starting: return .none
    case .signedOut: return .signIn
    case .ready: return store.onboarding == .showing ? .onboarding : .home
    }
  }

  var body: some View {
    ZStack {
      Group {
        // Do not expose the underlying NavigationStack to accessibility while
        // the launch screen is waiting. Insert it as the launch fade begins.
        if !showingLaunch || dismissing {
          // Screens leave under a dissolving snapshot (ScreenHandoff): navigation
          // stacks can't run SwiftUI removal transitions.
          if wizard { WizardBackdropView() }
          switch store.phase {
          case .starting: Color.clear
          case .signedOut: SignInView()
          case .ready:
            if store.onboarding == .showing {
              OnboardingView()
            } else {
              HomeView().transition(reduceMotion ? .identity : .wizardArrival)
            }
          }
        }
      }
      .environment(backdrop)
      .animation(reduceMotion ? nil : .smooth(duration: 0.7), value: screen)
      .onChange(of: screen) { before, after in
        switch (before, after) {
        case (.signIn, .onboarding):
          // The art carries on underneath; only the page and bars dissolve.
          ScreenHandoff.dissolve(keepingLive: artRegion, reduceMotion: reduceMotion)
        case (.signIn, .home), (.onboarding, .home):
          ScreenHandoff.dissolve(reduceMotion: reduceMotion)
        default: break
        }
      }
      .allowsHitTesting(!showingLaunch)
      .accessibilityHidden(showingLaunch)
      if showingLaunch {
        // The launch robot dissolves toward the viewer as the app comes up behind it.
        LaunchRobotView()
          .scaleEffect(reduceMotion ? 1 : 1 + (1 - launchOpacity) * 0.25)
          .blur(radius: reduceMotion ? 0 : (1 - launchOpacity) * 12)
          .opacity(launchOpacity).zIndex(1)
      }
    }
    .statusBarHidden(showingLaunch)
    .persistentSystemOverlays(showingLaunch ? .hidden : .automatic)
    .background(
      NativeErrorPresenter(
        message: Binding(get: { showingLaunch ? nil : store.error }, set: { store.error = $0 }))
        .frame(width: 0, height: 0))
    .task {
      let clock = ContinuousClock()
      let began = clock.now
      NativeNotifications.shared.store = store
      await store.start()
      // Avoid a single-frame flash on fast launches, without delaying slower startup.
      let remaining = Duration.milliseconds(700) - (clock.now - began)
      if remaining > .zero { try? await Task.sleep(for: remaining) }
      guard !Task.isCancelled else { return }
      revealApp()
    }
  }

  /// The wizard art's band on screen, between the bars and the page.
  private var artRegion: ClosedRange<CGFloat>? {
    guard let slot = backdrop.slot, !slot.compact else { return nil }
    return slot.minY + slot.bars...slot.minY + slot.height
  }

  private func revealApp() {
    guard showingLaunch, !dismissing else { return }
    dismissing = true
    withAnimation(.easeOut(duration: reduceMotion ? 0.15 : 0.4), completionCriteria: .removed) {
      launchOpacity = 0
    } completion: {
      showingLaunch = false
      store.finishLaunch()
      Task {
        // An uncached notification lookup must not hold the launch screen.
        await NativeNotifications.shared.routePendingTap()
        // A restored account still in first-run setup is asked when setup finishes.
        await NativeNotifications.shared.resume(requestPermission: store.onboarding == .hidden)
      }
    }
  }
}

/// Hands the whole screen over from one top-level view to the next: a snapshot of
/// what was showing sits on top of the new screen and dissolves toward the viewer on a
/// critically damped spring. It never takes touches. Reduce Motion fades it only.
@MainActor enum ScreenHandoff {
  /// `keepingLive` is a band (in points from the top) left out of the snapshot, so
  /// whatever animates there underneath stays visible throughout.
  static func dissolve(keepingLive band: ClosedRange<CGFloat>? = nil, reduceMotion: Bool) {
    guard
      let window = UIApplication.shared.connectedScenes
        .compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first,
      let snapshot = window.snapshotView(afterScreenUpdates: false)
    else { return }
    snapshot.frame = window.bounds
    snapshot.isUserInteractionEnabled = false
    snapshot.accessibilityElementsHidden = true
    if let band {
      let mask = CAShapeLayer()
      let path = UIBezierPath(rect: CGRect(x: 0, y: 0, width: window.bounds.width, height: band.lowerBound))
      path.append(
        UIBezierPath(
          rect: CGRect(
            x: 0, y: band.upperBound, width: window.bounds.width,
            height: window.bounds.height - band.upperBound)))
      mask.path = path.cgPath
      snapshot.layer.mask = mask
    }
    window.addSubview(snapshot)
    let duration = reduceMotion ? 0.25 : band == nil ? 0.65 : 0.32
    let animator = UIViewPropertyAnimator(duration: duration, dampingRatio: 1) {
      snapshot.alpha = 0
      if !reduceMotion, band == nil {
        snapshot.transform = CGAffineTransform(scaleX: 1.06, y: 1.06)
      }
    }
    animator.addCompletion { _ in snapshot.removeFromSuperview() }
    animator.startAnimation()
  }
}

/// The launch surface contains only our robot and its soft ground shadow.
struct LaunchRobotView: View {
  @Environment(\.colorScheme) private var colorScheme
  private let robotColor = Color(hex: "FD6A3A")

  var body: some View {
    ZStack {
      (colorScheme == .dark ? Color.black : Color.white)
      ZStack {
        Ellipse()
          .fill(colorScheme == .dark ? robotColor.opacity(0.16) : Color.black.opacity(0.16))
          .frame(width: 76, height: 12).blur(radius: 8).offset(y: 65)
        BotGlyph(color: robotColor, kind: "chip", size: 120, mode: .thinking)
      }.frame(width: 160, height: 170)
    }
    .ignoresSafeArea()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Loading messages")
    .accessibilityIdentifier("launch-robot")
  }
}
