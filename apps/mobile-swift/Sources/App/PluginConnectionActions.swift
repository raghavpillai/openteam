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
  private var path: String { "/api/v0/plugin-connections/" + API.segment(connection["id"].string) }
  private var session: PluginAuthorizationSession? {
    PluginAuthorizationSession(connection, now: now)
  }
  private var requiresDesktop: Bool { MobilePluginAuthorization.requiresDesktop(connection) }

  var body: some View {
    FormStatus(operation: operation)
    LabeledContent(
      "Status",
      value: connection["setupPhase"].string.isEmpty ? connection["status"].string.replacingOccurrences(of: "_", with: " ").capitalized : connection["setupPhase"].string.replacingOccurrences(of: "_", with: " ").capitalized)
      // A Form lazily realizes rows. Keep the lifecycle on the visible status row:
      // OAuth controls can push an invisible footer offscreen on smaller iPhones.
      .task(id: scenePhase) { await monitorConnection() }
    if !connection["statusMessage"].string.isEmpty {
      Text(connection["statusMessage"].string).font(.footnote).foregroundStyle(NativePalette.muted)
    }
    if requiresDesktop {
      if connection["status"].string != "ready" {
        Text("Sign in on desktop").font(.headline)
        Text("Open this plugin in the OpenTeam desktop app connected to the same server. Once connected, it works here too; the desktop app can be closed. To sign in from this device, configure a server callback and the provider’s web client in Connection settings.")
          .font(.footnote).foregroundStyle(NativePalette.muted)
      }
    } else if let session {
      Text(session.expired ? "Sign-in expired" : "Waiting for authorization").font(.headline)
      Text(
        session.expired
          ? "Start again when you’re ready. Your setup is saved."
          : "Finish in your browser, or reopen the same sign-in."
      )
      .font(.footnote).foregroundStyle(NativePalette.muted)
      if connection["oauthCallbackMode"].string == "manual", !session.expired {
        Text("After approving access, the localhost page may not load. Copy its complete address and paste it here. Keep it out of chat.")
          .font(.footnote).foregroundStyle(NativePalette.muted)
        SecureField("Complete callback URL", text: $callbackURL)
          .textInputAutocapitalization(.never).autocorrectionDisabled()
          .accessibilityIdentifier("plugin-manual-callback")
          .onChange(of: session.state) { _, _ in callbackURL = "" }
          .onDisappear { callbackURL = "" }
        Button("Complete sign-in") {
          let value = callbackURL
          callbackURL = ""
          Task { await command("/authenticate/manual", body: .object(["callbackUrl": .string(value)])) }
        }.disabled(operation.busy || callbackURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
      Button(session.expired ? "Try again" : "Reopen sign-in") {
        Task {
          if session.expired { await signIn() } else { openURL(session.url) }
        }
      }.disabled(operation.busy)
      Button("Cancel sign-in", role: .cancel) {
        Task {
          await command("/authenticate/cancel", body: .object(["state": .string(session.state)]))
        }
      }.disabled(operation.busy)
    } else if connection["canAuthenticate"].bool {
      Button("Sign in") { Task { await signIn() } }.disabled(operation.busy)
    }
    Button("Connect") { Task { await command("/connect") } }.disabled(operation.busy)
    Button("Refresh status") {
      Task { await operation.run(feedback: false) { try await refresh() } }
    }
    .disabled(operation.busy)
    Button("Disconnect") { Task { await command("/disconnect") } }.disabled(operation.busy)
  }
  private func monitorConnection() async {
    guard scenePhase == .active else { return }
    if startAutomatically, !autoStarted {
      autoStarted = true
      if connection["canAuthenticate"].bool {
        if !requiresDesktop { await signIn() }
      } else { await command("/connect") }
    } else {
      try? await refresh()
    }
    while !Task.isCancelled {
      do { try await Task.sleep(for: .seconds(2)) } catch { return }
      now = Date()
      if !operation.busy,
        ["needs_auth", "connecting", "starting", "reconnecting"].contains(
          connection["status"].string)
      {
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
    }
  }
  private func signIn() async {
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
      openURL(session.url)
    }
  }
  private func command(_ suffix: String, body: JSON? = nil) async {
    await operation.run {
      do { _ = try await store.request(path + suffix, method: "POST", body: body) } catch {
        try? await refresh()
        let reconciled =
          (suffix == "/connect" && connection["status"].string == "ready")
          || (suffix == "/authenticate/manual" && connection["status"].string == "ready")
          || (suffix == "/disconnect" && connection["status"].string == "disconnected")
          || (suffix == "/authenticate/cancel" && session == nil)
        if !reconciled { throw error }
      }
      try await refresh()
    }
  }
}
