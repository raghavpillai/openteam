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

  func testServerSearchFindsAnOlderMessageAndOpensItsContext() async throws {
    let messages = try await TeamMessageQuery().entities(matching: "mobile shell")
    let message = try XCTUnwrap(messages.first)
    XCTAssertTrue(message.text.contains("mobile shell"))
    let store = AppStore()
    store.server = server
    try await store.startForIntentTest()
    try await store.openSystemItem(message.id)
    XCTAssertEqual(store.focusedMessage, SystemEntityID(message.id)?.localID)
    XCTAssertEqual(store.navigation.last, SystemEntityID(message.id)?.channelID)
  }

  func testRoutineIntentStartsTheResolvedRoutineOnce() async throws {
    let client = try await SystemIntentClient.connect()
    let bot = try XCTUnwrap(client.bootstrap.bots.first)
    let created = try await client.api.request("/api/v0/bots/\(bot.id)/routines", method: "POST",
      body: .object(["name": .string("Morning report"), "prompt": .string("Summarize"),
        "schedule": .string("0 9 * * *"), "enabled": .bool(true)]))
    var intent = RunTeamRoutineIntent()
    intent.routine = TeamRoutineEntity(id: SystemEntityID(scope: scope, kind: .routine,
      channelID: bot.dmChannelId, localID: created["id"].string).value,
      name: "Morning report", conversation: bot.name)
    _ = try await intent.perform()
    let state = try await client.api.request("/__qa/state")
    XCTAssertEqual(state["routineExecutions"].array.count, 1)
    XCTAssertEqual(state["routineExecutions"].array[0]["routineId"].string, created["id"].string)
    _ = try await client.api.request("/__qa/control", method: "POST", body: .object([
      "searchResults": .array([.object(["id": .string("routine:" + created["id"].string),
        "kind": .string("routine"), "title": .string("Morning report"), "subtitle": .string(bot.name),
        "channelId": .string(bot.dmChannelId), "botId": .string(bot.id)])])]))
    let found = try await TeamRoutineQuery().entities(matching: "Morning report")
    XCTAssertEqual(found.first?.id, intent.routine.id)
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

  func testSiriSchemaSendsAndDraftsWithoutReplacingExistingDraft() async throws {
    guard #available(iOS 27.0, *) else { throw XCTSkip("Messaging schemas require iOS 27") }
    let client = try await SystemIntentClient.connect()
    let bot = try XCTUnwrap(client.bootstrap.bots.first)
    var send = SendTeamSiriMessage()
    send.destination = .contact(TeamSiriPerson(bot, scope: scope))
    send.content = AttributedString("Siri fixture task")
    send.attachments = []; send.locations = []; send.links = []
    let result = try await send.perform()
    XCTAssertEqual(try XCTUnwrap(result.value).count, 1)

    let store = AppStore()
    store.server = server
    try await store.startForIntentTest()
    AppDependencyManager.shared.add(dependency: store)
    var existing = Draft(); existing.text = "Keep my draft"
    store.saveDraft(existing, channel: bot.dmChannelId)
    var draft = DraftTeamSiriMessage()
    draft.store = store
    draft.destination = send.destination
    draft.content = AttributedString("Append Siri instructions")
    draft.attachments = []; draft.locations = []; draft.links = []
    _ = try await draft.perform()
    XCTAssertEqual(store.draft(bot.dmChannelId).text, "Keep my draft\nAppend Siri instructions")
    XCTAssertEqual(store.navigation.last, bot.dmChannelId)
  }

  func testSiriRejectsSchedulingInsteadOfSendingImmediately() async throws {
    guard #available(iOS 27.0, *) else { throw XCTSkip("Messaging schemas require iOS 27") }
    let client = try await SystemIntentClient.connect()
    var intent = SendTeamSiriMessage()
    intent.destination = .contact(TeamSiriPerson(try XCTUnwrap(client.bootstrap.bots.first), scope: scope))
    intent.content = AttributedString("Do not send now")
    intent.attachments = []; intent.locations = []; intent.links = []
    intent.scheduledDate = Date().addingTimeInterval(3_600)
    do { _ = try await intent.perform(); XCTFail("Scheduled request sent immediately") }
    catch { XCTAssertTrue(error.localizedDescription.contains("immediate")) }
    let state = try await client.api.request("/__qa/state")
    XCTAssertFalse(state["messages"].array.contains { $0["content"].string == "Do not send now" })
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
