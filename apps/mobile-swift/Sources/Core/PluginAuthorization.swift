import Foundation

/// Owner-visible OAuth handoff metadata. Never includes provider credentials.
public struct PluginAuthorizationSession: Sendable {
  public let url: URL
  public let state: String
  public let expired: Bool
  public init?(_ connection: JSON, now: Date = Date()) {
    guard connection["status"].string == "needs_auth",
      let url = URL(string: connection["authorizationUrl"].string),
      ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil,
      let state = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
        .first(where: { $0.name == "state" })?.value, !state.isEmpty
    else { return nil }
    self.url = url
    self.state = state
    let raw = connection["authorizationExpiresAt"].string
    let format = ISO8601DateFormatter()
    format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let precise = format.date(from: raw)
    format.formatOptions = [.withInternetDateTime]
    expired = !raw.isEmpty && (precise ?? format.date(from: raw) ?? .distantPast) <= now
  }
}
