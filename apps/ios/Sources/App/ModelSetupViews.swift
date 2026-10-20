import SwiftUI
import WebKit

/// Shows whatever the provider sign-in needs next: a code, a browser, or a key.
struct ModelSignInProgress: View {
  @Environment(\.openURL) private var openURL
  let setup: ModelSetup
  @State private var value = ""
  @State private var copied = false
  @FocusState private var focused: Bool
  var body: some View {
    if let session = setup.session {
      let prompt = session.prompt
      let finished = session.finished
      let capture = session.capturableRedirect != nil
      VStack(alignment: .leading, spacing: 12) {
        status(session)
        if !finished, capture, let url = session.authorizationUrl.flatMap(URL.init(string:)) {
          // The in-app browser finishes on its own; Safari needs the address pasted back.
          Button("Open sign-in page") { setup.openWebSignIn() }
            .buttonStyle(ModelCapsuleButtonStyle(primary: true))
            .accessibilityIdentifier("model-open-web-sign-in")
          Button("Open in Safari instead") { openURL(url) }
            .buttonStyle(.borderless).font(.subheadline.weight(.medium))
            .foregroundStyle(NativePalette.link)
            .accessibilityIdentifier("model-open-safari")
          Text(
            "If you sign in in Safari, the last page won't load. Copy its address and paste it here."
          ).font(.footnote).foregroundStyle(NativePalette.muted)
            .fixedSize(horizontal: false, vertical: true)
        } else if !finished, session.deviceCode == nil,
          let url = session.authorizationUrl.flatMap(URL.init(string:))
        {
          Button {
            openURL(url)
          } label: {
            Label("Open sign-in page", systemImage: "arrow.up.right.square")
          }.buttonStyle(.borderless).foregroundStyle(NativePalette.link)
            .accessibilityIdentifier("model-open-sign-in")
        }
        let asking = !finished && prompt != nil && session.automaticAnswer == nil
        if asking, let prompt { promptField(prompt) }
        HStack(spacing: 10) {
          if asking, let prompt { continueButton(prompt) }
          if !finished {
            Button("Cancel") { setup.cancelSignIn() }
              .buttonStyle(ModelCapsuleButtonStyle())
              .accessibilityIdentifier("model-sign-in-cancel")
          } else if session.status != "connected" {
            Button("Try again") {
              let method = session.authType
              setup.clearSignIn()
              Task { await setup.connect(method) }
            }.buttonStyle(ModelCapsuleButtonStyle())
              .accessibilityIdentifier("model-sign-in-retry")
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("model-sign-in")
      .onChange(of: prompt?.id) { _, _ in value = "" }
    }
  }

  @ViewBuilder private func status(_ session: InferenceAuthSession) -> some View {
    if session.status == "connected" {
      Label("Connected", systemImage: "checkmark.circle.fill")
        .foregroundStyle(Color(uiColor: .systemGreen)).font(.subheadline.weight(.medium))
        .accessibilityIdentifier("model-sign-in-status")
    } else if session.status == "failed" {
      InlineFailure(message: session.error ?? "The sign-in didn't finish. Try again.")
        .accessibilityIdentifier("model-sign-in-status")
    } else if session.status == "cancelled" {
      Text("The sign-in was cancelled.").font(.subheadline).foregroundStyle(NativePalette.muted)
        .accessibilityIdentifier("model-sign-in-status")
    } else if let code = session.deviceCode {
      VStack(alignment: .leading, spacing: 10) {
        Text("Open the sign-in page and enter this code:")
          .font(.subheadline).foregroundStyle(NativePalette.muted)
        Text(code.userCode).font(.system(size: 28, weight: .semibold, design: .monospaced))
          .tracking(2).textSelection(.enabled)
          .padding(.horizontal, 14).padding(.vertical, 8)
          .background(NativePalette.code, in: RoundedRectangle(cornerRadius: 12))
          .accessibilityLabel("Sign-in code \(code.userCode)")
          .accessibilityIdentifier("model-device-code")
        HStack(spacing: 10) {
          Button(copied ? "Copied" : "Copy code") {
            UIPasteboard.general.string = code.userCode
            NativeHaptics.play(.light, source: "model.copy-code")
            copied = true
          }.buttonStyle(ModelCapsuleButtonStyle())
            .accessibilityIdentifier("model-copy-code")
          if let url = URL(string: code.verificationUri) {
            Button("Open sign-in page") { openURL(url) }
              .buttonStyle(ModelCapsuleButtonStyle(primary: true))
              .accessibilityIdentifier("model-open-sign-in")
          }
        }
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text("Waiting for you to finish signing in…")
        }.font(.footnote).foregroundStyle(NativePalette.muted)
      }.task(id: code.userCode) { copied = false }
    } else if session.capturableRedirect != nil {
      Text("Sign in on the provider's page. OpenTeam finishes the connection for you.")
        .font(.subheadline).foregroundStyle(NativePalette.muted)
        .fixedSize(horizontal: false, vertical: true)
    } else if session.prompt == nil || session.automaticAnswer != nil {
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text(session.prompt == nil && session.status == "running" && setup.busy != .respond
          && session.authType == "api_key" ? "Checking the key…" : "Starting sign-in…")
      }.font(.subheadline).foregroundStyle(NativePalette.muted)
        .accessibilityIdentifier("model-sign-in-status")
    }
  }

  @ViewBuilder private func promptField(_ prompt: InferenceAuthPrompt) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      if prompt.type != "manual_code", !prompt.message.isEmpty {
        Text(prompt.message).font(.footnote).foregroundStyle(NativePalette.muted)
          .fixedSize(horizontal: false, vertical: true)
      }
      if prompt.type == "select" {
        Picker(prompt.message.isEmpty ? "Choose" : prompt.message, selection: $value) {
          Text("Choose…").tag("")
          ForEach(prompt.options ?? []) { option in Text(option.label).tag(option.id) }
        }.pickerStyle(.menu).accessibilityIdentifier("model-prompt-field")
      } else {
        Group {
          if prompt.type == "secret" {
            SecureField("Paste your API key", text: $value)
          } else {
            TextField(
              prompt.type == "manual_code"
                ? "Paste the address from your browser"
                : (prompt.placeholder ?? prompt.message), text: $value)
          }
        }
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .keyboardType(prompt.type == "manual_code" ? .URL : .default)
        .submitLabel(.continue).focused($focused)
        .onSubmit { submit(prompt) }
        .padding(.horizontal, 12).frame(minHeight: 44)
        .background(NativePalette.background, in: RoundedRectangle(cornerRadius: 12))
        .overlay {
          RoundedRectangle(cornerRadius: 12).strokeBorder(NativePalette.separator, lineWidth: 1)
        }
        .accessibilityLabel(
          prompt.type == "secret"
            ? "API key"
            : prompt.type == "manual_code" ? "Address from your browser" : prompt.message)
        .accessibilityIdentifier("model-prompt-field")
      }
    }
  }

  private func continueButton(_ prompt: InferenceAuthPrompt) -> some View {
    let busy = setup.busy == .respond
    return Button {
      submit(prompt)
    } label: {
      HStack(spacing: 6) {
        if busy { ProgressView().controlSize(.small).tint(NativePalette.onPrimary) }
        Text("Continue")
      }
    }.buttonStyle(ModelCapsuleButtonStyle(primary: true))
      .disabled(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
      .accessibilityIdentifier("model-prompt-continue")
  }

  private func submit(_ prompt: InferenceAuthPrompt) {
    let answer = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !answer.isEmpty, setup.busy != .respond else { return }
    focused = false
    Task { await setup.respond(prompt.id, answer) }
  }
}

