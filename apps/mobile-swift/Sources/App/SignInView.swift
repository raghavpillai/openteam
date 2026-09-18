import SwiftUI

struct SignInView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @ScaledMetric(relativeTo: .title2) private var headingSize = 24
  @State private var username = ""
  @State private var password = ""
  @State private var showingPassword = false
  @State private var request: Task<Void, Never>?
  @State private var keyboardTop: CGFloat?
  @State private var endpointHeight: CGFloat = 210
  @State private var credentialsHeight: CGFloat = 280
  @State private var interactiveStage: Int? = 0
  @FocusState private var field: Field?
  private enum Field { case server, username, password }
  private var stage: Int {
    store.authPath.last == .credentials ? 2 : store.authPath.isEmpty ? 0 : 1
  }
  private var dark: Bool { colorScheme == .dark }
  private var secondary: Color {
    (dark ? Color.white : Color(hex: "111111")).opacity(dark ? 0.70 : 0.62)
  }
  private var placeholder: Color {
    (dark ? Color.white : Color(hex: "111111")).opacity(dark ? 0.46 : 0.42)
  }
  private var cleartext: Bool {
    store.server.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("http://")
  }

  var body: some View {
    GeometryReader { geometry in
      let fullHeight =
        geometry.size.height + geometry.safeAreaInsets.top + geometry.safeAreaInsets.bottom
      let keyboardInset = keyboardTop.map { max(0, geometry.frame(in: .global).maxY - $0) } ?? 0
      let offstage = geometry.size.width + 24
      ZStack(alignment: .top) {
        AuthBotField(size: CGSize(width: geometry.size.width, height: fullHeight), stage: stage)
        hero
          .scaleEffect(stage == 0 ? 1 : 0.96)
          .padding(.horizontal, 24)
          .offset(
            y: (stage == 0 ? max(48, fullHeight * 0.42) : 48)
              - (keyboardInset > 0 ? fullHeight * 0.42 : 0)
          )
          .accessibilityHidden(keyboardInset > 0)
        if keyboardInset > 0 {
          Color.clear.contentShape(Rectangle()).onTapGesture { field = nil }.accessibilityHidden(
            true)
        }
        VStack(spacing: 8) {
          if stage == 0 { errorNotice }
          authButton("Log In", identifier: "get-started") {
            store.authError = nil
            NativeHaptics.play(.light, source: "auth.get-started")
            store.authPath = [.endpoint]
          }
        }
        .padding(.horizontal, 26).padding(.bottom, 14)
        .frame(maxHeight: .infinity, alignment: .bottom)
        .offset(y: stage == 0 ? 0 : 132)
        .allowsHitTesting(stage == 0 && interactiveStage == 0).accessibilityHidden(
          stage != 0 || interactiveStage != 0)
        panel(credentials: false, maxHeight: max(120, geometry.size.height - keyboardInset - 100))
          .offset(x: stage == 0 ? offstage : stage == 1 ? 0 : -offstage, y: -keyboardInset)
          .allowsHitTesting(stage == 1 && interactiveStage == 1).accessibilityElement(
            children: .contain
          )
          .accessibilityHidden(stage != 1 || interactiveStage != 1)
        panel(credentials: true, maxHeight: max(120, geometry.size.height - keyboardInset - 100))
          .offset(x: stage == 2 ? 0 : offstage, y: -keyboardInset)
          .allowsHitTesting(stage == 2 && interactiveStage == 2).accessibilityElement(
            children: .contain
          )
          .accessibilityHidden(stage != 2 || interactiveStage != 2)
      }
      .frame(width: geometry.size.width, height: geometry.size.height)
      .clipped()
      .animation(
        reduceMotion
          ? nil
          : .timingCurve(0.33, 1, 0.68, 1, duration: stage == 0 ? 0.32 : stage == 1 ? 0.42 : 0.34),
        value: stage)
    }
    .background { Color(hex: dark ? "101010" : "F5F5F3").ignoresSafeArea() }
    .ignoresSafeArea(.keyboard)
    .onReceive(
      NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)
    ) { notification in
      guard let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect
      else { return }
      let duration =
        notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
      withAnimation(reduceMotion ? nil : .easeOut(duration: duration)) { keyboardTop = frame.minY }
    }
    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification))
    { _ in
      withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) { keyboardTop = nil }
    }
    .onChange(of: store.authPath) { before, after in
      field = nil
      if after.count < before.count {
        request?.cancel()
        store.cancelAuthentication()
        password = ""
        showingPassword = false
      }
    }
    .task(id: stage) {
      // A sliding panel's final accessibility frame is ahead of its on-screen position.
      // Activate it after arrival so rapid taps/VoiceOver cannot target a moving field.
      let arrivingStage = stage
      interactiveStage = nil
      try? await Task.sleep(for: .milliseconds(reduceMotion ? 0 : arrivingStage == 1 ? 430 : 350))
      guard !Task.isCancelled else { return }
      interactiveStage = arrivingStage
      if arrivingStage == 2 { field = .username }
    }
    .onChange(of: store.server) { _, _ in
      username = ""
      password = ""
      store.authError = nil
    }
    .onChange(of: username) { _, _ in store.authError = nil }
    .onChange(of: password) { _, _ in store.authError = nil }
    .onChange(of: store.authError) { _, value in
      guard let value else { return }
      UIAccessibility.post(notification: .announcement, argument: value)
    }
    .onDisappear {
      request?.cancel()
      password = ""
    }
  }

  private var hero: some View {
    VStack(spacing: 13) {
      Text("OpenTeam").font(.system(size: 34, weight: .semibold)).tracking(-0.8)
        .accessibilityAddTraits(.isHeader)
      Text("Your team of always-on Bots\nthat finish the work")
        .font(.system(size: 16)).lineSpacing(2).foregroundStyle(secondary).multilineTextAlignment(
          .center)
    }
    .padding(.horizontal, 28).padding(.vertical, 20)
    .frame(minWidth: 292)
    .modifier(AuthGlass(radius: 28))
    .shadow(color: (dark ? Color.black : Color(hex: "74746D")).opacity(0.12), radius: 24, y: 10)
  }

  private func panel(credentials: Bool, maxHeight: CGFloat) -> some View {
    VStack(spacing: 10) {
      ScrollView {
        VStack(alignment: .leading, spacing: 10) {
          if credentials { credentialFields } else { endpointFields }
          if stage == (credentials ? 2 : 1) {
            errorNotice
            if cleartext {
              Text(
                credentials
                  ? "Your password will be sent without HTTPS protection."
                  : "HTTP is not encrypted. Only connect through a network or VPN you trust."
              )
              .font(.footnote).foregroundStyle(secondary).padding(.horizontal, 4)
              .fixedSize(horizontal: false, vertical: true)
            }
          }
        }.padding(16)
          .onGeometryChange(for: CGFloat.self) {
            $0.size.height
          } action: { height in
            // Size the viewport, rather than fixing the scroll view to its content height.
            // The latter overflows the card when Dynamic Type or the keyboard reduces space.
            if credentials { credentialsHeight = height } else { endpointHeight = height }
          }
      }
      .scrollBounceBehavior(.basedOnSize).scrollDismissesKeyboard(.never)
      .frame(height: min(credentials ? credentialsHeight : endpointHeight, maxHeight))
      .clipShape(RoundedRectangle(cornerRadius: 30))
      .modifier(AuthGlass(radius: 30))
      .shadow(color: (dark ? Color.black : Color(hex: "74746D")).opacity(0.14), radius: 26, y: 12)
      HStack(spacing: 10) {
        authButton(
          store.connecting ? "Cancel" : "Back",
          identifier: credentials ? "auth-back-credentials" : "auth-back-endpoint", primary: false,
          expand: false
        ) {
          field = nil
          if store.connecting { cancel() } else { store.authPath = credentials ? [.endpoint] : [] }
        }
        .accessibilityLabel(
          store.connecting ? (credentials ? "Cancel sign-in" : "Cancel connection") : "Back")
        authButton(
          store.connecting
            ? (credentials ? "Signing in…" : "Connecting…") : (credentials ? "Sign in" : "Connect"),
          identifier: credentials ? "sign-in-button" : "connect-button",
          disabled: store.connecting
            || (credentials
              ? username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty
              : store.server.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty),
          busy: store.connecting
        ) { if credentials { submitCredentials() } else { submitServer() } }
      }
    }
    .padding(.horizontal, 18).padding(.bottom, 12)
    .frame(maxHeight: .infinity, alignment: .bottom)
  }

  private var endpointFields: some View {
    @Bindable var store = store
    return VStack(alignment: .leading, spacing: 6) {
      VStack(alignment: .leading, spacing: 3) {
        Text("Connect to your server").font(.system(size: headingSize, weight: .semibold)).tracking(
          -0.35
        )
        .accessibilityAddTraits(.isHeader)
        Text("Use the server address from your OpenTeam setup.").font(.caption).foregroundStyle(
          secondary)
      }.padding(.horizontal, 4).padding(.bottom, 2)
      fieldLabel("SERVER ADDRESS")
      HStack {
        TextField(
          "https://openteam.example.com", text: $store.server,
          prompt: Text("https://openteam.example.com").foregroundStyle(placeholder)
        )
        .keyboardType(.URL).textContentType(.URL).textInputAutocapitalization(.never)
        .autocorrectionDisabled().focused($field, equals: .server).submitLabel(.go)
        .disabled(store.connecting).accessibilityLabel("Server address")
        .accessibilityIdentifier("server-field").onSubmit { submitServer() }
        if !store.server.isEmpty, !store.connecting {
          Button {
            store.server = ""
            field = .server
          } label: {
            Image(systemName: "xmark.circle.fill").foregroundStyle(secondary)
          }.buttonStyle(.plain).accessibilityLabel("Clear server address").accessibilityIdentifier(
            "clear-server")
        }
      }.modifier(AuthField())
    }
  }

  private var credentialFields: some View {
    VStack(alignment: .leading, spacing: 10) {
      fieldLabel("ACCOUNT")
      VStack(alignment: .leading, spacing: 3) {
        Text("Sign in").font(.system(size: headingSize, weight: .semibold)).tracking(-0.35)
          .accessibilityAddTraits(.isHeader)
        Text(store.server).font(.caption).foregroundStyle(secondary).lineLimit(1)
      }.padding(.horizontal, 4).padding(.bottom, 2)
      TextField("Username", text: $username, prompt: Text("Username").foregroundStyle(placeholder))
        .textContentType(.username)
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .focused($field, equals: .username).submitLabel(.next).onSubmit { field = .password }
        .accessibilityIdentifier("username-field").modifier(AuthField())
      HStack {
        Group {
          if showingPassword {
            TextField(
              "Password", text: $password, prompt: Text("Password").foregroundStyle(placeholder))
          } else {
            SecureField(
              "Password", text: $password, prompt: Text("Password").foregroundStyle(placeholder))
          }
        }.textContentType(.password).textInputAutocapitalization(.never).autocorrectionDisabled()
          .focused($field, equals: .password).submitLabel(.go).onSubmit { submitCredentials() }
          .accessibilityIdentifier("password-field")
        Button {
          showingPassword.toggle()
        } label: {
          Image(systemName: showingPassword ? "eye.slash" : "eye")
        }.buttonStyle(.plain).foregroundStyle(secondary)
          .accessibilityLabel(showingPassword ? "Hide password" : "Show password")
      }.modifier(AuthField())
    }.disabled(store.connecting)
  }
  private func fieldLabel(_ title: String) -> some View {
    Text(title).font(.caption2.bold()).tracking(0.8)
      .foregroundStyle((dark ? Color.white : Color(hex: "111111")).opacity(dark ? 0.78 : 0.72))
      .padding(.horizontal, 4)
  }
  @ViewBuilder private var errorNotice: some View {
    if let error = store.authError {
      Text(error).font(.footnote).foregroundStyle(Color(hex: dark ? "FF8A8F" : "B32328"))
        .fixedSize(horizontal: false, vertical: true).padding(.horizontal, 4)
        .accessibilityIdentifier("inline-error")
    }
  }
  private func authButton(
    _ title: String, identifier: String = "", primary: Bool = true, expand: Bool = true,
    disabled: Bool = false, busy: Bool = false, action: @escaping () -> Void
  ) -> some View {
    let foreground = primary ? (dark ? Color(hex: "111111") : .white) : NativePalette.text
    return Button(action: action) {
      HStack(spacing: 9) {
        if busy { ProgressView().tint(foreground) }
        Text(title).font(.body.weight(primary ? .semibold : .medium)).multilineTextAlignment(
          .center)
      }
      .foregroundStyle(disabled && !busy ? secondary : foreground)
      .padding(.horizontal, primary ? 22 : 18).padding(.vertical, 12)
      .frame(minWidth: primary ? 0 : 94, maxWidth: expand ? .infinity : nil, minHeight: 58)
      .modifier(AuthGlass(radius: 29, kind: primary ? .primary(disabled: disabled) : .secondary))
      .contentShape(Capsule())
    }
    .buttonStyle(.plain).disabled(disabled).accessibilityIdentifier(identifier)
  }
  private func submitServer() {
    guard !store.connecting else { return }
    field = nil
    request = Task { await store.checkServer(feedback: true) }
  }
  private func submitCredentials() {
    guard !store.connecting, !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      !password.isEmpty
    else { return }
    field = nil
    request = Task { await store.connect(username: username, password: password, feedback: true) }
  }
  private func cancel() {
    request?.cancel()
    store.cancelAuthentication()
  }
}

