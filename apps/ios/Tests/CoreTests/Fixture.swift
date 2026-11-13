import Foundation

@testable import OpenTeamCore

/// The shared `client-bootstrap` payload: Bots Research, Ops and Build, each with a direct chat.
enum Fixture {
  static func bootstrap() throws -> Bootstrap {
    let url = Bundle.module.url(forResource: "bootstrap", withExtension: "json", subdirectory: "Fixtures")!
    return try JSONDecoder().decode(Bootstrap.self, from: Data(contentsOf: url))
  }
  /// Research's first message, as a template row.
  static func message() throws -> Message { try bootstrap().latestMessages[0] }
}
