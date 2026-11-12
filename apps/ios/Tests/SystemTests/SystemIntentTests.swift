import AppIntents
import CoreSpotlight
import XCTest
@testable import OpenTeamNative

/// Run on an isolated simulator with parity-server.ts on port 20084. These tests
/// call the actual intent implementations, using only synthetic accounts/data.
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
}

@MainActor
final class SystemIntentTests: SystemIntentFixture {
  func testTaskIntentSendsInstructionsAndReturnsAcceptedMessage() async throws {
    let client = try await SystemIntentClient.connect()
    let bot = try XCTUnwrap(client.bootstrap.bots.first)
    var intent = SendBotTaskIntent()
    intent.bot = TeamBotEntity(bot, scope: scope)
    intent.instructions = "Compare the fixture vendors"
    intent.attachments = []
    let result = try await intent.perform()
    let message = try XCTUnwrap(result.value)
    XCTAssertEqual(message.text, intent.instructions)
    XCTAssertEqual(SystemEntityID(message.id)?.channelID, bot.dmChannelId)
    let state = try await client.api.request("/__qa/state")
    XCTAssertEqual(state["messages"].array.filter { $0["content"].string == intent.instructions }.count, 1)
  }

  func testSavedShortcutCannotSendAfterAccountChanges() async throws {
    let client = try await SystemIntentClient.connect()
    let bot = try XCTUnwrap(client.bootstrap.bots.first)
    var intent = SendBotTaskIntent()
    intent.bot = TeamBotEntity(bot, scope: scope)
    intent.instructions = "Must never be sent"
    intent.attachments = []
    var differentAccount = session
    differentAccount.userID = "another-account"
    try SecureSession.save(differentAccount)
    do {
      _ = try await intent.perform()
      XCTFail("A saved Shortcut crossed accounts")
    } catch {
      XCTAssertTrue(error.localizedDescription.contains("different OpenTeam account"))
    }
    let state = try await client.api.request("/__qa/state")
    XCTAssertFalse(state["requests"].array.contains { $0["path"].string.hasSuffix("/messages") && $0["method"].string == "POST" })
  }

  func testAttachmentTransferChecksParentAndUsesCurrentSession() async throws {
    let client = try await SystemIntentClient.connect()
    let parent = try XCTUnwrap(client.bootstrap.latestMessages.first)
    let asset = Asset(assetId: String(repeating: "1", count: 64), fileName: "fixture.png",
      mimeType: "image/png", byteSize: 100, kind: "image")
    _ = try await client.api.request("/__qa/update-message", method: "POST", body: .object([
      "id": .string(parent.id), "metadata": .object(["attachments": .array([try .encode(asset)])])]))
    let entity = TeamAttachmentEntity(asset, message: parent, scope: scope)
    let file = try await client.exportAttachment(entity.id)
    defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
    XCTAssertTrue(try Data(contentsOf: file).starts(with: [0x89, 0x50, 0x4E, 0x47]))

    var unrelated = asset
    unrelated.assetId = "not-attached-to-this-message"
    let forged = TeamAttachmentEntity(unrelated, message: parent, scope: scope)
    do { _ = try await client.exportAttachment(forged.id); XCTFail("Exported an unrelated asset") }
    catch { XCTAssertTrue(error.localizedDescription.contains("no longer available")) }

    var other = session; other.userID = "another-account"
    try SecureSession.save(other)
    do { _ = try await client.exportAttachment(entity.id); XCTFail("Exported after switching accounts") }
    catch { XCTAssertTrue(error.localizedDescription.contains("account changed")) }
  }

  func testSpotlightOptInIndexesAndOptOutRemovesAllContent() async throws {
    let client = try await SystemIntentClient.connect()
    let store = AppStore()
    store.server = server
    try await store.startForIntentTest()
    XCTAssertFalse(store.systemDiscoveryEnabled)
    store.setSystemDiscoveryEnabled(true)
    try await SystemDiscovery.shared.reindex()
    XCTAssertNil(SystemDiscovery.shared.failure)
    let manifest = try XCTUnwrap(UserDefaults.standard.data(forKey: "system-discovery-manifest"))
    let entries = try JSONDecoder().decode([String: [String: String]].self, from: manifest)
    XCTAssertTrue(entries.values.contains { !$0.isEmpty })
    XCTAssertEqual(store.systemScope, client.scope)
    var titles = try await Self.indexedTitles()
    for _ in 0..<20 where titles.isEmpty {
      try await Task.sleep(for: .milliseconds(100))
      titles = try await Self.indexedTitles()
    }
    XCTAssertFalse(titles.isEmpty, "Spotlight did not return the donated entities")
    store.setSystemDiscoveryEnabled(false)
    await SystemDiscovery.shared.waitForPendingUpdates()
    XCTAssertNil(UserDefaults.standard.data(forKey: "system-discovery-manifest"))
    XCTAssertFalse(SystemDiscovery.enabled(scope: scope))
    titles = try await Self.indexedTitles()
    for _ in 0..<20 where !titles.isEmpty {
      try await Task.sleep(for: .milliseconds(100))
      titles = try await Self.indexedTitles()
    }
    XCTAssertTrue(titles.isEmpty, "Spotlight retained content after opting out")
  }

  nonisolated private static func indexedTitles() async throws -> [String] {
    let query = CSSearchQuery(queryString: "title == '*'cd", attributes: ["title"])
    var titles: [String] = []
    for try await result in query.results {
      if let title = result.item.attributeSet.title { titles.append(title) }
    }
    return titles
  }
}

private extension AppStore {
  func startForIntentTest() async throws {
    await connect(username: "", password: "")
    XCTAssertEqual(phase, .ready)
  }
}
