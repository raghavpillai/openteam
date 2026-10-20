import SwiftUI

/// The first three wizard screens: welcome (W0), the server address (W1) and the
/// account (W2), as a NavigationStack over `store.authPath`, so steps push and pop
/// like any iOS screen (system back button and edge swipe). Onboarding continues
/// from W3 after sign-in.
struct SignInView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(WizardBackdrop.self) private var backdrop: WizardBackdrop?
  @State private var username = ""
  @State private var password = ""
  @State private var showingPassword = false
  @State private var showingInstall = false
  @State private var copiedInstall = 0
  @State private var stillTrying = false
  @State private var request: Task<Void, Never>?
  /// Mirrored into each page's own focus (see WizardFocusHost).
  @State private var field: Field?
  private enum Field: Hashable { case server, username, password }
  static let installCommand = "curl -fsSL https://openteam.so/install | sh"
  private var cleartext: Bool {
    API.withDefaultScheme(store.server).lowercased().hasPrefix("http://")
  }
  private var credentialsReady: Bool {
    !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !password.isEmpty
  }
  /// The art behind the page on top. The terminal carries from W1 to W2 and lights
  /// the line each screen asks for; W2 shows what's typed, or an example name.
  private var scene: WizardScene {
    switch store.authPath.last {
    case nil: return .welcome
    case .endpoint:
      return .terminal(highlight: .server, server: "http://192.168.1.20:8787", username: "sam")
    case .credentials:
      return .terminal(
        highlight: .username, server: store.validatedServer ?? API.withDefaultScheme(store.server),
        username: username.isEmpty ? "sam" : username)
    }
  }

  var body: some View {
    NavigationStack(path: Binding(get: { store.authPath }, set: { store.authPath = $0 })) {
      welcome
        .navigationDestination(for: AppStore.AuthStep.self) { step in
          switch step {
          case .endpoint: endpoint
          case .credentials: credentials
          }
        }
    }
    .onChange(of: scene, initial: true) { _, scene in
      // Only while signed out: after sign-in, setup takes over the same backdrop.
      guard store.phase == .signedOut else { return }
      backdrop?.show(scene, stage: .server, reduceMotion: reduceMotion)
    }
    .onChange(of: store.authPath) { before, after in
      field = nil
      if after.count < before.count {
        // Going back cancels what the page was doing and forgets the password.
        request?.cancel()
        store.cancelAuthentication()
        password = ""
        showingPassword = false
      }
    }
    .task(id: store.connecting) {
      stillTrying = false
      guard store.connecting else { return }
      try? await Task.sleep(for: .seconds(4))
      guard !Task.isCancelled, store.connecting else { return }
      withAnimation(.smooth) { stillTrying = true }
    }
    .onChange(of: store.server) { _, _ in
      username = ""
      password = ""
      store.clearAuthenticationError()
    }
    // Typing clears an old error; prefilling the username must not hide "session expired".
    .onChange(of: username) { _, _ in if field == .username { store.clearAuthenticationError() } }
    .onChange(of: password) { _, _ in if field == .password { store.clearAuthenticationError() } }
    .onChange(of: store.authError) { _, value in
      guard let value else { return }
      UIAccessibility.post(notification: .announcement, argument: value)
    }
    .onDisappear {
      request?.cancel()
      password = ""
    }
  }

  // MARK: W0

  private var welcome: some View {
    WizardPage(
      stage: .server, active: store.authPath.isEmpty,
      motion: "\(showingInstall)|\(store.authError ?? "")"
    ) {
      WizardHeader(
        title: "Welcome to OpenTeam",
        detail:
          "Let's connect to your server and set up your first bot. It takes about two minutes.",
        large: true)
      if showingInstall {
        WizardGroup(header: "Install the server") {
          HStack(alignment: .center, spacing: 12) {
            Text(Self.installCommand)
              .font(.system(.footnote, design: .monospaced))
              .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
              .frame(maxWidth: .infinity, alignment: .leading)
              .accessibilityIdentifier("install-command")
            Button {
              UIPasteboard.general.string = Self.installCommand
              NativeHaptics.play(.light, source: "auth.copy-install")
              copiedInstall += 1
            } label: {
              Label(
                copiedInstall > 0 ? "Copied" : "Copy",
                systemImage: copiedInstall > 0 ? "checkmark" : "doc.on.doc"
              )
              .contentTransition(.symbolEffect(.replace))
            }
            .buttonStyle(.bordered).controlSize(.small)
            .accessibilityLabel(copiedInstall > 0 ? "Copied" : "Copy install command")
            .accessibilityIdentifier("install-copy")
          }
          .padding(.horizontal, 16).padding(.vertical, 12)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("install-card")
        .transition(.move(edge: .bottom).combined(with: .opacity))
        WizardFootnote("Run this on the computer that will host your bots, then come back here.")
          .transition(.opacity)
      }
      errorNotice
    } actions: {
      WizardPrimaryButton(title: "Get started", identifier: "get-started") {
        store.clearAuthenticationError()
        NativeHaptics.play(.light, source: "auth.get-started")
        store.authPath = [.endpoint]
      }
      WizardLink(
        title: showingInstall ? "I already have a server" : "I still need to install the server",
        identifier: "install-server-hint"
      ) {
        NativeHaptics.play(.selection, source: "auth.install")
        withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .snappy) { showingInstall.toggle() }
      }
    }
  }

  // MARK: W1

  private var endpoint: some View {
    WizardFocusHost(focus: $field, isActive: store.authPath.last == .endpoint) { focus in
      endpointPage(focus)
    }
    .task {
      // Focus once the push has finished, so the keyboard doesn't race the slide.
      try? await Task.sleep(for: .milliseconds(reduceMotion ? 50 : 450))
      guard !Task.isCancelled,
        store.server.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      else { return }
      field = .server
    }
  }

  private func endpointPage(_ focus: FocusState<Field?>.Binding) -> some View {
    WizardPage(
      stage: .server, active: store.authPath.last == .endpoint,
      focusAnchor: field == .server ? "endpoint-card" : nil,
      motion: "\(store.connecting)|\(cleartext)|\(store.authError ?? "")"
    ) {
      WizardHeader(
        title: "Where's your server?",
        detail: "Paste the address your terminal printed at the end of setup.")
      WizardGroup {
        HStack {
          TextField(
            "192.168.1.20:8787",
            text: Binding(get: { store.server }, set: { store.server = $0 }))
          .keyboardType(.URL).textContentType(.URL).textInputAutocapitalization(.never)
          .autocorrectionDisabled().focused(focus, equals: .server).submitLabel(.go)
          .disabled(store.connecting).accessibilityLabel("Server address")
          .accessibilityIdentifier("server-field").onSubmit { submitServer() }
          if !store.server.isEmpty, !store.connecting {
            Button {
              store.server = ""
              field = .server
            } label: {
              Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
            }
            .buttonStyle(.plain).accessibilityLabel("Clear server address")
            .accessibilityIdentifier("clear-server")
          }
        }
        .modifier(WizardFieldStyle())
        if let found = store.foundServer {
          WizardDivider()
          WizardStatusLine(text: ServerAddressText.found(version: found.version), done: true)
            .padding(.horizontal, 16).padding(.vertical, 14)
            .accessibilityIdentifier("server-found")
            .transition(.move(edge: .top).combined(with: .opacity))
        } else if store.connecting, stillTrying {
          WizardDivider()
          WizardStatusLine(
            text:
              "Still trying \(ServerAddressText.authority(store.server))… Make sure the server is on and you're on the same network or VPN.",
            symbol: "antenna.radiowaves.left.and.right"
          )
          .padding(.horizontal, 16).padding(.vertical, 14)
          .accessibilityIdentifier("server-still-trying")
          .transition(.move(edge: .top).combined(with: .opacity))
        }
      }
      .animation(.snappy, value: store.foundServer)
      .animation(.smooth, value: stillTrying)
      .id("endpoint-card")
      errorNotice
      if store.authError == nil {
        WizardFootnote("Lost it? Run `openteam status` on your server.")
          .accessibilityIdentifier("server-hint")
      }
      if cleartext {
        WizardFootnote("HTTP is not encrypted. Only connect through a network or VPN you trust.")
      }
    } actions: {
      WizardPrimaryButton(
        title: store.connecting ? "Connecting…" : "Connect", identifier: "connect-button",
        busy: store.connecting,
        disabled: store.server.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      ) { submitServer() }
      if store.connecting {
        WizardLink(title: "Cancel", identifier: "auth-cancel", label: "Cancel connection") {
          cancel()
        }
      }
    }
  }

  // MARK: W2

  private var credentials: some View {
    WizardFocusHost(focus: $field, isActive: store.authPath.last == .credentials) { focus in
      credentialsPage(focus)
    }
    .task {
      try? await Task.sleep(for: .milliseconds(reduceMotion ? 50 : 450))
      guard !Task.isCancelled else { return }
      if username.isEmpty {
        username = store.lastUsername(for: store.validatedServer ?? store.server)
      }
      field = username.isEmpty ? .username : .password
    }
  }

  private func credentialsPage(_ focus: FocusState<Field?>.Binding) -> some View {
    WizardPage(
      stage: .server, active: store.authPath.last == .credentials,
      focusAnchor: field == nil ? nil : "credentials-card",
      motion: "\(store.connecting)|\(store.authError ?? "")"
    ) {
      WizardHeader(
        title: "Sign in to your server",
        detail: "Use the account you created in the terminal.")
      serverChip
      WizardGroup {
        TextField("Username", text: $username)
          .textContentType(.username)
          .textInputAutocapitalization(.never).autocorrectionDisabled()
          .focused(focus, equals: .username).submitLabel(.next).onSubmit { field = .password }
          .accessibilityIdentifier("username-field").modifier(WizardFieldStyle())
        WizardDivider()
        HStack {
          Group {
            if showingPassword {
              TextField("Password", text: $password)
            } else {
              SecureField("Password", text: $password)
            }
          }
          .textContentType(.password).textInputAutocapitalization(.never).autocorrectionDisabled()
          .focused(focus, equals: .password).submitLabel(.go).onSubmit { submitCredentials() }
          .accessibilityIdentifier("password-field")
          Button {
            showingPassword.toggle()
          } label: {
            Image(systemName: showingPassword ? "eye.slash" : "eye")
              .contentTransition(.symbolEffect(.replace))
          }
          .buttonStyle(.plain).foregroundStyle(.secondary)
          .accessibilityLabel(showingPassword ? "Hide password" : "Show password")
        }
        .modifier(WizardFieldStyle())
      }
      .disabled(store.connecting)
      .id("credentials-card")
      errorNotice
      // Word joiners keep "--password" from breaking across lines.
      WizardFootnote("Forgot it? Run `openteam account update -\u{2060}-\u{2060}password` on your server.")
        .accessibilityIdentifier("sign-in-footnote")
      if cleartext {
        WizardFootnote("Your password will be sent without HTTPS protection.")
      }
    } actions: {
      WizardPrimaryButton(
        title: store.connecting ? "Signing in…" : "Sign in", identifier: "sign-in-button",
        busy: store.connecting, disabled: !credentialsReady
      ) { submitCredentials() }
      if store.connecting {
        WizardLink(title: "Cancel", identifier: "auth-cancel", label: "Cancel sign-in") {
          cancel()
        }
      }
    }
  }

  /// The server being signed in to, as a small chip: long names truncate in the
  /// middle, and VoiceOver reads the full address.
  private var serverChip: some View {
    let address = store.validatedServer ?? API.withDefaultScheme(store.server)
    return HStack(spacing: 6) {
      Image(systemName: "server.rack").font(.caption.weight(.semibold))
        .foregroundStyle(WizardStage.server.accent)
      Text(ServerAddressText.authority(address))
        .font(.system(.footnote, design: .monospaced))
        .lineLimit(1).truncationMode(.middle)
    }
    .foregroundStyle(.secondary)
    .padding(.horizontal, 10).padding(.vertical, 6)
    .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
    .padding(.top, -6)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Server \(address)")
    .accessibilityIdentifier("sign-in-server")
  }

  @ViewBuilder private var errorNotice: some View {
    if let error = store.authError {
      WizardError(message: error, identifier: "inline-error", haptic: false)
    }
  }

  private func submitServer() {
    guard !store.connecting,
      !store.server.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return }
    field = nil
    request = Task { await store.checkServer(feedback: true) }
  }
  private func submitCredentials() {
    guard !store.connecting, credentialsReady else { return }
    field = nil
    request = Task { await store.connect(username: username, password: password, feedback: true) }
  }
  private func cancel() {
    request?.cancel()
    store.cancelAuthentication()
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