/// "Testing the model…", "Working · replied in 1.2 s", or the error.
struct ModelTestStatusView: View {
  let test: ModelTestState
  var body: some View {
    switch test {
    case .idle: EmptyView()
    case .running:
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text(test.text ?? "")
      }.font(.subheadline).foregroundStyle(NativePalette.muted)
        .accessibilityElement(children: .combine).accessibilityIdentifier("model-test-status")
    case .passed:
      Label {
        Text(test.text ?? "")
      } icon: {
        Image(systemName: "checkmark.circle.fill").foregroundStyle(Color(uiColor: .systemGreen))
      }.font(.subheadline).foregroundStyle(NativePalette.text)
        .accessibilityIdentifier("model-test-status")
    case .failed(let error):
      Label {
        Text(error).fixedSize(horizontal: false, vertical: true)
      } icon: {
        Image(systemName: "exclamationmark.circle.fill")
      }.font(.subheadline).foregroundStyle(NativePalette.destructive)
        .accessibilityIdentifier("model-test-status")
    }
  }
}

/// The app's small grey settings section title.
struct SettingsHeader: View {
  let text: String
  init(_ text: String) { self.text = text }
  var body: some View {
    Text(text).font(.system(size: 13)).foregroundStyle(NativePalette.faint)
  }
}

