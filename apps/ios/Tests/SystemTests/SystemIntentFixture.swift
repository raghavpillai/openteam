import XCTest
@testable import OpenTeamNative

/// Hosted-test base: run on an isolated simulator with parity-server.ts on port 20084. Each test
/// starts from a reset fixture, an empty local cache and a saved synthetic session.
@MainActor
class SystemIntentFixture: XCTestCase {
  let server = "http://127.0.0.1:20084"
  var session: SessionRecord {
    SessionRecord(server: server, token: nil, userID: "auth-disabled", userName: "Fixture", mode: "disabled")
  }
  var scope: String { SystemEntityID.scope(server: server, userID: session.userID) }

  override func setUp() async throws {
    continueAfterFailure = true
    XCTAssertEqual(ProcessInfo.processInfo.environment["OPENTEAM_SYSTEM_TEST_HOST"], "1")
    _ = try await API(server: server).request("/__qa/reset", method: "POST", body: .object([:]))
    UserDefaults.standard.removeObject(forKey: LocalDataReset.pendingKey)
    UserDefaults.standard.set(false, forKey: "system-discovery-" + scope)
    try SecureSession.save(session)
    await SystemDiscovery.shared.clearAndWait()
    let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("OpenTeam")
    try DiskStore(directory: root, scope: scope).clear()
  }

  override func tearDown() async throws {
    await SystemDiscovery.shared.clearAndWait()
    try SecureSession.clear()
    UserDefaults.standard.removeObject(forKey: "system-discovery-" + scope)
  }

  /// A real AppStore signed in to the fixture (auth disabled).
  func connectedStore(server endpoint: String? = nil) async throws -> AppStore {
    let store = AppStore()
    store.server = endpoint ?? server
    await store.connect(username: "", password: "")
    XCTAssertEqual(store.phase, .ready)
    return store
  }
  /// `offline`, `dropNextSend`, `deliveryDelayMs` or `failures` ("METHOD /path" or "/prefix/*").
  func control(_ body: JSON) async throws {
    _ = try await API(server: server).request("/__qa/control", method: "POST", body: body)
  }
  func scene(_ name: String) async throws {
    _ = try await API(server: server).request("/__qa/scene", method: "POST", body: .object(["scene": .string(name)]))
  }
  func fixtureState() async throws -> JSON { try await API(server: server).request("/__qa/state") }
  func requests() async throws -> [JSON] { try await fixtureState()["requests"].array }
  /// Shortcut and launch paths must never post a message or a voice note on their own.
  func assertNoSubmission(file: StaticString = #filePath, line: UInt = #line) async throws {
    let posted = try await requests().contains {
      $0["method"].string == "POST"
        && ($0["path"].string.hasSuffix("/messages") || $0["path"].string == "/api/v0/transcriptions")
    }
    XCTAssertFalse(posted, "A message or voice note was submitted", file: file, line: line)
  }
}
