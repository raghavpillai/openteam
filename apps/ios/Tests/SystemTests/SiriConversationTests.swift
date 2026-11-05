import AppIntents
import CoreSpotlight
import CoreTransferable
import UniformTypeIdentifiers
import XCTest
@testable import OpenTeamNative

@MainActor
final class SiriConversationTests: SystemIntentFixture {
  func testConversationQueryReturnsFreshPreviewAndMessageReadStateUsesCursor() async throws {
    guard #available(iOS 27.0, *) else { throw XCTSkip("Messaging schemas require iOS 27") }
    let client = try await SystemIntentClient.connect()
    var source = try XCTUnwrap(client.bootstrap.latestMessages.first)
    var target = try XCTUnwrap(client.destinations.first { $0.id == source.channelId })
    let id = TeamConversationEntity(target, scope: scope).id
    _ = try await client.api.request("/__qa/update-message", method: "POST", body: .object([
      "id": .string(source.id), "content": .string("Current conversation preview")]))
    let entities = try await TeamSiriConversationQuery().entities(for: [id])
    let entity = try XCTUnwrap(entities.first)
    // Latest is selected by sequence rather than array order.
    let refreshed = try await SystemIntentClient.connect()
    let latest = try XCTUnwrap(refreshed.latestMessage(channelID: target.id))
    XCTAssertEqual(String(entity.previewText.characters), SystemConversationProjection.preview(latest))
    XCTAssertEqual(entity.attributeSet.contentDescription, String(entity.previewText.characters))
    target.channel.unreadCount = 1
    target.channel.notificationState = .object(["lastReadSequence": .string("100000000000000000000")])
    source.sequence = "99999999999999999999"
    var message = TeamSiriMessage(source, target: target, scope: scope, owner: "Fixture", latestMessage: latest)
    XCTAssertTrue(message.isRead)
    XCTAssertEqual(String(message.conversation.previewText.characters), String(entity.previewText.characters))
    source.sequence = "100000000000000000001"
    message = TeamSiriMessage(source, target: target, scope: scope, owner: "Fixture", latestMessage: latest)
    XCTAssertFalse(message.isRead)
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
    let store = AppStore(); store.server = server
    await store.connect(username: "", password: "")
    XCTAssertEqual(store.phase, .ready)
    var existing = Draft(); existing.text = "Keep existing draft"
    store.saveDraft(existing, channel: target.id)
    var draft = DraftTeamConversationMessageIntent()
    draft.store = store; draft.conversation = entity; draft.text = "Additional review notes"; draft.attachments = []
    _ = try await draft.perform()
    XCTAssertEqual(store.navigation.last, target.id)
    XCTAssertEqual(store.draft(target.id).text, "Keep existing draft\nAdditional review notes")
    let state = try await client.api.request("/__qa/state")
    XCTAssertEqual(state["messages"].array.filter { $0["content"].string == send.text }.count, 1)
    XCTAssertFalse(state["messages"].array.contains { $0["content"].string.contains(draft.text) })
    var other = session; other.userID = "other-account"; try SecureSession.save(other)
    do { _ = try await send.perform(); XCTFail("Sent to another account's conversation") } catch {}
    do { _ = try await draft.perform(); XCTFail("Drafted in another account's conversation") } catch {}
  }

  func testRepeatedSiriRecipientStillAddressesOneBot() async throws {
    guard #available(iOS 27.0, *) else { throw XCTSkip("Messaging schemas require iOS 27") }
    let client = try await SystemIntentClient.connect()
    let bot = try XCTUnwrap(client.bootstrap.bots.first)
    let person = TeamSiriPerson(bot, scope: scope)
    let target = try TeamSiriDestination.recipients([person, person]).resolve(client)
    XCTAssertEqual(target.id, bot.dmChannelId)
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

  func testSpotlightConversationPreviewRefreshesWithoutAChannelTimestampChange() async throws {
    guard #available(iOS 27.0, *) else { throw XCTSkip("Messaging schemas require iOS 27") }
    let client = try await SystemIntentClient.connect()
    var state = SavedState(); state.bootstrap = client.bootstrap
    let target = try XCTUnwrap(client.destinations.first { client.latestMessage(channelID: $0.id) != nil })
    let latest = try XCTUnwrap(client.latestMessage(channelID: target.id))
    let index = try XCTUnwrap(state.bootstrap?.latestMessages.firstIndex { $0.id == latest.id })
    state.bootstrap?.latestMessages[index].content = "Conversation preview before edit"
    UserDefaults.standard.set(true, forKey: "system-discovery-" + scope)
    SystemDiscovery.shared.update(session: session, state: state)
    await SystemDiscovery.shared.waitForPendingUpdates()
    XCTAssertNil(SystemDiscovery.shared.failure)
    try await assertConversationPreview(name: target.name, text: "Conversation preview before edit")
    state.bootstrap?.latestMessages[index].content = "Conversation preview after edit"
    SystemDiscovery.shared.update(session: session, state: state)
    await SystemDiscovery.shared.waitForPendingUpdates()
    try await assertConversationPreview(name: target.name, text: "Conversation preview after edit")
  }

  private func assertConversationPreview(name: String, text: String) async throws {
    for _ in 0..<20 {
      if try await Self.hasConversation(name: name, preview: text) { return }
      try await Task.sleep(for: .milliseconds(100))
    }
    XCTFail("Conversation preview was not reconciled: \(text)")
  }
  nonisolated private static func hasConversation(name: String, preview: String) async throws -> Bool {
    let query = CSSearchQuery(queryString: "title == '*'cd", attributes: ["title", "contentDescription"])
    for try await result in query.results where result.item.attributeSet.title == name {
      if result.item.attributeSet.contentDescription == preview { return true }
    }
    return false
  }
}
