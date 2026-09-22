import XCTest
@testable import OpenTeamCore

final class ComputerVNCSessionTests: XCTestCase {
  private func grant(path: String = "/api/v0/bots/test-bot/screen/vnc", ticket: String? = nil) throws -> ComputerVNCSession {
    let data = try JSONEncoder().encode(JSON.object([
      "path": .string(path), "password": .string("disposable-vnc"),
      "protocols": .array([.string("openteam-vnc"), .string(ticket ?? "ticket." + String(repeating: "a", count: 43))]),
    ]))
    return try JSONDecoder().decode(ComputerVNCSession.self, from: data)
  }
  func testSelectedServerAndTLSArePreservedWithoutCredentialsInURL() throws {
    for (base, expected) in [
      ("http://100.94.42.50:8787", "ws://100.94.42.50:8787/api/v0/bots/test-bot/screen/vnc"),
      ("https://example.ts.net:10000", "wss://example.ts.net:10000/api/v0/bots/test-bot/screen/vnc"),
      ("https://example.test/team", "wss://example.test/team/api/v0/bots/test-bot/screen/vnc"),
    ] {
      let url = try grant().socketURL(api: API(server: base, token: "owner-secret"), botID: "test-bot")
      XCTAssertEqual(url.absoluteString, expected)
      XCTAssertNil(url.query)
      XCTAssertNil(url.password)
    }
  }
  func testRejectsCrossOriginWrongBotAndMalformedGrant() throws {
    let api = try API(server: "https://example.test")
    for path in ["https://attacker.test/api/v0/bots/test-bot/screen/vnc", "//attacker.test/vnc",
      "/api/v0/bots/another-bot/screen/vnc", "/api/v0/bots/test-bot/screen/vnc?password=secret"] {
      XCTAssertThrowsError(try grant(path: path).socketURL(api: api, botID: "test-bot"))
    }
    XCTAssertThrowsError(try grant(ticket: "ticket.bad").socketURL(api: api, botID: "test-bot"))
  }
}
