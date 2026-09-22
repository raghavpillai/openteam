import Foundation

struct SessionRecord: Codable, Sendable {
  var server: String
  var token: String?
  var userID: String
  var userName: String
  var mode: String

  var displayName: String {
    let name = userName.trimmingCharacters(in: .whitespacesAndNewlines)
    return name.isEmpty ? "OpenTeam owner" : name
  }

  /// Persist identity changes while connected so a later offline launch has the same name.
  /// An outage must not discard an established account; a revoked session must not restore it.
  @MainActor func refreshIdentity(
    fetch: () async throws -> JSON, save: (SessionRecord) throws -> Void
  ) async throws -> SessionRecord {
    guard mode == "required" else { return self }
    var saved = self
    do {
      let session = try await fetch()
      guard session["session"] != .null, session["user"]["id"].string == userID,
        !userID.isEmpty
      else { throw APIError("Your session expired. Sign in again.", status: 401) }
      saved.userName =
        ["name", "username", "email"]
        .map { session["user"][$0].string.trimmingCharacters(in: .whitespacesAndNewlines) }
        .first { !$0.isEmpty } ?? saved.userName
      try save(saved)
    } catch {
      if let failure = error as? APIError, [401, 403].contains(failure.status) { throw failure }
      // Network or Keychain outages retain the established identity in memory.
    }
    return saved
  }
}