/// The muted explanation under a settings section.
struct SettingsFooter: View {
  let text: String
  init(_ text: String) { self.text = text }
  var body: some View {
    Text(text).font(.footnote).foregroundStyle(NativePalette.muted)
      .fixedSize(horizontal: false, vertical: true)
  }
}

/// Small rounded buttons that work inside list rows without selecting the row.
struct ModelCapsuleButtonStyle: ButtonStyle {
  var primary = false
  @Environment(\.isEnabled) private var enabled
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(.subheadline.weight(.medium))
      .foregroundStyle(primary ? NativePalette.onPrimary : NativePalette.text)
      .padding(.horizontal, 14).frame(minHeight: 36)
      .background(
        primary
          ? (enabled ? NativePalette.text : NativePalette.disabledPrimary)
          : NativePalette.code,
        in: Capsule()
      )
      .opacity(configuration.isPressed ? 0.7 : enabled || primary ? 1 : 0.5)
      .contentShape(Capsule())
  }
}

/// A provider's sign-in page in the app. It ends on a localhost address the phone
/// can't open; the app catches that address and hands it to the server instead.
struct ProviderWebSignInSheet: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  let signIn: ModelSetup.WebSignIn
  let onCapture: (URL) -> Void
  @State private var loading = true
  @State private var host = ""
  var body: some View {
    NavigationStack {
      ProviderWebView(
        url: signIn.url, redirect: signIn.redirect, loading: $loading, host: $host,
        onCapture: onCapture
      )
      .ignoresSafeArea(edges: .bottom)
      .overlay { if loading { ProgressView() } }
      .navigationTitle(host.isEmpty ? "Sign in" : host).navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }.accessibilityIdentifier("web-sign-in-cancel")
        }
        ToolbarItem(placement: .primaryAction) {
          Button {
            dismiss()
            openURL(signIn.url)
          } label: {
            Image(systemName: "safari")
          }.accessibilityLabel("Open in Safari instead")
            .accessibilityIdentifier("web-sign-in-safari")
        }
      }
    }
  }
}

