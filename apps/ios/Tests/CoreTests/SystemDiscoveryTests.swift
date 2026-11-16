import XCTest
@testable import OpenTeamCore

/// Spotlight index and Siri conversation projections.
final class SystemDiscoveryTests: XCTestCase {
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

  func testProjectionDeduplicatesAndUsesAuthoritativeBootstrapText() throws {
    var bootstrap = try Fixture.bootstrap()
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
    var bootstrap = try Fixture.bootstrap()
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
    bootstrap = try Fixture.bootstrap()
    bootstrap.latestMessages = []
    XCTAssertEqual(SystemDiscoverySnapshot(bootstrap: bootstrap,
      messages: [whole.channelId: [whole, fractional]]).messages.map(\.id), ["fractional", "whole"])
  }

  func testSystemEventsAndEmptyMessagesAreExcluded() throws {
    var bootstrap = try Fixture.bootstrap()
    var empty = bootstrap.latestMessages[0]
    empty.content = ""; empty.metadata = .object([:])
    var event = empty
    event.id = "event"; event.content = "Internal event"
    event.metadata = .object(["event": .object(["type": .string("name-changed")])])
    bootstrap.latestMessages = [empty, event]
    XCTAssertTrue(SystemDiscoverySnapshot(bootstrap: bootstrap, messages: [:]).messages.isEmpty)
  }

  func testPreviewUsesLatestCommittedSequenceAndExcludesOtherChatsAndSystemEvents() throws {
    let data = try Fixture.bootstrap()
    var earlier = try XCTUnwrap(data.latestMessages.first)
    earlier.sequence = "9"; earlier.content = "Older answer"; earlier.metadata = .object([:])
    var latest = earlier; latest.id = "latest"; latest.sequence = "10"; latest.content = "New answer"
    var event = latest; event.id = "event"; event.sequence = "11"
    event.metadata = .object(["event": .object(["type": .string("private-runtime-event")])])
    var other = latest; other.id = "other"; other.channelId = "another-chat"; other.sequence = "100"
    let result = SystemConversationProjection.latestMessage(in: [other, event, latest, earlier], channelID: earlier.channelId)
    XCTAssertEqual(result?.id, latest.id)
    XCTAssertEqual(SystemConversationProjection.preview(result), "New answer")
  }

  func testReadStateIsPerMessageEvenWhenItsConversationHasUnreadMessages() throws {
    let data = try Fixture.bootstrap()
    var channel = data.channels[0]
    channel.unreadCount = 2
    channel.notificationState = .object(["lastReadSequence": .string("100000000000000000000")])
    var message = try XCTUnwrap(data.latestMessages.first)
    message.channelId = channel.id; message.sequence = "99999999999999999999"
    XCTAssertTrue(SystemConversationProjection.isRead(message, channel: channel))
    message.sequence = "100000000000000000001"
    XCTAssertFalse(SystemConversationProjection.isRead(message, channel: channel))
    message.channelId = "different-channel"
    XCTAssertFalse(SystemConversationProjection.isRead(message, channel: channel))
  }

  func testConversationPreviewSurvivesTheGlobalMessageIndexLimit() throws {
    var data = try Fixture.bootstrap()
    var older = data.latestMessages[0]
    older.metadata = .object([:]); older.content = "Older chat preview"
    var newer = data.latestMessages[1]
    newer.metadata = .object([:])
    var cached: [String: [Message]] = [:]
    for group in 0..<11 {
      var channel = data.channels[0]
      channel.id = "recent-group-\(group)"; channel.kind = "group"; channel.name = channel.id
      data.channels.append(channel)
      cached[channel.id] = (0..<20).map { index in
        var value = newer; value.id = "recent-\(group)-\(index)"; value.channelId = channel.id
        value.sequence = String(index + 100); value.createdAt = "2026-11-05T12:00:00.000Z"
        return value
      }
    }
    data.latestMessages = [older]
    let snapshot = SystemDiscoverySnapshot(bootstrap: data, messages: cached)
    XCTAssertEqual(snapshot.messages.count, SystemDiscoverySnapshot.messageLimit)
    XCTAssertFalse(snapshot.messages.contains { $0.id == older.id })
    XCTAssertEqual(snapshot.latestMessages[older.channelId]?.content, "Older chat preview")
    XCTAssertEqual(snapshot.latestMessages["recent-group-0"]?.sequence, "119")
  }
}
