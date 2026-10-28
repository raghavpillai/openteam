import AppIntents
import XCTest
@testable import OpenTeamNative

@MainActor
final class BotLaunchTests: SystemIntentFixture {
  private func connectedStore() async throws -> AppStore {
    let store = AppStore()
    store.server = server
    await store.connect(username: "", password: "")
    XCTAssertEqual(store.phase, .ready)
    return store
  }

  func testOpenBotShortcutSwitchesToChosenBotAndPreservesItsDraft() async throws {
    let client = try await SystemIntentClient.connect()
    let bot = try XCTUnwrap(client.bootstrap.bots.last)
    let store = try await connectedStore()
    store.navigation = [try XCTUnwrap(client.bootstrap.bots.first).dmChannelId]
    var draft = Draft(); draft.text = "Keep my unsent instructions"
    store.saveDraft(draft, channel: bot.dmChannelId)
    var intent = OpenTeamBotIntent()
    intent.store = store
    intent.target = TeamBotEntity(bot, scope: scope)
    _ = try await intent.perform()
    XCTAssertEqual(store.navigation, [bot.dmChannelId])
    XCTAssertEqual(store.draft(bot.dmChannelId), draft)
    XCTAssertNil(store.botVoiceLaunch.pending)
    try await assertNoDelivery()
  }

  func testVoiceShortcutQueuesOnlyTheChosenBotUntilItsComposerIsVisible() async throws {
    let client = try await SystemIntentClient.connect()
    let bot = try XCTUnwrap(client.bootstrap.bots.last)
    let store = try await connectedStore()
    var draft = Draft(); draft.text = "Existing text"
    store.saveDraft(draft, channel: bot.dmChannelId)
    var intent = RecordBotVoiceNoteIntent()
    intent.store = store
    intent.bot = TeamBotEntity(bot, scope: scope)
    _ = try await intent.perform()
    XCTAssertEqual(store.navigation, [bot.dmChannelId])
    XCTAssertEqual(store.botVoiceLaunch.pending?.channelID, bot.dmChannelId)
    XCTAssertEqual(store.botVoiceLaunch.pending?.scope, scope)
    XCTAssertEqual(store.draft(bot.dmChannelId), draft)
    let memo = VoiceMemoController()
    store.botVoiceLaunch.register(memo, channelID: bot.dmChannelId, key: bot.dmChannelId)
    XCTAssertFalse(store.botVoiceLaunch.takeRecording(for: memo, scope: scope,
      channelID: bot.dmChannelId, key: bot.dmChannelId, visible: false))
    XCTAssertFalse(store.botVoiceLaunch.takeRecording(for: memo, scope: scope,
      channelID: "another-chat", key: "another-chat", visible: true))
    XCTAssertFalse(store.botVoiceLaunch.takeRecording(for: memo, scope: scope,
      channelID: bot.dmChannelId, key: "thread-composer", visible: true))
    XCTAssertTrue(store.botVoiceLaunch.takeRecording(for: memo, scope: scope,
      channelID: bot.dmChannelId, key: bot.dmChannelId, visible: true))
    XCTAssertFalse(store.botVoiceLaunch.takeRecording(for: memo, scope: scope,
      channelID: bot.dmChannelId, key: bot.dmChannelId, visible: true))
    XCTAssertEqual(memo.phase, .idle, "Only the mounted composer may open the microphone")
    try await assertNoDelivery()
  }

