import AppIntents
import XCTest
@testable import OpenTeamNative

@MainActor
final class BotLaunchTests: SystemIntentFixture {
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
    try await assertNoSubmission()
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
    try await assertNoSubmission()
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

  func testCachedOpenAndVoiceLaunchDoNotWaitForTheServer() async throws {
    let store = try await connectedStore()
    let bot = try XCTUnwrap(store.state.bootstrap?.bots.last)
    let entity = TeamBotEntity(bot, scope: scope)
    try await control(.object(["offline": .bool(true)]))
    var open = OpenTeamBotIntent()
    open.store = store; open.target = entity
    _ = try await open.perform()
    XCTAssertEqual(store.navigation, [bot.dmChannelId])
    var voice = RecordBotVoiceNoteIntent()
    voice.store = store; voice.bot = entity
    _ = try await voice.perform()
    XCTAssertEqual(store.botVoiceLaunch.pending?.channelID, bot.dmChannelId)
    try await assertNoSubmission()
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

  func testExpiredOrWrongAccountHandoffsCannotStartRecording() {
    let handoff = BotVoiceLaunch()
    let memo = VoiceMemoController()
    handoff.register(memo, channelID: "research", key: "research", presentation: handoff.presentation)
    handoff.open(scope: scope, channelID: "research", record: true, now: .distantPast)
    XCTAssertFalse(handoff.takeRecording(for: memo, scope: scope,
      channelID: "research", key: "research", visible: true))
    XCTAssertNil(handoff.pending)
    handoff.open(scope: scope, channelID: "research", record: true)
    XCTAssertFalse(handoff.takeRecording(for: memo, scope: "different-account",
      channelID: "research", key: "research", visible: true))
    XCTAssertNil(handoff.pending)
  }
}