private struct AuthField: ViewModifier {
  @Environment(\.colorScheme) private var scheme
  func body(content: Content) -> some View {
    content.font(.callout).padding(.horizontal, 16).padding(.vertical, 12).frame(minHeight: 52)
      .background(
        scheme == .dark ? .black.opacity(0.28) : .white.opacity(0.56),
        in: RoundedRectangle(cornerRadius: 16)
      )
      .overlay {
        RoundedRectangle(cornerRadius: 16).strokeBorder(
          scheme == .dark ? .white.opacity(0.14) : Color(hex: "111111").opacity(0.12),
          lineWidth: 0.5
        )
        .allowsHitTesting(false)
      }
  }
}

/// AuthGate has its own RN glass tints; chat chrome intentionally uses a different material.
private struct AuthGlass: ViewModifier {
  enum Kind {
    case card
    case primary(disabled: Bool)
    case secondary
  }
  @Environment(\.colorScheme) private var scheme
  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
  var radius: CGFloat
  var kind: Kind = .card
  private var dark: Bool { scheme == .dark }
  private var interactive: Bool {
    switch kind {
    case .card, .primary(disabled: true): return false
    default: return true
    }
  }
  private var tint: Color {
    switch kind {
    case .card: return dark ? Color(hex: "262624").opacity(0.46) : .white.opacity(0.24)
    case .primary(let disabled):
      return dark
        ? .white.opacity(disabled ? 0.30 : 0.82)
        : Color(hex: "111111").opacity(disabled ? 0.32 : 0.78)
    case .secondary: return dark ? Color(hex: "3A3A3A").opacity(0.58) : .white.opacity(0.42)
    }
  }
  private var border: Color {
    if case .primary(disabled: false) = kind { return .white.opacity(dark ? 0.6 : 0.24) }
    return dark ? .white.opacity(0.14) : Color(hex: "111111").opacity(0.12)
  }
  private var fallback: Color {
    switch kind {
    case .card: return dark ? Color(hex: "232323") : .white
    case .primary(let disabled):
      return disabled
        ? (dark ? Color(hex: "555555") : Color(hex: "AAAAAA"))
        : dark ? .white : Color(hex: "111111")
    case .secondary: return Color(hex: dark ? "343434" : "E2E2DF")
    }
  }
  func body(content: Content) -> some View {
    let shape = RoundedRectangle(cornerRadius: radius)
    Group {
      if #available(iOS 26, *), !reduceTransparency {
        content.glassEffect(
          interactive ? Glass.regular.tint(tint).interactive() : Glass.regular.tint(tint), in: shape
        )
      } else {
        content.background(fallback, in: shape)
      }
    }.overlay {
      shape.strokeBorder(border, lineWidth: 0.5)
        .allowsHitTesting(false)
    }
  }
}

struct InlineFailure: View {
  let message: String
  var retry: (() -> Void)? = nil
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Label {
        Text(message).fixedSize(horizontal: false, vertical: true)
      } icon: {
        Image(systemName: "exclamationmark.circle.fill")
      }.foregroundStyle(NativePalette.destructive).accessibilityIdentifier("inline-error")
      if let retry { Button("Try again", action: retry).accessibilityIdentifier("retry-error") }
    }.font(.subheadline)
  }
}
