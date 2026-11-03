import AppIntents
import CoreSpotlight
import CoreTransferable
import UniformTypeIdentifiers
import XCTest
@testable import OpenTeamNative

@MainActor
final class SystemIntentEdgeTests: SystemIntentFixture {
  private func store() async throws -> AppStore {
    let store = AppStore()
    store.server = server
    await store.connect(username: "", password: "")
    XCTAssertEqual(store.phase, .ready)
    return store
  }

  private func control(_ body: JSON) async throws {
    _ = try await API(server: server).request("/__qa/control", method: "POST", body: body)
  }

  private func assertNoSubmission() async throws {
    let state = try await API(server: server).request("/__qa/state")
    XCTAssertFalse(state["requests"].array.contains {
      $0["method"].string == "POST" && $0["path"].string.hasSuffix("/messages")
    })
  }

  func testSignedOutAndInterruptedResetRejectActions() async throws {
    try SecureSession.clear()
    do { _ = try await TeamBotQuery().suggestedEntities(); XCTFail("Resolved without a session") }
    catch { XCTAssertTrue(error.localizedDescription.contains("connect")) }
    try SecureSession.save(session)
    UserDefaults.standard.set(true, forKey: LocalDataReset.pendingKey)
    do { _ = try await TeamBotQuery().suggestedEntities(); XCTFail("Resolved during local reset") }
    catch { XCTAssertTrue(error.localizedDescription.contains("connect")) }
    UserDefaults.standard.removeObject(forKey: LocalDataReset.pendingKey)
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

  func testBlankInstructionsAndTooManyAttachmentsDoNotSubmit() async throws {
    let client = try await SystemIntentClient.connect()
    var intent = SendBotTaskIntent()
    intent.bot = TeamBotEntity(try XCTUnwrap(client.bootstrap.bots.first), scope: scope)
    intent.instructions = " \n "
    intent.attachments = []
    do { _ = try await intent.perform(); XCTFail("Accepted an empty task") }
    catch { XCTAssertTrue(error.localizedDescription.contains("Add instructions")) }
    intent.instructions = "Too many attachments"
    intent.attachments = (0..<7).map { IntentFile(data: Data([1]), filename: "\($0).txt", type: .plainText) }
    do { _ = try await intent.perform(); XCTFail("Accepted seven attachments") }
    catch { XCTAssertTrue(error.localizedDescription.contains("six")) }
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
    let state = try await client.api.request("/__qa/state")
    XCTAssertEqual(state["contentReceipts"].array.filter { $0["path"].string == "/api/v0/assets" }.count, 2)
  }

  func testTextTransferUsesFreshContentAndRejectsChangedAccount() async throws {
    guard #available(iOS 18.2, *) else { throw XCTSkip("Transfer export requires iOS 18.2") }
    let client = try await SystemIntentClient.connect()
    let source = try XCTUnwrap(client.bootstrap.latestMessages.first)
    let entity = TeamMessageEntity(source, name: "Research", scope: scope)
    _ = try await client.api.request("/__qa/update-message", method: "POST", body: .object([
      "id": .string(source.id), "content": .string("New server text, not the cached entity")]))
    let exported = try await entity.exported(as: .plainText)
    XCTAssertEqual(String(decoding: exported, as: UTF8.self), "New server text, not the cached entity")
    var other = session; other.userID = "another-account"
    try SecureSession.save(other)
    do { _ = try await entity.exported(as: .plainText); XCTFail("Exported across accounts") }
    catch {
      // CoreTransferable wraps exporter errors; the important contract is that
      // it fails instead of returning any bytes from the other account.
    }
  }

  func testOpenIntentAndColdLaunchNavigationUseTheScopedDestination() async throws {
    let client = try await SystemIntentClient.connect()
    let target = try XCTUnwrap(client.destinations.first)
    let appStore = AppStore() // Has not started: exercise the pending-open path.
    var intent = OpenTeamConversationIntent()
    intent.target = TeamConversationEntity(target, scope: scope)
    intent.store = appStore
    _ = try await intent.perform()
    XCTAssertTrue(appStore.navigation.isEmpty)
    await appStore.start()
    for _ in 0..<30 where appStore.navigation.last != target.id {
      try await Task.sleep(for: .milliseconds(100))
    }
    XCTAssertEqual(appStore.navigation.last, target.id)
    appStore.setForeground(false)
  }

  func testSiriDraftWithoutRecipientAndAttachmentLimitPreserveUserData() async throws {
    guard #available(iOS 27.0, *) else { throw XCTSkip("Siri schemas require iOS 27") }
    let client = try await SystemIntentClient.connect()
    let bot = try XCTUnwrap(client.bootstrap.bots.first)
    let appStore = try await store()
    var draft = DraftTeamSiriMessage()
    draft.store = appStore
    draft.content = AttributedString("Choose the destination in the app")
    draft.attachments = []; draft.locations = []; draft.links = []
    _ = try await draft.perform()
    XCTAssertEqual(appStore.systemDraft?.text, "Choose the destination in the app")
    XCTAssertTrue(appStore.navigation.isEmpty)

    let asset = Asset(assetId: "fixture", fileName: "file.txt", mimeType: "text/plain", byteSize: 1, kind: "file")
    var existing = Draft(); existing.text = "Keep this text"
    existing.attachments = Array(repeating: asset, count: 6)
    appStore.saveDraft(existing, channel: bot.dmChannelId)
    let target = TeamBotEntity(bot, scope: scope)
    do {
      try await appStore.openSystemItem(target.id, draft: "New text", attachments: [asset])
      XCTFail("Overfilled the existing draft")
    } catch { XCTAssertTrue(error.localizedDescription.contains("already has attachments")) }
    XCTAssertEqual(appStore.draft(bot.dmChannelId), existing)
    XCTAssertTrue(appStore.navigation.isEmpty)
    try await assertNoSubmission()
  }

  func testDiscoveryIncrementallyEditsAndEvictsActualSpotlightContent() async throws {
    let client = try await SystemIntentClient.connect()
    var bootstrap = client.bootstrap
    let source = try XCTUnwrap(bootstrap.latestMessages.first)
    var message = source; message.content = "Spotlight original marker"
    bootstrap.latestMessages = [message]
    XCTAssertEqual(SystemDiscoverySnapshot(bootstrap: bootstrap, messages: [:]).messages.count, 1)
    var state = SavedState(); state.bootstrap = bootstrap
    UserDefaults.standard.set(true, forKey: "system-discovery-" + scope)
    SystemDiscovery.shared.update(session: session, state: state)
    await SystemDiscovery.shared.waitForPendingUpdates()
    try await assertIndexed("Spotlight original marker", present: true)

    state.bootstrap?.latestMessages[0].content = "Spotlight replacement marker"
    SystemDiscovery.shared.update(session: session, state: state)
    await SystemDiscovery.shared.waitForPendingUpdates()
    try await assertIndexed("Spotlight replacement marker", present: true)
    try await assertIndexed("Spotlight original marker", present: false)

    state.bootstrap?.channels.removeAll { $0.id == source.channelId }
    SystemDiscovery.shared.update(session: session, state: state)
    await SystemDiscovery.shared.waitForPendingUpdates()
    try await assertIndexed("Spotlight replacement marker", present: false)
  }

  func testOptOutAndSignOutCannotBeUndoneByAPendingIndexWrite() async throws {
    let appStore = try await store()
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

  func testDelayedRevocationDoesNotEraseANewAccountSession() async throws {
    try await control(.object(["failures": .object([
      "GET /api/v0/client-bootstrap": .object([
        "status": .number(401), "count": .number(1), "delayMs": .number(500)])])]))
    let attempt = Task { try await SystemIntentClient.connect() }
    try await Task.sleep(for: .milliseconds(200))
    var replacement = session; replacement.userID = "newly-connected-account"
    try SecureSession.save(replacement)
    do { _ = try await attempt.value; XCTFail("Accepted the revoked session") }
    catch { XCTAssertEqual((error as? APIError)?.status, 401) }
    XCTAssertEqual(try SecureSession.read()?.userID, replacement.userID)
  }

  func testSiriRecipientListRequiresAUniqueExistingGroup() async throws {
    guard #available(iOS 27.0, *) else { throw XCTSkip("Siri schemas require iOS 27") }
    let initial = try await SystemIntentClient.connect()
    _ = try await initial.api.request("/api/v0/channels", method: "POST", body: .object([
      "name": .string("Existing fixture group"),
      "botIds": .array(initial.bootstrap.bots.prefix(2).map { .string($0.id) })]))
    let client = try await SystemIntentClient.connect()
    let group = try XCTUnwrap(client.destinations.first { $0.channel.isGroup && $0.members.count > 1 })
    var intent = SendTeamSiriMessage()
    intent.destination = .recipients(group.members.map { TeamSiriPerson($0, scope: scope) })
    intent.content = AttributedString("Send to the existing group")
    intent.attachments = []; intent.locations = []; intent.links = []
    let result = try await intent.perform()
    XCTAssertEqual(SystemEntityID(try XCTUnwrap(result.value?.first).id)?.channelID, group.id)
    _ = try await client.api.request("/api/v0/channels", method: "POST", body: .object([
      "name": .string("Same recipients, different conversation"),
      "botIds": .array(group.members.map { .string($0.id) })]))
    intent.content = AttributedString("Ambiguous group must not receive this")
    do { _ = try await intent.perform(); XCTFail("Selected an ambiguous group") }
    catch { XCTAssertTrue(error.localizedDescription.contains("open the group")) }
    let state = try await client.api.request("/__qa/state")
    XCTAssertFalse(state["messages"].array.contains { $0["content"].string == "Ambiguous group must not receive this" })
  }

  private func assertIndexed(_ text: String, present: Bool) async throws {
    XCTAssertNil(SystemDiscovery.shared.failure)
    var found = try await Self.containsIndexText(text)
    for _ in 0..<20 where found != present {
      try await Task.sleep(for: .milliseconds(100))
      found = try await Self.containsIndexText(text)
    }
    XCTAssertEqual(found, present, text)
  }

  nonisolated private static func containsIndexText(_ text: String) async throws -> Bool {
    let query = CSSearchQuery(queryString: "title == '*'cd", attributes: ["title", "contentDescription"])
    for try await result in query.results {
      if result.item.attributeSet.title?.contains(text) == true
        || result.item.attributeSet.contentDescription?.contains(text) == true { return true }
    }
    return false
  }
}
