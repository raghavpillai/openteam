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
  public static func requiresDesktop(_ connection: JSON) -> Bool {
    guard connection["auth"].string == "oauth" else { return false }
    if connection["oauthCallbackMode"].string == "manual" { return false }
    return connection["oauthCallbackMode"].string != "server"
      || PluginAuthorizationSession(connection)?.usesLoopbackCallback == true
  }
}
