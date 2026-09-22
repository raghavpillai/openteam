import Foundation

public struct ComputerVNCSession: Decodable, Sendable {
  public let path: String
  public let protocols: [String]
  public let password: String

  public func socketURL(api: API, botID: String) throws -> URL {
    let expected = "/api/v0/bots/\(API.segment(botID))/screen/vnc"
    guard path == expected, protocols.count == 2, protocols[0] == "openteam-vnc",
      protocols[1].range(of: #"^ticket\.[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil,
      !password.isEmpty else { throw APIError("The computer returned an invalid connection grant.") }
    var url = URLComponents(url: api.url(path), resolvingAgainstBaseURL: false)!
    url.scheme = api.baseURL.scheme == "https" ? "wss" : "ws"
    guard let result = url.url else { throw APIError("Invalid computer address.") }
    return result
  }
}
