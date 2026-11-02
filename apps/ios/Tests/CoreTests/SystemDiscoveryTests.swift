import XCTest
@testable import OpenTeamCore

final class SystemDiscoveryTests: XCTestCase {
  private func fixture() throws -> Bootstrap {
    let url = Bundle.module.url(forResource: "bootstrap", withExtension: "json", subdirectory: "Fixtures")!
    return try JSONDecoder().decode(Bootstrap.self, from: Data(contentsOf: url))
  }

  func testIdentifiersRoundTripWithoutDelimiterOrUnicodeAmbiguity() {
    let id = SystemEntityID(scope: "scope", kind: .message, channelID: "a/b:📨", localID: "m/?=\n")
    XCTAssertEqual(SystemEntityID(id.value), id)
    for value in ["", "not-base64", Data("[]".utf8).base64EncodedString(),
      Data(#"["scope","unknown","channel","id"]"#.utf8).base64EncodedString(),
      Data(#"["scope","message","","id"]"#.utf8).base64EncodedString(),
      String(repeating: "a", count: 8_192)] {
      XCTAssertNil(SystemEntityID(value))
    }
  }

  func testSavedIdentifiersCannotCrossAccountsServersOrKinds() {
    let scope = SystemEntityID.scope(server: "https://one.invalid", userID: "owner")
    let id = SystemEntityID(scope: scope, kind: .bot, channelID: "same", localID: "same")
    XCTAssertTrue(id.matches(scope: scope, kind: .bot))
    XCTAssertFalse(id.matches(scope: SystemEntityID.scope(server: "https://two.invalid", userID: "owner"), kind: .bot))
    XCTAssertFalse(id.matches(scope: SystemEntityID.scope(server: "https://one.invalid", userID: "another"), kind: .bot))
    XCTAssertFalse(id.matches(scope: scope, kind: .message))
  }

  func testHiddenArchivedAndRemovedConversationsAreNotDonated() throws {
    var bootstrap = try fixture()
    let hidden = bootstrap.bots[0].dmChannelId
    let archived = bootstrap.bots[1].dmChannelId
    bootstrap.bots[0].hiddenFromSidebar = true
    bootstrap.bots[1].status = "archived"
    var cached = Dictionary(grouping: bootstrap.latestMessages, by: \.channelId)
    var removed = bootstrap.latestMessages[0]
    removed.channelId = "removed-channel"
    cached[removed.channelId] = [removed]
    let projection = SystemDiscoverySnapshot(bootstrap: bootstrap, messages: cached)
    XCTAssertFalse(projection.destinations.contains { [hidden, archived, "removed-channel"].contains($0.id) })
    XCTAssertFalse(projection.messages.contains { [hidden, archived, "removed-channel"].contains($0.channelId) })
  }

  func testProjectionDeduplicatesAndUsesAuthoritativeBootstrapText() throws {
    var bootstrap = try fixture()
    var message = bootstrap.latestMessages[0]
    message.content = "Old cached text"
    bootstrap.latestMessages = [message]
    bootstrap.latestMessages[0].content = "Updated on the server"
    let projection = SystemDiscoverySnapshot(bootstrap: bootstrap,
      messages: [message.channelId: [message, message]])
    XCTAssertEqual(projection.messages.count, 1)
    XCTAssertEqual(projection.messages[0].content, "Updated on the server")
    bootstrap.channels.removeAll { $0.id == message.channelId }
    XCTAssertTrue(SystemDiscoverySnapshot(bootstrap: bootstrap, messages: [message.channelId: [message]]).messages.isEmpty)
  }

  func testIndexHasGlobalAndPerConversationBoundsAndActualDateOrdering() throws {
    var bootstrap = try fixture()
    let template = bootstrap.channels[0]
    let sample = bootstrap.latestMessages[0]
    bootstrap.latestMessages = []
    bootstrap.channels = []
    var cached: [String: [Message]] = [:]
    for channelIndex in 0..<40 {
      var channel = template
      channel.id = "channel-\(channelIndex)"
      channel.kind = "group"
      bootstrap.channels.append(channel)
      cached[channel.id] = (0..<50).map { index in
        var message = sample
        message.id = "\(channelIndex)-\(index)"
        message.channelId = channel.id
        message.createdAt = String(format: "2026-10-01T12:00:%02d.000Z", index)
        message.metadata = .object([:])
        return message
      }
    }
    let projection = SystemDiscoverySnapshot(bootstrap: bootstrap, messages: cached)
    XCTAssertEqual(projection.destinations.count, 30)
    XCTAssertEqual(projection.messages.count, 200)
    XCTAssertTrue(Dictionary(grouping: projection.messages, by: \.channelId).values.allSatisfy { $0.count <= 20 })

    var whole = sample
    whole.id = "whole"; whole.createdAt = "2026-10-01T12:00:00Z"; whole.metadata = .object([:])
    var fractional = whole
    fractional.id = "fractional"; fractional.createdAt = "2026-10-01T12:00:00.900Z"
    bootstrap = try fixture()
    bootstrap.latestMessages = []
    XCTAssertEqual(SystemDiscoverySnapshot(bootstrap: bootstrap,
      messages: [whole.channelId: [whole, fractional]]).messages.map(\.id), ["fractional", "whole"])
  }

  func testSystemEventsAndEmptyMessagesAreExcluded() throws {
    var bootstrap = try fixture()
    var empty = bootstrap.latestMessages[0]
    empty.content = ""; empty.metadata = .object([:])
    var event = empty
    event.id = "event"; event.content = "Internal event"
    event.metadata = .object(["event": .object(["type": .string("name-changed")])])
    bootstrap.latestMessages = [empty, event]
    XCTAssertTrue(SystemDiscoverySnapshot(bootstrap: bootstrap, messages: [:]).messages.isEmpty)
  }
}
