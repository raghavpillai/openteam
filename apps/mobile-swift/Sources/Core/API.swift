import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

public struct APIError: Error, LocalizedError, Sendable {
  public let status: Int
  public let message: String
  public var errorDescription: String? { message }
  public init(_ message: String, status: Int = 0) {
    self.status = status
    self.message = UserFacingError.redact(message)
  }
  public var unauthorized: Bool { status == 401 }
}

/// No cookies or cross-origin redirects: the selected server alone receives the bearer token.
final class RedirectPolicy: NSObject, URLSessionTaskDelegate, Sendable {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest
  ) async -> URLRequest? { nil }
}

public struct API: Sendable {
  public let baseURL: URL
  public let token: String?
  private let session: URLSession
  public init(
    server: String, token: String? = nil, session: URLSession? = nil, timeout: TimeInterval = 35
  ) throws {
    self.baseURL = try Self.normalize(server)
    self.token = token
    if let session {
      self.session = session
    } else {
      let configuration = URLSessionConfiguration.ephemeral
      configuration.httpShouldSetCookies = false
      configuration.urlCache = nil
      configuration.timeoutIntervalForRequest = timeout
      configuration.timeoutIntervalForResource = timeout < 35 ? max(timeout, 15) : max(timeout, 60)
      self.session = URLSession(
        configuration: configuration, delegate: RedirectPolicy(), delegateQueue: nil)
    }
  }
  public static func normalize(_ server: String) throws -> URL {
    let s = server.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let c = URLComponents(string: s),
      ["http", "https"].contains(c.scheme?.lowercased() ?? ""),
      let host = c.host, !host.isEmpty
    else {
      throw APIError(
        "Enter a server address starting with http:// or https://, such as https://openteam.example.com."
      )
    }
    guard c.user == nil, c.password == nil else {
      throw APIError(
        "Remove the username and password from the server address. You’ll sign in on the next screen."
      )
    }
    guard c.query == nil, c.fragment == nil else {
      throw APIError("Use the server address without anything after ? or #.")
    }
    var normalized = c
    normalized.scheme = c.scheme?.lowercased()
    normalized.host = host.lowercased()
    while normalized.path.hasSuffix("/") { normalized.path.removeLast() }
    guard let result = normalized.url else { throw APIError("Enter a valid server URL.") }
    return result
  }
  public static func segment(_ id: String) -> String {
    // Preserve RFC 3986 unreserved characters, including the hyphens in server UUIDs.
    // Escaping those hyphens changes route parameters on the production router.
    let unreserved = CharacterSet(
      charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    return id.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
  }
  public func url(_ path: String, query: [String: String] = [:]) -> URL {
    var c = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
    c.percentEncodedPath += path
    if !query.isEmpty {
      c.queryItems = query.sorted { $0.key < $1.key }.map {
        URLQueryItem(name: $0.key, value: $0.value)
      }
    }
    return c.url!
  }
  public func request(
    _ path: String, method: String = "GET", body: JSON? = nil, query: [String: String] = [:]
  ) async throws -> JSON {
    let (data, _) = try await raw(
      path, method: method, data: try body.map { try JSONEncoder().encode($0) }, query: query)
    if data.isEmpty { return .object([:]) }
    do { return try JSONDecoder().decode(JSON.self, from: data) } catch {
      throw APIError("The server returned an invalid response.")
    }
  }
  public func get<T: Decodable & Sendable>(
    _ path: String, as type: T.Type, query: [String: String] = [:]
  ) async throws -> T {
    let (data, _) = try await raw(path, query: query)
    return try JSONDecoder().decode(type, from: data)
  }
  public func raw(
    _ path: String, method: String = "GET", data: Data? = nil,
    contentType: String = "application/json", query: [String: String] = [:],
    headers: [String: String] = [:]
  ) async throws -> (Data, HTTPURLResponse) {
    var request = URLRequest(url: url(path, query: query))
    request.httpMethod = method
    request.httpBody = data
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if data != nil { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
    let (result, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw APIError("The server returned an invalid response.")
    }
    guard (200..<300).contains(http.statusCode) else {
      let json = (try? JSONDecoder().decode(JSON.self, from: result)) ?? .null
      let message = [json["error"]["message"].string, json["message"].string].first {
        !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      }
      throw APIError(
        message
          ?? UserFacingError.fallback(status: http.statusCode, signingIn: path == "/api/auth/login"),
        status: http.statusCode)
    }
    return (result, http)
  }
  public func signIn(username: String, password: String) async throws -> (token: String, user: JSON)
  {
    let body: JSON = .object([
      "username": .string(username.trimmingCharacters(in: .whitespacesAndNewlines)),
      "password": .string(password), "rememberMe": .bool(true),
    ])
    let (data, response) = try await raw(
      "/api/auth/login", method: "POST", data: JSONEncoder().encode(body))
    guard
      let token = response.value(forHTTPHeaderField: "set-auth-token")?.trimmingCharacters(
        in: .whitespacesAndNewlines), !token.isEmpty
    else {
      throw APIError(
        "The server did not complete sign-in. Please try again or contact your server administrator."
      )
    }
    return (token, try JSONDecoder().decode(JSON.self, from: data)["user"])
  }
  public func validateServer() async throws -> String {
    do {
      let config = try await request("/api/auth/config")
      guard ["required", "disabled"].contains(config["mode"].string) else {
        throw APIError("This address is reachable, but it is not a compatible OpenTeam server.")
      }
      return config["mode"].string
    } catch let error as APIError {
      if error.status >= 500 {
        throw APIError(
          "The OpenTeam server is temporarily unavailable. Please try again shortly.",
          status: error.status)
      }
      if error.status > 0 || error.message == "The server returned an invalid response." {
        throw APIError(
          "This address is reachable, but it is not a compatible OpenTeam server.",
          status: error.status)
      }
      throw error
    }
  }
  public func send(channel: Channel, bot: Bot?, input: SendInput) async throws -> Message {
    let path =
      bot.map { "/api/v0/conversations/\(Self.segment($0.conversationId))/messages" }
      ?? "/api/v0/channels/\(Self.segment(channel.id))/messages"
    let result = try await request(path, method: "POST", body: .encode(input))
    return try result["message"].decode(Message.self)
  }
}