  func testRepeatedBackgroundShortcutTriggersArmOnlyOneForegroundRecording() async throws {
    let client = try await SystemIntentClient.connect()
    let bot = try XCTUnwrap(client.bootstrap.bots.last)
    let store = try await connectedStore()
    store.setForeground(false)
    var intent = RecordBotVoiceNoteIntent()
    intent.store = store; intent.bot = TeamBotEntity(bot, scope: scope)
    // Back Tap runs a saved shortcut outside the app. A repeated invocation
    // before its composer mounts must not create multiple recording starts.
    _ = try await intent.perform()
    _ = try await intent.perform()
    let memo = VoiceMemoController()
    store.botVoiceLaunch.register(memo, channelID: bot.dmChannelId, key: bot.dmChannelId)
    XCTAssertFalse(store.botVoiceLaunch.takeRecording(for: memo, scope: scope,
      channelID: bot.dmChannelId, key: bot.dmChannelId, visible: false))
    store.setForeground(true)
    XCTAssertEqual(store.navigation, [bot.dmChannelId])
    XCTAssertTrue(store.botVoiceLaunch.takeRecording(for: memo, scope: scope,
      channelID: bot.dmChannelId, key: bot.dmChannelId, visible: true))
    XCTAssertFalse(store.botVoiceLaunch.takeRecording(for: memo, scope: scope,
      channelID: bot.dmChannelId, key: bot.dmChannelId, visible: true))
    store.setForeground(false)
    try await assertNoDelivery()
  }

  func testVoiceShortcutSurvivesColdLaunchAndOpeningABotCancelsIt() async throws {
    let client = try await SystemIntentClient.connect()
    let bot = try XCTUnwrap(client.bootstrap.bots.first)
    let store = AppStore()
    var voice = RecordBotVoiceNoteIntent()
    voice.store = store; voice.bot = TeamBotEntity(bot, scope: scope)
    _ = try await voice.perform()
    XCTAssertTrue(store.navigation.isEmpty)
    XCTAssertNil(store.botVoiceLaunch.pending)
    await store.start()
    for _ in 0..<30 where store.botVoiceLaunch.pending == nil {
      try await Task.sleep(for: .milliseconds(100))
    }
    XCTAssertEqual(store.botVoiceLaunch.pending?.channelID, bot.dmChannelId)
    XCTAssertEqual(store.navigation, [bot.dmChannelId])
    var open = OpenTeamBotIntent()
    open.store = store; open.target = voice.bot
    _ = try await open.perform()
    XCTAssertNil(store.botVoiceLaunch.pending)
    store.setForeground(false)
    try await assertNoDelivery()
  }

  func testOldAccountShortcutCannotOpenOrRecordInAnotherAccount() async throws {
    let client = try await SystemIntentClient.connect()
    let store = try await connectedStore()
    var intent = RecordBotVoiceNoteIntent()
    intent.store = store
    intent.bot = TeamBotEntity(try XCTUnwrap(client.bootstrap.bots.first), scope: scope)
    var other = session; other.userID = "different-account"
    try SecureSession.save(other)
    do { _ = try await intent.perform(); XCTFail("Accepted another account's Bot") }
    catch { XCTAssertTrue(error.localizedDescription.contains("different OpenTeam account")) }
    XCTAssertTrue(store.navigation.isEmpty)
    XCTAssertNil(store.botVoiceLaunch.pending)
  }

  func testMissingTranscriptionDoesNotOpenTheMicrophoneOrNavigate() async throws {
    let client = try await SystemIntentClient.connect()
    let store = try await connectedStore()
    var intent = RecordBotVoiceNoteIntent()
    intent.store = store
    intent.bot = TeamBotEntity(try XCTUnwrap(client.bootstrap.bots.first), scope: scope)
    _ = try await client.api.request("/__qa/control", method: "POST", body: .object([
      "transcription": .string("missing")]))
    await store.refresh(flushPending: false)
    do { _ = try await intent.perform(); XCTFail("Recorded without transcription configured") }
    catch { XCTAssertTrue(error.localizedDescription.contains("Configure voice notes")) }
    XCTAssertNil(store.botVoiceLaunch.pending)
    XCTAssertTrue(store.navigation.isEmpty)
    try await assertNoDelivery()
  }

  func testUnreachableServerReturnsASerializableShortcutError() async throws {
    var unavailable = session
    unavailable.server = "http://127.0.0.1:1"
    try SecureSession.save(unavailable)
    do { _ = try await TeamBotQuery().suggestedEntities(); XCTFail("Resolved an unreachable server") }
    catch {
      XCTAssertTrue(error is APIError)
      XCTAssertTrue(error.localizedDescription.contains("Could not reach"))
      let encoded = try NSKeyedArchiver.archivedData(withRootObject: error as NSError,
        requiringSecureCoding: true)
      XCTAssertFalse(encoded.isEmpty)
    }
  }

