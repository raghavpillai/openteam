import SwiftUI

/// Shared by the installed-plugin page and account configuration page.
struct PluginConnectionActions: View {
  @Environment(AppStore.self) private var store
  @Environment(\.openURL) private var openURL
  @Environment(\.scenePhase) private var scenePhase
  @Binding var connection: JSON
  var startAutomatically = false
  var beforeSignIn: (() async -> Bool)?
  @State private var operation = FormOperation()
  @State private var autoStarted = false
  @State private var now = Date()
  @State private var callbackURL = ""
  @State private var showingManualInstructions = false
  @State private var openedAuthorizationState: String?
  @State private var recovery = PluginConnectionRecovery()
  private var path: String { "/api/v0/plugin-connections/" + API.segment(connection["id"].string) }
  private var session: PluginAuthorizationSession? {
    PluginAuthorizationSession(connection, now: now)
  }
  private var requiresDesktop: Bool { MobilePluginAuthorization.requiresDesktop(connection) }
  private var presentation: PluginConnectionPresentation { .init(connection, now: now) }
  private var isGoogle: Bool {
    ["gmail", "google-calendar", "google-drive"].contains(connection["pluginKey"].string)
  }
  private var continueTitle: String { isGoogle ? "Continue to Google" : "Continue to browser" }

