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
}