  func testSavedBotResolutionUsesTheAccountCacheWhileServerIsUnavailable() async throws {
    let store = try await connectedStore()
    store.flushPersistence()
    let bot = try XCTUnwrap(store.state.bootstrap?.bots.first)
    let entity = TeamBotEntity(bot, scope: scope)
    _ = try await API(server: server).request("/__qa/control", method: "POST",
      body: .object(["offline": .bool(true)]))
    let resolved = try await TeamBotQuery().entities(for: [entity.id])
    XCTAssertEqual(resolved.map(\.id), [entity.id])
    XCTAssertEqual(resolved.first?.name, bot.name)
    try await assertNoDelivery()
  }

  func testCachedOpenAndVoiceLaunchDoNotWaitForTheServer() async throws {
    let store = try await connectedStore()
    let bot = try XCTUnwrap(store.state.bootstrap?.bots.last)
    let entity = TeamBotEntity(bot, scope: scope)
    _ = try await API(server: server).request("/__qa/control", method: "POST",
      body: .object(["offline": .bool(true)]))
    var open = OpenTeamBotIntent()
    open.store = store; open.target = entity
    _ = try await open.perform()
    XCTAssertEqual(store.navigation, [bot.dmChannelId])
    var voice = RecordBotVoiceNoteIntent()
    voice.store = store; voice.bot = entity
    _ = try await voice.perform()
    XCTAssertEqual(store.botVoiceLaunch.pending?.channelID, bot.dmChannelId)
    try await assertNoDelivery()
  }

  func testMissingAndCorruptBotCachesFallBackToLiveResolution() async throws {
    let client = try await SystemIntentClient.connect()
    let entity = TeamBotEntity(try XCTUnwrap(client.bootstrap.bots.first), scope: scope)
    let uncached = try await TeamBotQuery().entities(for: [entity.id])
    XCTAssertEqual(uncached.map(\.id), [entity.id])
    let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("OpenTeam")
    let disk = try DiskStore(directory: root, scope: scope)
    try Data("invalid-cache".utf8).write(to: disk.url)
    let recovered = try await TeamBotQuery().entities(for: [entity.id])
    XCTAssertEqual(recovered.map(\.id), [entity.id])
  }

  func testCachedBotCannotResolveAfterAccountChangeOrLocalReset() async throws {
    let store = try await connectedStore()
    store.flushPersistence()
    let entity = TeamBotEntity(try XCTUnwrap(store.state.bootstrap?.bots.first), scope: scope)
    var other = session; other.userID = "another-account"
    try SecureSession.save(other)
    do { _ = try await TeamBotQuery().entities(for: [entity.id]); XCTFail("Resolved another account's cached Bot") }
    catch { XCTAssertTrue(error.localizedDescription.contains("different OpenTeam account")) }
    try SecureSession.save(session)
    UserDefaults.standard.set(true, forKey: LocalDataReset.pendingKey)
    defer { UserDefaults.standard.removeObject(forKey: LocalDataReset.pendingKey) }
    do { _ = try await TeamBotQuery().entities(for: [entity.id]); XCTFail("Resolved a cached Bot during local reset") }
    catch { XCTAssertTrue(error.localizedDescription.contains("connect to your server")) }
  }

  func testCachedBotCannotOpenAfterCredentialsChange() async throws {
    let store = try await connectedStore()
    let entity = TeamBotEntity(try XCTUnwrap(store.state.bootstrap?.bots.first), scope: scope)
    var replaced = session; replaced.token = "replacement-fixture-token"
    try SecureSession.save(replaced)
    var intent = OpenTeamBotIntent()
    intent.store = store; intent.target = entity
    do { _ = try await intent.perform(); XCTFail("Opened stale authenticated app state") }
    catch { XCTAssertTrue(error.localizedDescription.contains("Connect to this OpenTeam account")) }
    XCTAssertTrue(store.navigation.isEmpty)
  }

