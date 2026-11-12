import AppIntents
import CoreSpotlight
import CoreTransferable
import UniformTypeIdentifiers
import XCTest
@testable import OpenTeamNative

@MainActor
final class SiriConversationTests: SystemIntentFixture {
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
