import SwiftUI

struct SignInView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.dynamicTypeSize) private var typeSize
  @State private var username = ""
  @State private var password = ""
  @State private var showingPassword = false
  @State private var request: Task<Void, Never>?
  @FocusState private var field: Field?
  private enum Field { case server, username, password }

  var body: some View {
    @Bindable var store = store
    NavigationStack(path: $store.authPath) {
      welcome.navigationDestination(for: AppStore.AuthStep.self) { step in
        if step == .endpoint { endpoint } else { credentials }
      }
    }
    .onChange(of: store.authPath) { before, after in
      if after.count < before.count {
        request?.cancel()
        store.cancelAuthentication()
        password = ""
        showingPassword = false
      }
    }
    .onChange(of: store.server) { _, _ in
      username = ""
      password = ""
      store.authError = nil
    }
    .onChange(of: store.authError) { _, value in
      guard let value else { return }
      UIAccessibility.post(notification: .announcement, argument: value)
    }
    .onDisappear {
      request?.cancel()
      password = ""
    }
  }

  private var welcome: some View {
    ScrollView {
      VStack(spacing: 28) {
        ZStack {
          Circle().fill(NativePalette.selection).frame(width: 230, height: 230)
          BotGlyph(color: Color(hex: "4B8EFB"), kind: "tv-head", size: 94, mode: .idle)
            .rotationEffect(.degrees(-12)).offset(x: -94, y: -62)
          BotGlyph(color: Color(hex: "10B972"), kind: "chip", size: 140, mode: .idle)
          BotGlyph(color: Color(hex: "FF7A1A"), kind: "classic", size: 90, mode: .idle)
            .rotationEffect(.degrees(10)).offset(x: 95, y: 55)
        }.frame(height: 285).padding(.top, 25).accessibilityHidden(true)
        VStack(spacing: 12) {
          Text("Your team.\nIn your pocket.").font(
            .system(.largeTitle, design: .rounded, weight: .bold)
          )
          .multilineTextAlignment(.center).accessibilityAddTraits(.isHeader)
          Text("Pick up where you left off with your bots, conversations and tools.")
            .font(.body).foregroundStyle(NativePalette.muted).multilineTextAlignment(.center)
        }
        if let message = store.authError { InlineFailure(message: message) }
        Button {
          store.authError = nil
          NativeHaptics.play(.light, source: "auth.get-started")
          store.authPath = [.endpoint]
        } label: {
          Text("Get started").fontWeight(.semibold).frame(maxWidth: .infinity).padding(
            .vertical, 10)
        }.buttonStyle(.borderedProminent).tint(NativePalette.text).foregroundStyle(
          NativePalette.onPrimary
        )
        .controlSize(.large).buttonBorderShape(.capsule).accessibilityIdentifier("get-started")
        Text("Connect to the server you set up with OpenTeam.").font(.footnote)
          .foregroundStyle(NativePalette.muted).multilineTextAlignment(.center)
      }.padding(.horizontal, 28).padding(.bottom, 32).frame(maxWidth: 520)
        .frame(maxWidth: .infinity)
    }.background(NativePalette.background).navigationTitle("OpenTeam")
      .navigationBarTitleDisplayMode(.inline)
  }

  private var endpoint: some View {
    @Bindable var store = store
    return NativeForm {
      Section {
        Label("Connect to your server", systemImage: "server.rack").font(.title2.bold())
          .padding(.vertical, 6).accessibilityAddTraits(.isHeader)
        Text("Use the address from OpenTeam setup on your computer.").foregroundStyle(
          NativePalette.muted)
      }.listRowBackground(Color.clear).listRowSeparator(.hidden)
      Section {
        HStack {
          TextField("https://openteam.example.com", text: $store.server)
            .keyboardType(.URL).textContentType(.URL).textInputAutocapitalization(.never)
            .autocorrectionDisabled().focused($field, equals: .server).submitLabel(.go)
            .disabled(store.connecting).accessibilityLabel("Server address")
            .accessibilityIdentifier("server-field").onSubmit { submitServer() }
          if !store.server.isEmpty, !store.connecting {
            Button {
              store.server = ""
              field = .server
            } label: {
              Image(systemName: "xmark.circle.fill").foregroundStyle(NativePalette.faint)
            }
            .buttonStyle(.borderless).accessibilityLabel("Clear server address")
            .accessibilityIdentifier("clear-server")
          }
        }
      } header: {
        Text("Server address")
      } footer: {
        if store.server.lowercased().hasPrefix("http://") {
          Text(
            "This address uses an unencrypted connection. Use HTTPS when connecting over the internet."
          )
        } else {
          Text("OpenTeam checks the connection before asking you to sign in.")
        }
      }
      if let message = store.authError { Section { InlineFailure(message: message) } }
      Section {
        Button {
          submitServer()
        } label: {
          submitLabel(store.connecting ? "Connecting…" : "Continue")
        }.disabled(
          store.connecting || store.server.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        )
        .accessibilityIdentifier("connect-button")
        if store.connecting { Button("Cancel connection", role: .cancel) { cancel() } }
      }
    }.navigationTitle("Server").navigationBarTitleDisplayMode(.inline)
      .scrollDismissesKeyboard(.interactively)
  }

  private var credentials: some View {
    NativeForm {
      Section {
        let headerLayout =
          typeSize.isAccessibilitySize
          ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
          : AnyLayout(HStackLayout(spacing: 16))
        headerLayout {
          BotGlyph(color: Color(hex: "10B972"), kind: "chip", size: 54, mode: .idle)
          VStack(alignment: .leading, spacing: 4) {
            Text("Welcome back").font(.title2.bold()).accessibilityAddTraits(.isHeader)
            Text("Sign in to your OpenTeam account.").foregroundStyle(NativePalette.muted)
          }
        }.padding(.vertical, 8)
      }.listRowBackground(Color.clear)
      Section {
        LabeledContent("Server", value: URL(string: store.server)?.host ?? store.server)
        TextField("Username", text: $username).textContentType(.username)
          .textInputAutocapitalization(.never).autocorrectionDisabled()
          .focused($field, equals: .username).submitLabel(.next)
          .onSubmit { field = .password }.accessibilityIdentifier("username-field")
        HStack {
          Group {
            if showingPassword {
              TextField("Password", text: $password)
            } else {
              SecureField("Password", text: $password)
            }
          }.textContentType(.password).textInputAutocapitalization(.never).autocorrectionDisabled()
            .focused($field, equals: .password).submitLabel(.go).onSubmit { submitCredentials() }
            .accessibilityIdentifier("password-field")
          Button {
            showingPassword.toggle()
          } label: {
            Image(systemName: showingPassword ? "eye.slash" : "eye")
          }.buttonStyle(.borderless).foregroundStyle(NativePalette.muted)
            .accessibilityLabel(showingPassword ? "Hide password" : "Show password")
        }
      }.disabled(store.connecting)
      if let message = store.authError { Section { InlineFailure(message: message) } }
      Section {
        Button {
          submitCredentials()
        } label: {
          submitLabel(store.connecting ? "Signing in…" : "Sign in")
        }
        .disabled(
          store.connecting || username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || password.isEmpty
        )
        .accessibilityIdentifier("sign-in-button")
        if store.connecting { Button("Cancel sign-in", role: .cancel) { cancel() } }
      } footer: {
        Text(
          "Use the username and password from your server setup. If you need access, contact your server administrator."
        )
      }
    }.navigationTitle("Sign in").navigationBarTitleDisplayMode(.inline)
      .scrollDismissesKeyboard(.interactively)
      .onChange(of: username) { _, _ in store.authError = nil }
      .onChange(of: password) { _, _ in store.authError = nil }
  }
  private func submitLabel(_ title: String) -> some View {
    HStack {
      Spacer()
      if store.connecting { ProgressView() }
      Text(title).fontWeight(.semibold)
      Spacer()
    }.padding(.vertical, 5)
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
