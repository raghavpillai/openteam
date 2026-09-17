import XCTest

@testable import OpenTeamCore

final class ProtocolTests: XCTestCase {
  func fixture() throws -> Bootstrap {
    let url = Bundle.module.url(
      forResource: "bootstrap", withExtension: "json", subdirectory: "Fixtures")!
    return try JSONDecoder().decode(Bootstrap.self, from: Data(contentsOf: url))
  }
  func testDecodesExistingReactNativeFixture() throws {
    let snapshot = try fixture()
    XCTAssertEqual(snapshot.bots.count, 3)
    XCTAssertEqual(snapshot.latestMessages.count, 7)
    XCTAssertEqual(snapshot.bots[0].dmChannelId, "channel-research")
    XCTAssertEqual(snapshot.latestMessages[1].replyTo, "message-1")
    XCTAssertEqual(snapshot.pendingApprovals[0].status, "pending")
  }
  func testThreadAncestryHandlesUnorderedNestedCyclicAndMissingReplies() throws {
    var root = try fixture().latestMessages[0]
    root.id = "root"
    root.metadata = .object([:])
    func reply(_ id: String, to parent: String, branched: Bool = true) -> Message {
      var m = root
      m.id = id
      m.metadata = .object(["branched": .bool(branched), "replyTo": .string(parent)])
      return m
    }
    let rows = [
      reply("b", to: "a"), reply("missing", to: "gone"), reply("cycle1", to: "cycle2"),
      reply("cycle2", to: "cycle1"), reply("quoted", to: "root", branched: false),
      reply("a", to: "root"),
    ]
    XCTAssertEqual(ThreadProjection.messages(root: root, in: rows).map(\.id), ["root", "a", "b"])
  }
  func testServerValidationAndSubpathRouting() throws {
    let api = try API(server: " HTTPS://Example.com/team/// ")
    XCTAssertEqual(api.baseURL.absoluteString, "https://example.com/team")
    XCTAssertEqual(
      api.url("/api/v0/search", query: ["q": "cats & dogs"]).path, "/team/api/v0/search")
    XCTAssertEqual(
      URLComponents(url: api.url("/x", query: ["q": "a&b"]), resolvingAgainstBaseURL: false)?
        .queryItems?.first?.value, "a&b")
    for invalid in [
      "", "example.com", "file:///tmp", "https://user:secret@example.com",
      "https://example.com?token=x", "https://example.com#x", "http://",
    ] {
      XCTAssertThrowsError(try API(server: invalid), invalid)
    }
    XCTAssertEqual(API.segment("a/b?c"), "a%2Fb%3Fc")
  }
  func testProductionUUIDRoutesPreserveIdentifiersAndEscapeReservedCharacters() throws {
    let api = try API(server: "http://127.0.0.1:20007")
    let id = "eb954d92-c40a-48a9-847c-c362d0ca5073"
    XCTAssertEqual(
      api.url("/api/v0/conversations/\(API.segment(id))/messages").absoluteString,
      "http://127.0.0.1:20007/api/v0/conversations/\(id)/messages")
    XCTAssertEqual(API.segment("id-._~"), "id-._~")
    XCTAssertEqual(API.segment("é /?#%"), "%C3%A9%20%2F%3F%23%25")
  }
  func testServerEchoReconcilesByNonceWithoutDuplicating() throws {
    var message = try fixture().latestMessages[0]
    message.id = "local"
    message.clientId = "persistent-client-id"
    var echoed = message
    echoed.id = "server"
    echoed.sequence = "20"
    let merged = MessageMerge.merge([message], [echoed, echoed])
    XCTAssertEqual(merged.count, 1)
    XCTAssertEqual(merged[0].id, "server")
  }
  func testSequenceOrderingDoesNotLosePrecision() {
    XCTAssertTrue(MessageMerge.less("9007199254740992", "9007199254740993"))
    XCTAssertTrue(MessageMerge.less("9999999999999999999999", "10000000000000000000000"))
    XCTAssertFalse(MessageMerge.less("0003", "3"))
    XCTAssertTrue(MessageMerge.less("9", "10"))
  }
  func testOutboxNonceReplyAndDraftSurviveRestartAndStayIsolated() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: dir) }
    let store = try DiskStore(directory: dir, scope: "account-a")
    var state = SavedState()
    state.bootstrap = try fixture()
    state.sidebar = .object(["pinnedIds": .array([.string("channel-research")])])
    var draft = Draft()
    draft.text = "Unsent text"
    draft.replyTo = "message-1"
    state.drafts["channel-research"] = draft
    let input = SendInput(
      content: "Queued", clientId: "nonce-unchanged", replyToMessageId: "message-1", isFork: true)
    state.outbox.append(
      PendingSend(
        channelId: "channel-research", input: input, draftKey: "channel-research:thread:message-1"))
    try store.save(state)
    let loaded = try DiskStore(directory: dir, scope: "account-a").load()
    XCTAssertEqual(loaded.outbox[0].input, input)
    XCTAssertEqual(loaded.outbox[0].draftKey, "channel-research:thread:message-1")
    XCTAssertEqual(loaded.drafts["channel-research"], draft)
    XCTAssertEqual(loaded.sidebar, state.sidebar)
    XCTAssertNil(try DiskStore(directory: dir, scope: "account-b").load().sidebar)
    XCTAssertTrue(try DiskStore(directory: dir, scope: "account-b").load().outbox.isEmpty)
    try store.clear()
    XCTAssertNil(try store.load().bootstrap)
  }
  func testUnknownMetadataRoundTripsWithoutInventedValues() throws {
    let json = try JSONDecoder().decode(
      JSON.self,
      from: Data(
        #"{"type":"future-card","revision":"9999999999999999999","enabled":false,"fields":[null,2,"x"]}"#
          .utf8))
    XCTAssertEqual(try JSONDecoder().decode(JSON.self, from: JSONEncoder().encode(json)), json)
    XCTAssertEqual(json["revision"].string, "9999999999999999999")
    XCTAssertFalse(json["enabled"].bool)
    XCTAssertEqual(json["missing"], .null)
  }
}
