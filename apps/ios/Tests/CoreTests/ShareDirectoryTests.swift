import XCTest

@testable import OpenTeamCore

final class ShareDirectoryTests: XCTestCase {
  /// Bots Research, Ops and Build, each with a direct chat.
  private func bootstrap() throws -> Bootstrap {
    let url = Bundle.module.url(forResource: "bootstrap", withExtension: "json", subdirectory: "Fixtures")!
    var bootstrap = try JSONDecoder().decode(Bootstrap.self, from: Data(contentsOf: url))
    bootstrap.latestMessages = []
    for index in bootstrap.channels.indices { bootstrap.channels[index].updatedAt = "2026-10-01T09:00:00.000Z" }
    return bootstrap
  }

  func testOnlyBotChatsAndGroupsCanBeShareTargets() throws {
    var data = try bootstrap()
    data.bots.removeAll { $0.id == "bot-ops" }
    var other = data.channels[0]
    other.id = "channel-other"
    other.kind = "system"
    data.channels.append(other)
    XCTAssertEqual(ShareDirectory.destinations(data).map(\.id), ["channel-research", "channel-build"])
  }
}
