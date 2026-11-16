import AppIntents
import CoreSpotlight
import CoreTransferable
import UniformTypeIdentifiers
import XCTest
@testable import OpenTeamNative

@MainActor
/// The real App Intents, entity queries and Spotlight donations, scoped to one account.
final class SystemIntentTests: SystemIntentFixture {
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
    try await assertNoSubmission()
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
    let store = try await connectedStore()
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

  func testSignedOutShortcutCannotResolveBots() async throws {
    try SecureSession.clear()
    do { _ = try await TeamBotQuery().suggestedEntities(); XCTFail("Resolved without a session") }
    catch { XCTAssertTrue(error.localizedDescription.contains("connect")) }
    try await assertNoSubmission()
  }

  func testOfflineFailureCannotReportASuccessfulTask() async throws {
    let client = try await SystemIntentClient.connect()
    var intent = SendBotTaskIntent()
    intent.bot = TeamBotEntity(try XCTUnwrap(client.bootstrap.bots.first), scope: scope)
    intent.instructions = "Do not pretend this was accepted"
    intent.attachments = []
    try await control(.object(["offline": .bool(true)]))
    do { _ = try await intent.perform(); XCTFail("Reported success while unavailable") }
    catch { XCTAssertEqual((error as? APIError)?.status, 503) }
    try await control(.object(["offline": .bool(false)]))
    try await assertNoSubmission()
  }