private struct ProviderWebView: UIViewRepresentable {
  let url: URL
  let redirect: URL
  @Binding var loading: Bool
  @Binding var host: String
  let onCapture: (URL) -> Void
  func makeCoordinator() -> Coordinator { Coordinator(self) }
  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    // Provider cookies last only for this sign-in.
    configuration.websiteDataStore = .nonPersistent()
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = context.coordinator
    view.uiDelegate = context.coordinator
    view.allowsBackForwardNavigationGestures = true
    view.accessibilityIdentifier = "web-sign-in"
    view.load(URLRequest(url: url))
    return view
  }
  func updateUIView(_ view: WKWebView, context: Context) { context.coordinator.parent = self }

  @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    var parent: ProviderWebView
    private var captured = false
    init(_ parent: ProviderWebView) { self.parent = parent }
    private func capture(_ url: URL?) -> Bool {
      guard let url, ProviderRedirect.matches(url, redirect: parent.redirect) else { return false }
      if !captured {
        captured = true
        parent.onCapture(url)
      }
      return true
    }
    func webView(
      _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
      capture(navigationAction.request.url) ? .cancel : .allow
    }
    func webView(
      _ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!
    ) {
      if capture(webView.url) { webView.stopLoading() }
    }
    func webView(
      _ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!
    ) {
      parent.loading = true
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      parent.loading = false
      parent.host = webView.url?.host ?? ""
    }
    func webView(
      _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
      withError error: Error
    ) {
      parent.loading = false
      let failing = (error as NSError).userInfo[NSURLErrorFailingURLErrorKey] as? URL
      _ = capture(failing)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
      parent.loading = false
    }
    /// Sign-in pages that open a new window continue in this one.
    func webView(
      _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
      for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
      if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
      return nil
    }
  }
}

/// Settings → Model: the provider, its connection, the model and reasoning effort.
struct ModelSettingsView: View {
  @Environment(AppStore.self) private var store
  @State private var setup: ModelSetup?
  var body: some View {
    Group {
      if let setup {
        ModelSettingsForm(setup: setup)
      } else {
        NativeForm { ProgressView("Loading…") }
      }
    }
    .navigationTitle("Model").navigationBarTitleDisplayMode(.inline)
    .task {
      if setup == nil { setup = ModelSetup(store: store) }
      await setup?.start()
    }
  }
}

