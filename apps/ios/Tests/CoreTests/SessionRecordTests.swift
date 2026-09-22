import XCTest

@testable import OpenTeamCore

@MainActor
final class SessionRecordTests: XCTestCase {
  private let migrated = SessionRecord(
    server: "https://team.example", token: "synthetic-token", userID: "owner",
    userName: "", mode: "required")

  private func response(name: String, id: String = "owner") -> JSON {
    .object([
      "session": .object(["id": .string("session")]),
      "user": .object(["id": .string(id), "name": .string(name)]),
    ])
  }

  func testRefreshedNameSurvivesPersistedOfflineRelaunch() async throws {
    var disk = try JSONEncoder().encode(migrated)
    let connected = try await migrated.refreshIdentity(
      fetch: { self.response(name: "Stored Owner") },
      save: { disk = try JSONEncoder().encode($0) })
    XCTAssertEqual(connected.displayName, "Stored Owner")
    let relaunched = try JSONDecoder().decode(SessionRecord.self, from: disk)
    let offline = try await relaunched.refreshIdentity(
      fetch: { throw URLError(.notConnectedToInternet) },
      save: { _ in XCTFail("An outage must not overwrite the stored session") })
    XCTAssertEqual(offline.displayName, "Stored Owner")
    XCTAssertEqual(offline.server, migrated.server)
    XCTAssertEqual(offline.token, migrated.token)
  }

  func testEmptyResponseDoesNotEraseSavedName() async throws {
    var saved = migrated
    saved.userName = "Known Owner"
    let refreshed = try await saved.refreshIdentity(
      fetch: { self.response(name: "  \n") },
      save: { XCTAssertEqual($0.userName, "Known Owner") })
    XCTAssertEqual(refreshed.displayName, "Known Owner")
    XCTAssertEqual(migrated.displayName, "OpenTeam owner")
  }

  func testExpiredOrMismatchedAccountCannotRestoreCachedIdentity() async throws {
    for value in [JSON.null, response(name: "Another person", id: "other-account")] {
      do {
        _ = try await migrated.refreshIdentity(
          fetch: { value }, save: { _ in XCTFail("Must not save an invalid identity") })
        XCTFail("Expected session expiry")
      } catch { XCTAssertEqual((error as? APIError)?.status, 401) }
    }
    do {
      _ = try await migrated.refreshIdentity(
        fetch: { throw APIError("Revoked", status: 403) }, save: { _ in XCTFail() })
      XCTFail("Expected revoked session")
    } catch { XCTAssertEqual((error as? APIError)?.status, 403) }
  }
}