  func testDataAndFileAttachmentsUploadAndExportExactBytes() async throws {
    let client = try await SystemIntentClient.connect()
    let bot = try XCTUnwrap(client.bootstrap.bots.first)
    let content = Data("Fixture attachment: café 📨".utf8)
    let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".txt")
    try content.write(to: file)
    defer { try? FileManager.default.removeItem(at: file) }
    var intent = SendBotTaskIntent()
    intent.bot = TeamBotEntity(bot, scope: scope)
    intent.instructions = "Read these two files"
    intent.attachments = [IntentFile(data: content, filename: "inline.txt", type: .plainText),
      IntentFile(fileURL: file, filename: "from-disk.txt", type: .plainText)]
    let result = try await intent.perform()
    let message = try XCTUnwrap(result.value)
    XCTAssertEqual(message.text, intent.instructions)
    XCTAssertEqual(SystemEntityID(message.id)?.channelID, bot.dmChannelId)
    XCTAssertEqual(message.attachments.map(\.fileName), ["inline.txt", "from-disk.txt"])
    XCTAssertEqual(Set(message.attachments.map(\.id)).count, 2,
      "Identical bytes with different filenames must remain distinct attachments")
    guard #available(iOS 18.2, *) else { return }
    for attachment in message.attachments {
      let file = try await client.exportAttachment(attachment.id)
      XCTAssertEqual(file.lastPathComponent, attachment.fileName)
      let exported = try await attachment.exported(as: .data)
      XCTAssertEqual(exported, content)
    }
    let state = try await fixtureState()
    XCTAssertEqual(state["messages"].array.filter { $0["content"].string == intent.instructions }.count, 1)
    XCTAssertEqual(state["contentReceipts"].array.filter { $0["path"].string == "/api/v0/assets" }.count, 2)
  }

  func testOptOutAndSignOutCannotBeUndoneByAPendingIndexWrite() async throws {
    let appStore = try await connectedStore()
    appStore.setSystemDiscoveryEnabled(true)
    appStore.setSystemDiscoveryEnabled(false)
    await SystemDiscovery.shared.waitForPendingUpdates()
    XCTAssertNil(UserDefaults.standard.data(forKey: "system-discovery-manifest"))
    appStore.setSystemDiscoveryEnabled(true)
    await appStore.signOut()
    await SystemDiscovery.shared.waitForPendingUpdates()
    XCTAssertEqual(appStore.phase, .signedOut)
    XCTAssertNil(appStore.systemScope)
    XCTAssertNil(try SecureSession.read())
    XCTAssertNil(UserDefaults.standard.data(forKey: "system-discovery-manifest"))
  }

  func testRevokedSessionCannotRepopulateSpotlightAfterIntentFailure() async throws {
    let client = try await SystemIntentClient.connect()
    var state = SavedState(); state.bootstrap = client.bootstrap
    UserDefaults.standard.set(true, forKey: "system-discovery-" + scope)
    SystemDiscovery.shared.update(session: session, state: state)
    await SystemDiscovery.shared.waitForPendingUpdates()
    try await control(.object(["failures": .object([
      "GET /api/v0/client-bootstrap": .object(["status": .number(401), "count": .number(100)])])]))
    do { _ = try await SystemIntentClient.connect(); XCTFail("Accepted an expired session") }
    catch {
      if (error as? APIError)?.status != 401 {
        // A simultaneous Shortcuts parameter refresh can discover expiry first.
        XCTAssertNil(try SecureSession.read())
      }
    }
    await SystemDiscovery.shared.waitForPendingUpdates()
    XCTAssertNil(try SecureSession.read(), "A revoked session must no longer authorize later donations")
    SystemDiscovery.shared.update(session: session, state: state)
    await SystemDiscovery.shared.waitForPendingUpdates()
    XCTAssertNil(UserDefaults.standard.data(forKey: "system-discovery-manifest"))
  }

  func testNamedGroupSendAndDraftNeverGuessBetweenGroupsWithTheSameMembers() async throws {
    let initial = try await SystemIntentClient.connect()
    for name in ["Design review", "Release review"] {
      _ = try await initial.api.request("/api/v0/channels", method: "POST", body: .object([
        "name": .string(name), "botIds": .array(initial.bootstrap.bots.prefix(2).map { .string($0.id) })]))
    }
    let client = try await SystemIntentClient.connect()
    let target = try XCTUnwrap(client.destinations.first { $0.name == "Release review" })
    let entity = TeamConversationEntity(target, scope: scope)
    var send = SendTeamConversationMessageIntent()
    send.conversation = entity; send.text = "Review this release"; send.attachments = []
    let result = try await send.perform()
    XCTAssertEqual(SystemEntityID(try XCTUnwrap(result.value).id)?.channelID, target.id)
    let store = try await connectedStore()
    var existing = Draft(); existing.text = "Keep existing draft"
    store.saveDraft(existing, channel: target.id)
    var draft = DraftTeamConversationMessageIntent()
    draft.store = store; draft.conversation = entity; draft.text = "Additional review notes"; draft.attachments = []
    _ = try await draft.perform()
    XCTAssertEqual(store.navigation.last, target.id)
    XCTAssertEqual(store.draft(target.id).text, "Keep existing draft\nAdditional review notes")
    let state = try await fixtureState()
    XCTAssertEqual(state["messages"].array.filter { $0["content"].string == send.text }.count, 1)
    XCTAssertFalse(state["messages"].array.contains { $0["content"].string.contains(draft.text) })
    var other = session; other.userID = "other-account"; try SecureSession.save(other)
    do { _ = try await send.perform(); XCTFail("Sent to another account's conversation") } catch {}
    do { _ = try await draft.perform(); XCTFail("Drafted in another account's conversation") } catch {}
  }

  func testEnumerableQueriesAndTextTransfersValidateTheLiveAccount() async throws {
    guard #available(iOS 18.2, *) else { throw XCTSkip("Transfer export requires iOS 18.2") }
    let bots = try await TeamBotQuery().allEntities()
    var bot = try XCTUnwrap(bots.first)
    bot.name = "Stale cached name"
    let text = try await bot.exported(as: .plainText)
    XCTAssertFalse(String(decoding: text, as: UTF8.self).contains(bot.name))
    let conversations = try await TeamConversationQuery().allEntities()
    let conversation = try XCTUnwrap(conversations.first)
    let exported = try await conversation.exported(as: .plainText)
    XCTAssertEqual(String(decoding: exported, as: UTF8.self), conversation.name)
    var other = session; other.userID = "other-account"; try SecureSession.save(other)
    do { _ = try await bot.exported(as: .plainText); XCTFail("Exported another account's Bot") } catch {}
    do { _ = try await conversation.exported(as: .plainText); XCTFail("Exported another account's conversation") } catch {}
  }
}