  var body: some View {
    FormStatus(operation: operation)
    LabeledContent(
      "Status",
      value: presentation.status
    )
    // A Form lazily realizes rows. Keep the lifecycle on the visible status row:
    // OAuth controls can push an invisible footer offscreen on smaller iPhones.
    .task(id: scenePhase) { await monitorConnection() }
    .sheet(isPresented: $showingManualInstructions) { manualInstructions }
    if connection["status"].string == "error", !connection["statusMessage"].string.isEmpty {
      Text(connection["statusMessage"].string).font(.footnote).foregroundStyle(NativePalette.muted)
    }
    if !presentation.connected, connection["pluginKey"].string == "1password" {
      Text(
        "Open OpenTeam and 1Password on your desktop. Unlock 1Password and approve the access request there. This page will update when the connection is ready."
      )
      .font(.footnote).foregroundStyle(NativePalette.muted)
    }
    if presentation.connected {
      Text(
        "This account is ready to use. Choose which bots can use it under Bot access on the plugin page."
      )
      .font(.footnote).foregroundStyle(NativePalette.muted)
    } else if presentation.connecting {
      ProgressView("Connecting your account…")
    } else if presentation.canReconnect {
      Text("Your sign-in is saved. Reconnect to refresh this plugin’s tools.")
        .font(.footnote).foregroundStyle(NativePalette.muted)
      Button("Reconnect") { Task { await command("/connect") } }.disabled(operation.busy)
    } else if requiresDesktop {
      Text("Sign in on desktop").font(.headline)
      Text(
        "This account uses the desktop sign-in method. To sign in on this iPhone, open Connection settings, expand Sign-in setup, and choose Automatic. Or finish signing in in the OpenTeam desktop app."
      )
      .font(.footnote).foregroundStyle(NativePalette.muted)
    } else if let session {
      if session.expired || connection["oauthCallbackMode"].string != "manual" {
        Text(
          session.expired
            ? "Start again when you’re ready. Your setup is saved."
            : "Approve access in your browser, then return to OpenTeam."
        ).font(.subheadline).foregroundStyle(.secondary)
      }
      if connection["oauthCallbackMode"].string == "manual", !session.expired {
        Text(
          "1. Approve access in your browser.\n2. If Safari says it can’t open the page, that’s expected. Copy the entire address from the address bar (it starts with 127.0.0.1).\n3. Return here and paste the address below."
        )
        .font(.subheadline).foregroundStyle(.secondary)
        SecureField("Paste the browser address here", text: $callbackURL)
          .textInputAutocapitalization(.never).autocorrectionDisabled()
          .accessibilityIdentifier("plugin-manual-callback")
          .onChange(of: session.state) { _, _ in callbackURL = "" }
          .onDisappear { callbackURL = "" }
        Button("Complete sign-in") {
          let value = callbackURL
          callbackURL = ""
          Task {
            await command("/authenticate/manual", body: .object(["callbackUrl": .string(value)]))
          }
        }.disabled(
          operation.busy || callbackURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
      Button(
        session.expired ? "Try again"
          : connection["oauthCallbackMode"].string == "manual"
            && openedAuthorizationState != session.state ? continueTitle : "Reopen sign-in"
      ) {
        Task {
          if session.expired { await signIn() } else { openSignIn(session) }
        }
      }.disabled(operation.busy)
      Button("Cancel sign-in", role: .cancel) {
        Task {
          await command("/authenticate/cancel", body: .object(["state": .string(session.state)]))
        }
      }.disabled(operation.busy)
    } else if presentation.needsSetup, beforeSignIn == nil {
      Text(
        "Open Connection settings to finish the one-time setup. Then you can sign in on this device."
      )
      .font(.footnote).foregroundStyle(NativePalette.muted)
    } else if connection["auth"].string == "oauth" {
      Button(presentation.needsSetup ? "Save and sign in" : "Sign in") { Task { await signIn() } }
        .disabled(operation.busy)
    } else {
      Button("Connect") { Task { await command("/connect") } }.disabled(operation.busy)
    }
    DisclosureGroup("More connection actions") {
      Button("Refresh status") {
        Task { await operation.run(feedback: false) { try await refresh() } }
      }.disabled(operation.busy)
      if presentation.connected || presentation.connecting || connection["status"].string == "error"
      {
        Button("Disconnect", role: .destructive) { Task { await command("/disconnect") } }
          .disabled(operation.busy)
      }
    }
  }
  private var manualInstructions: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          Text("You’ll copy one address back into OpenTeam to finish connecting.")
            .foregroundStyle(.secondary)
          manualStep(1, isGoogle ? "Sign in to Google" : "Sign in in your browser",
            "Choose your account and approve access.")
          manualStep(2, "Copy the final address",
            "Safari may say it can’t open the page. That’s expected. Touch and hold the address bar showing 127.0.0.1, then tap Copy.")
          manualStep(3, "Return to OpenTeam",
            "Paste the entire address into the sign-in field, then tap Complete sign-in.")
        }.padding(24)
      }
      .safeAreaInset(edge: .bottom) {
        Button(continueTitle) {
          showingManualInstructions = false
          Task {
            if let session = PluginAuthorizationSession(connection), !session.expired {
              openedAuthorizationState = session.state
              openURL(session.url)
            } else {
              // A user can leave these instructions open past the OAuth expiry.
              await signIn(manualInstructionsSeen: true)
            }
          }
        }
        .buttonStyle(PrimaryActionStyle())
        .frame(maxWidth: .infinity).padding()
        .accessibilityIdentifier("plugin-continue-to-provider")
      }
      .navigationTitle("Before you sign in").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { showingManualInstructions = false }
        }
      }
    }.presentationDetents([.large])
  }
  private func manualStep(_ number: Int, _ title: String, _ detail: String) -> some View {
    HStack(alignment: .top, spacing: 14) {
      Text("\(number)").font(.headline).frame(width: 32, height: 32)
        .background(.quaternary, in: Circle()).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 6) {
        Text(title).font(.headline)
        Text(detail).foregroundStyle(.secondary)
      }
    }
  }
  private func openSignIn(_ session: PluginAuthorizationSession, manualInstructionsSeen: Bool = false) {
    if connection["oauthCallbackMode"].string == "manual", !manualInstructionsSeen {
      showingManualInstructions = true
    } else {
      openedAuthorizationState = session.state
      openURL(session.url)
    }
  }
  private func monitorConnection() async {
    guard scenePhase == .active else { return }
    if startAutomatically, !autoStarted {
      autoStarted = true
      if connection["auth"].string == "oauth" {
        if !requiresDesktop { await signIn() }
      } else {
        await command("/connect")
      }
    } else {
      try? await refresh()
    }
    while !Task.isCancelled {
      do { try await Task.sleep(for: .seconds(2)) } catch { return }
      now = Date()
      if !operation.busy, recovery.shouldPoll(connection, now: now) {
        // Keep the last known state during a transient poll failure; manual refresh exposes errors.
        try? await refresh()
      }
    }
  }
  private func refresh() async throws {
    let result = try await store.request(
      "/api/v0/plugin-connections/status", query: ["id": connection["id"].string])
    try Task.checkCancellation()
    if let status = result["connections"].array.first(where: { $0["id"] == connection["id"] }) {
      var merged = connection.object
      for (key, value) in status.object { merged[key] = value }
      connection = .object(merged)
      if recovery.observe(connection) { operation.failure = nil }
    }
  }
  private func signIn(manualInstructionsSeen: Bool = false) async {
    guard !operation.busy, !requiresDesktop else { return }
    await operation.run(successEffect: nil) {
      if let beforeSignIn, !(await beforeSignIn()) {
        throw APIError("Save the connection settings before signing in.")
      }
      do {
        let result = try await store.request(
          path + "/authenticate", method: "POST", body: .object(["force": .bool(false)]))
        var merged = connection.object
        merged["status"] = .string("needs_auth")
        for key in ["authorizationUrl", "authorizationExpiresAt"] { merged[key] = result[key] }
        connection = .object(merged)
        try await refresh()
      } catch {
        // A lost acknowledgement may still have created an OAuth session on the server.
        try? await refresh()
        guard let session, !session.expired else { throw error }
      }
      guard let session, !session.expired else {
        throw APIError("The server did not return a current sign-in link. Refresh and try again.")
      }
      openSignIn(session, manualInstructionsSeen: manualInstructionsSeen)
    }
  }
  private func command(_ suffix: String, body: JSON? = nil) async {
    if suffix == "/connect" { recovery.begin() }
    else { recovery.cancel() }
    await operation.run {
      do { _ = try await store.request(path + suffix, method: "POST", body: body) } catch {
        try? await refresh()
        let reconciled =
          (suffix == "/connect" && connection["status"].string == "ready")
          || (suffix == "/authenticate/manual" && connection["status"].string == "ready")
          || (suffix == "/disconnect" && connection["status"].string == "disconnected")
          || (suffix == "/authenticate/cancel" && session == nil)
        if !reconciled {
          if suffix == "/authenticate/manual", (error as? APIError)?.status == 400 {
            throw APIError(
              "That address couldn’t finish sign-in. Copy the entire address from the browser’s final page and paste it again. To start over, cancel this sign-in."
            )
          }
          throw error
        }
      }
      try await refresh()
    }
  }
}