private struct ModelSettingsForm: View {
  @Environment(AppStore.self) private var store
  @Bindable var setup: ModelSetup
  @State private var confirmingDisconnect = false
  var body: some View {
    let data = setup.data
    let provider = setup.provider
    let busy = setup.busy != nil
    NativeForm {
      Section {
        Picker(
          "Provider",
          selection: Binding(
            get: { setup.providerId },
            set: { id in Task { await setup.selectProvider(id) } })
        ) {
          if setup.providerId.isEmpty { Text("Choose a provider").tag("") }
          ForEach(data?.providers ?? []) { candidate in
            Text(candidate.name).tag(candidate.id)
          }
        }.pickerStyle(.menu).disabled(data == nil || setup.busy == .provider)
          .accessibilityIdentifier("model-provider-picker")
        HStack(spacing: 12) {
          // The chosen provider's official icon, like an account row.
          ProviderMark(kind: ProviderMark.kind(for: setup.providerId), size: 30, style: .icon)
            .id(setup.providerId)
            .transition(.opacity.combined(with: .scale(scale: 0.8)))
          VStack(alignment: .leading, spacing: 2) {
            Text("Connection")
            Text(provider?.connectionSummary ?? "Not connected.").font(.footnote)
              .foregroundStyle(NativePalette.muted)
              .accessibilityIdentifier("model-connection-summary")
          }
          Spacer(minLength: 8)
          if setup.busy == .connect || setup.busy == .provider || setup.busy == .disconnect {
            ProgressView()
          } else if provider?.connected == true {
            Button("Disconnect") { confirmingDisconnect = true }
              .buttonStyle(ModelCapsuleButtonStyle()).disabled(busy || setup.signingIn)
              .accessibilityIdentifier("model-disconnect")
          } else {
            ForEach(provider?.authMethods ?? [], id: \.type) { method in
              Button(method.actionTitle) { Task { await setup.connect(method.type) } }
                .buttonStyle(ModelCapsuleButtonStyle(primary: true))
                .disabled(busy || setup.signingIn)
                .accessibilityIdentifier("model-connect-" + method.type)
            }
          }
        }
      } footer: {
        SettingsFooter("The account your bots use to think. Sign-ins and keys stay on your server.")
      }
      if setup.signingIn {
        Section {
          ModelSignInProgress(setup: setup)
        } header: {
          SettingsHeader("Sign-in")
        }
      }
      Section {
        if let models = data?.models, !models.isEmpty {
          Picker(
            "Model",
            selection: Binding(get: { setup.modelId }, set: { setup.selectModel($0) })
          ) {
            ForEach(models) { model in Text(model.name).tag(model.modelId) }
          }.pickerStyle(.menu).disabled(provider?.connected != true)
            .accessibilityIdentifier("model-model-picker")
        } else {
          LabeledContent("Model") {
            Text("No models available").foregroundStyle(NativePalette.muted)
          }
        }
        Picker(
          "Reasoning effort",
          selection: Binding(get: { setup.effectiveReasoning }, set: { setup.setReasoning($0) })
        ) {
          ForEach(setup.reasoningLevels.isEmpty ? ["off"] : setup.reasoningLevels, id: \.self) {
            Text(ModelSetupCatalog.reasoningLabel($0)).tag($0)
          }
        }.pickerStyle(.menu).disabled(setup.selectedModel?.reasoning != true)
          .accessibilityIdentifier("model-reasoning-picker")
      } footer: {
        SettingsFooter(
          provider?.modelMessage
            ?? (setup.selectedModel?.reasoning == true
              ? "Used for every bot's work and background tasks. Higher effort is slower but more careful."
              : "Used for every bot's work and background tasks."))
      }
      Section {
        Group {
          if setup.test != .idle {
            ModelTestStatusView(test: setup.test)
          } else if let saved = data?.savedModel {
            LabeledContent(
              "In use",
              value: (data?.provider(saved.providerId)?.name ?? saved.providerId) + " · "
                + saved.modelId)
          } else if data != nil {
            Text("No model chosen yet. Bots can't reply until you choose one.")
              .font(.subheadline).foregroundStyle(NativePalette.muted)
          }
        }.accessibilityIdentifier("model-status-line")
        HStack(spacing: 10) {
          Button {
            Task { await setup.runTest() }
          } label: {
            Text("Test").frame(maxWidth: .infinity)
          }.buttonStyle(ModelCapsuleButtonStyle())
            .disabled(
              setup.changed || data?.savedModel == nil || busy || setup.test == .running)
            .accessibilityIdentifier("model-test")
          Button {
            Task { await setup.apply() }
          } label: {
            HStack(spacing: 6) {
              if setup.busy == .save { ProgressView().controlSize(.small).tint(NativePalette.onPrimary) }
              Text("Apply")
            }.frame(maxWidth: .infinity)
          }.buttonStyle(ModelCapsuleButtonStyle(primary: true))
            .disabled(
              !setup.changed || provider?.connected != true || setup.selectedModel == nil || busy)
            .accessibilityIdentifier("model-apply")
        }
      }
      if let error = setup.error {
        Section { InlineFailure(message: error) }
      }
    }
    .disabled(setup.busy == .load)
    .overlay { if setup.busy == .load { ProgressView() } }
    .sheet(item: $setup.webSignIn) { signIn in
      ProviderWebSignInSheet(signIn: signIn) { url in
        Task { await setup.captured(url, for: signIn) }
      }
    }
    .confirmationDialog(
      "Disconnect \(provider?.name ?? "this provider")?", isPresented: $confirmingDisconnect,
      titleVisibility: .visible
    ) {
      Button("Disconnect", role: .destructive) { Task { await setup.disconnect() } }
    } message: {
      Text(
        data?.inference.providerId == provider?.id && data?.savedModel != nil
          ? "Your bots use this provider. They can't reply until you connect a model again."
          : "You can connect it again at any time.")
    }
    .onDisappear { setup.stop() }
  }
}
