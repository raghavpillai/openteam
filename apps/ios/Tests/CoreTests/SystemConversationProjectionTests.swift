import XCTest
@testable import OpenTeamCore

final class SystemConversationProjectionTests: XCTestCase {
  private func bootstrap() throws -> Bootstrap {
    let url = Bundle.module.url(forResource: "bootstrap", withExtension: "json", subdirectory: "Fixtures")!
    return try JSONDecoder().decode(Bootstrap.self, from: Data(contentsOf: url))
  }

  func testPreviewUsesLatestCommittedSequenceAndExcludesOtherChatsAndSystemEvents() throws {
    let data = try bootstrap()
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

  func testAttachmentOnlyPreviewUsesFilenameAndTextPreviewIsBounded() throws {
    var message = try XCTUnwrap(bootstrap().latestMessages.first)
    message.content = "brief.pdf"
    message.metadata = .object(["type": .string("attachment"), "attachment": .object([
      "assetId": .string("asset"), "fileName": .string("brief.pdf"), "mimeType": .string("application/pdf"),
      "byteSize": .number(12), "kind": .string("file")])])
    XCTAssertEqual(SystemConversationProjection.preview(message), "brief.pdf")
    message.content = String(repeating: "a", count: 1_500)
    XCTAssertEqual(SystemConversationProjection.preview(message).count, 1_000)
    XCTAssertEqual(SystemConversationProjection.preview(nil), "")
  }

  func testReadStateIsPerMessageEvenWhenItsConversationHasUnreadMessages() throws {
    let data = try bootstrap()
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
    var data = try bootstrap()
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
