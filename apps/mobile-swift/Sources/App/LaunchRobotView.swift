import SwiftUI

/// View-owned animation state keeps the launch fade in the window's transaction.
struct LaunchContentView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var showingLaunch = true
  @State private var launchOpacity = 1.0

  var body: some View {
    ZStack {
      Group {
        switch store.phase {
        case .starting: Color.clear
        case .signedOut: SignInView()
        case .ready: HomeView()
        }
      }
      .allowsHitTesting(!showingLaunch)
      .accessibilityHidden(showingLaunch)
      if showingLaunch {
        LaunchRobotView().opacity(launchOpacity).zIndex(1)
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
      await NativeNotifications.shared.routePendingTap()
      // Avoid a single-frame flash on fast launches, without delaying slower startup.
      let remaining = Duration.milliseconds(700) - (clock.now - began)
      if remaining > .zero { try? await Task.sleep(for: remaining) }
      guard !Task.isCancelled else { return }
      withAnimation(.easeOut(duration: reduceMotion ? 0.15 : 0.4), completionCriteria: .removed) {
        launchOpacity = 0
      } completion: {
        showingLaunch = false
        store.launchComplete = true
        Task { await NativeNotifications.shared.resume(requestPermission: true) }
      }
    }
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
