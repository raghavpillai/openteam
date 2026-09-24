import Foundation

/// Owner-visible OAuth handoff metadata. Never includes provider credentials.
public struct PluginAuthorizationSession: Sendable {
  public let url: URL
  public let state: String
  public let expired: Bool
  public let usesLoopbackCallback: Bool
  public init?(_ connection: JSON, now: Date = Date()) {
    guard connection["status"].string == "needs_auth",
      let url = URL(string: connection["authorizationUrl"].string),
      ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil,
      let state = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
        .first(where: { $0.name == "state" })?.value, !state.isEmpty
    else { return nil }
    self.url = url
    self.state = state
    let redirect = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
      .first(where: { $0.name == "redirect_uri" })?.value
    let host = redirect.flatMap(URL.init(string:))?.host?.lowercased()
    usesLoopbackCallback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host ?? "")
    let raw = connection["authorizationExpiresAt"].string
    let format = ISO8601DateFormatter()
    format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let precise = format.date(from: raw)
    format.formatOptions = [.withInternetDateTime]
    expired = !raw.isEmpty && (precise ?? format.date(from: raw) ?? .distantPast) <= now
  }
}

/// A desktop callback belongs to that computer, even when its sign-in URL is visible on iOS.
public enum MobilePluginAuthorization {
  public static func providerSetupDescription(pluginKey: String, description: String) -> String {
    ["gmail", "google-calendar", "google-drive"].contains(pluginKey)
      ? "Set up your Google Cloud project once, then sign in. Choose the client type in the steps below to match your sign-in method."
      : description
  }
  public static func providerSetupSteps(pluginKey: String, callbackMode: String, steps: [String])
    -> [String]
  {
    guard ["gmail", "google-calendar", "google-drive"].contains(pluginKey) else { return steps }
    return Array(steps.prefix(2)) + [
      callbackMode == "server"
        ? "Create a Web application OAuth client in Google Cloud. Add the exact callback address shown in Sign-in setup as an authorized redirect URI."
        : "Create a Desktop app OAuth client in Google Cloud. That is Google’s client type name; it does not require the OpenTeam desktop app unless you choose the desktop listener method.",
      "Copy the client ID and client secret into OpenTeam’s setup fields and save. These come from Google Cloud; they are not your Google password.",
      callbackMode == "desktop"
        ? "Finish signing in in the OpenTeam desktop app. The connected account will then work on your iPhone too."
        : "Sign in on this device and follow the on-screen steps. When the account says Connected, choose which bots may use it.",
    ]
  }
  public static func requiresDesktop(_ connection: JSON) -> Bool {
    guard connection["auth"].string == "oauth" else { return false }
    if connection["oauthCallbackMode"].string == "manual" { return false }
    return connection["oauthCallbackMode"].string != "server"
      || PluginAuthorizationSession(connection)?.usesLoopbackCallback == true
  }
}

/// The next useful action depends on connection state, not just whether OAuth is supported.
public struct PluginConnectionPresentation {
  public let connected: Bool
  public let connecting: Bool
  public let needsSetup: Bool
  public let canReconnect: Bool
  public let status: String
  public init(_ connection: JSON, now: Date = Date()) {
    connected = connection["status"].string == "ready"
    connecting = ["connecting", "starting", "reconnecting"].contains(connection["status"].string)
    canReconnect = !connected && !connecting && connection["auth"].string == "oauth"
      && connection["setupPhase"].string == "ready_to_connect"
    needsSetup =
      !connected
      && (connection["setupPhase"].string == "provider_setup_required"
        || connection["configured"] == .bool(false))
    if connected {
      status = "Connected"
    } else if connecting {
      status = "Connecting…"
    } else if let session = PluginAuthorizationSession(connection, now: now) {
      status = session.expired ? "Sign-in expired" : "Finish signing in"
    } else if needsSetup {
      status = "Setup needed"
    } else if connection["status"].string == "error" {
      status = "Couldn’t connect"
    } else if canReconnect {
      status = "Reconnect needed"
    } else if connection["auth"].string == "oauth" {
      status = "Sign-in needed"
    } else {
      status = "Not connected"
    }
  }
}