  func testResolvingCachedBotDoesNotAuthorizeSendingWhileOffline() async throws {
    let store = try await connectedStore()
    store.flushPersistence()
    let entity = TeamBotEntity(try XCTUnwrap(store.state.bootstrap?.bots.first), scope: scope)
    _ = try await API(server: server).request("/__qa/control", method: "POST",
      body: .object(["offline": .bool(true)]))
    let resolved = try await TeamBotQuery().entities(for: [entity.id])
    let bot = try XCTUnwrap(resolved.first)
    var intent = SendBotTaskIntent()
    intent.bot = bot; intent.instructions = "Must still validate on the server"; intent.attachments = []
    do { _ = try await intent.perform(); XCTFail("Sent from cached metadata") }
    catch { XCTAssertTrue(error is APIError) }
    try await assertNoDelivery()
  }

  func testRepeatedLaunchPreservesActiveRecordingAndRefusesAnotherBot() throws {
    let handoff = BotVoiceLaunch()
    let memo = VoiceMemoController()
    handoff.register(memo, channelID: "research", key: "research")
    // This synchronous test cancels before the recorder's Task runs, so it
    // exercises the real controller's busy state without requesting a mic.
    memo.startLocked()
    defer { memo.tearDown() }
    XCTAssertFalse(try handoff.canOpen("research"))
    XCTAssertThrowsError(try handoff.canOpen("ops"))
    XCTAssertEqual(memo.phase, .locked)
  }

  func testAThreadRecordingCannotBeReplacedWithTheMainComposer() throws {
    let handoff = BotVoiceLaunch()
    let memo = VoiceMemoController()
    handoff.register(memo, channelID: "research", key: "thread-research")
    memo.startLocked()
    defer { memo.tearDown() }
    XCTAssertThrowsError(try handoff.canOpen("research"))
    XCTAssertEqual(memo.phase, .locked)
  }

  func testExpiredOrWrongAccountHandoffsCannotStartRecording() {
    let handoff = BotVoiceLaunch()
    let memo = VoiceMemoController()
    handoff.register(memo, channelID: "research", key: "research")
    handoff.open(scope: scope, channelID: "research", record: true, now: .distantPast)
    XCTAssertFalse(handoff.takeRecording(for: memo, scope: scope,
      channelID: "research", key: "research", visible: true))
    XCTAssertNil(handoff.pending)
    handoff.open(scope: scope, channelID: "research", record: true)
    XCTAssertFalse(handoff.takeRecording(for: memo, scope: "different-account",
      channelID: "research", key: "research", visible: true))
    XCTAssertNil(handoff.pending)
  }

  func testOldComposerCannotConsumeTheNewChatPresentationRequest() {
    let handoff = BotVoiceLaunch()
    let oldMemo = VoiceMemoController()
    handoff.register(oldMemo, channelID: "research", key: "research")
    handoff.open(scope: scope, channelID: "research", record: true)
    XCTAssertFalse(handoff.takeRecording(for: oldMemo, scope: scope,
      channelID: "research", key: "research", visible: true))
    let newMemo = VoiceMemoController()
    handoff.register(newMemo, channelID: "research", key: "research")
    XCTAssertTrue(handoff.takeRecording(for: newMemo, scope: scope,
      channelID: "research", key: "research", visible: true))
  }

  func testNavigationAndSignOutClearUnconsumedVoiceRequests() async throws {
    let store = try await connectedStore()
    store.navigation = ["research"]
    store.botVoiceLaunch.open(scope: scope, channelID: "research", record: true)
    store.navigation = ["ops"]
    XCTAssertNil(store.botVoiceLaunch.pending)
    store.botVoiceLaunch.open(scope: scope, channelID: "ops", record: true)
    await store.signOut()
    XCTAssertNil(store.botVoiceLaunch.pending)
    XCTAssertEqual(store.phase, .signedOut)
  }

  private func assertNoDelivery() async throws {
    let value = try await API(server: server).request("/__qa/state")
    XCTAssertFalse(value["requests"].array.contains {
      $0["method"].string == "POST" && ($0["path"].string.hasSuffix("/messages")
        || $0["path"].string == "/api/v0/transcriptions")
    }, "Opening or arming recording must never submit a voice note")
  }
}
