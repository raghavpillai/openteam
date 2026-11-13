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
  private let uploadProgress: (@Sendable (Int64) -> Void)?
  init(uploadProgress: (@Sendable (Int64) -> Void)? = nil) {
    self.uploadProgress = uploadProgress
  }
  func urlSession(
    _ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
    totalBytesSent: Int64, totalBytesExpectedToSend: Int64
  ) {
    uploadProgress?(totalBytesSent)
  }
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest
  ) async -> URLRequest? { nil }
}

public struct API: Sendable {
  public let resourceGeneration = UUID()
  public let baseURL: URL
  public let token: String?
  private let session: URLSession
  private let onReachable: (@Sendable () async -> Void)?
  public init(
    server: String, token: String? = nil, session: URLSession? = nil, timeout: TimeInterval = 35,
    onReachable: (@Sendable () async -> Void)? = nil
  ) throws {
    self.baseURL = try Self.normalize(server)
    self.token = token
    self.onReachable = onReachable
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
  /// Only the selected server receives authorization. No server redirect is followed.
  public func presentationImage(_ source: String) async throws -> Data {
    let deadline = ContinuousClock.now.advanced(by: .seconds(25))
    for attempt in 0..<12 {
      try Task.checkCancellation()
      let remaining = ContinuousClock.now.duration(to: deadline)
      guard remaining > .zero else { throw URLError(.timedOut) }
      let parts = remaining.components
      let timeout = min(15, Double(parts.seconds) + Double(parts.attoseconds) / 1e18)
      do { return try await presentationImageAttempt(source, timeout: timeout) }
      catch let error as APIError where error.status == 503 && attempt < 11 {
        try await Task.sleep(for: min(.seconds(1), max(.zero, ContinuousClock.now.duration(to: deadline))))
      }
    }
    throw APIError("Image unavailable.")
  }
  private func presentationImageAttempt(_ source: String, timeout: TimeInterval) async throws -> Data {
    guard source.utf8.count <= 8192, let url = URL(string: source),
      url.scheme == "https", url.user == nil, url.password == nil else { throw APIError("Invalid image.") }
    let limit = 5 * 1024 * 1024
    #if canImport(FoundationNetworking)
      let (data, response) = try await raw("/api/v0/presentation-image", query: ["url": source], timeout: timeout)
      guard data.count <= limit, ["image/png", "image/jpeg", "image/webp"].contains(response.mimeType ?? "") else { throw APIError("Invalid image.") }
      return data
    #else
      var request = URLRequest(url: self.url("/api/v0/presentation-image", query: ["url": source]))
      request.setValue("image/png,image/jpeg,image/webp", forHTTPHeaderField: "Accept")
      if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
      let configuration = session.configuration
      configuration.httpShouldSetCookies = false
      configuration.urlCache = nil
      configuration.timeoutIntervalForRequest = timeout
      configuration.timeoutIntervalForResource = timeout
      // A dedicated session bounds the resource deadline and disables redirects.
      let bounded = URLSession(configuration: configuration, delegate: RedirectPolicy(), delegateQueue: nil)
      defer { bounded.invalidateAndCancel() }
      let (bytes, response) = try await bounded.bytes(for: request)
      if let http = response as? HTTPURLResponse, http.statusCode == 503,
        http.value(forHTTPHeaderField: "Retry-After") == "1" {
        throw APIError("Image busy.", status: 503)
      }
      guard let http = response as? HTTPURLResponse, http.statusCode == 200,
        ["image/png", "image/jpeg", "image/webp"].contains(http.mimeType ?? ""),
        http.expectedContentLength <= Int64(limit) else { throw APIError("Invalid image.") }
      var data = Data()
      for try await byte in bytes {
        if data.count >= limit { throw APIError("Invalid image.") }
        data.append(byte)
      }
      try Task.checkCancellation()
      return data
    #endif
  }

  public func signOut() async throws {
    // Better Auth rejects bodyless POSTs with 415; send an explicit JSON object.
    _ = try await request("/api/auth/sign-out", method: "POST", body: .object([:]))
  }

  /// Adds the scheme people leave off when copying a server address. Addresses on a
  /// home network or VPN (IPs, localhost, .local, and single-word names) usually
  /// serve plain HTTP, and so does an explicit port other than 443 (for example a
  /// Tailscale name such as box.tail1234.ts.net:8788); other domain names usually
  /// serve HTTPS. Same rule as client-core's `withDefaultScheme`.
  public static func withDefaultScheme(_ value: String) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty
      || trimmed.range(of: #"^[A-Za-z][A-Za-z0-9+.-]*://"#, options: .regularExpression) != nil
    {
      return trimmed
    }
    let authority = String(trimmed.prefix { !"/?#".contains($0) })
    let host: String
    var port: Substring
    if authority.hasPrefix("["), let bracket = authority.firstIndex(of: "]") {
      host = String(authority[...bracket]).lowercased()
      port = authority[authority.index(after: bracket)...]
    } else {
      let name = authority.prefix { $0 != ":" }
      host = name.lowercased()
      port = authority[name.endIndex...]
    }
    if port.hasPrefix(":") { port = port.dropFirst() }
    let local =
      host.hasPrefix("[") || host == "localhost" || host.hasSuffix(".local")
      || !host.contains(".")
      || host.range(of: #"^\d{1,3}(\.\d{1,3}){3}$"#, options: .regularExpression) != nil
    return (local || (!port.isEmpty && port != "443") ? "http://" : "https://") + trimmed
  }

  public static func normalize(_ server: String) throws -> URL {
    let s = withDefaultScheme(server)
    guard let c = URLComponents(string: s),
      ["http", "https"].contains(c.scheme?.lowercased() ?? ""),
      let host = c.host, !host.isEmpty
    else {
      throw APIError(
        "Enter your server address, such as 192.168.1.20:8787 or https://openteam.example.com."
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
    _ path: String, method: String = "GET", body: JSON? = nil, query: [String: String] = [:],
    timeout: TimeInterval? = nil
  ) async throws -> JSON {
    let (data, _) = try await raw(
      path, method: method, data: try body.map { try JSONEncoder().encode($0) }, query: query,
      timeout: timeout)
    if data.isEmpty { return .object([:]) }
    do { return try JSONDecoder().decode(JSON.self, from: data) } catch {
      throw APIError("The server returned an invalid response.")
    }
  }
  public func get<T: Decodable & Sendable>(
    _ path: String, as type: T.Type, query: [String: String] = [:], timeout: TimeInterval? = nil
  ) async throws -> T {
    let (data, _) = try await raw(path, query: query, timeout: timeout)
    return try JSONDecoder().decode(type, from: data)
  }
  public func raw(
    _ path: String, method: String = "GET", data: Data? = nil,
    contentType: String = "application/json", query: [String: String] = [:],
    headers: [String: String] = [:], timeout: TimeInterval? = nil,
    uploadProgress: (@Sendable (Int64) -> Void)? = nil
  ) async throws -> (Data, HTTPURLResponse) {
    var request = URLRequest(url: url(path, query: query))
    request.httpMethod = method
    request.httpBody = data
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if data != nil { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
    // ASR allows 120 seconds on the server. Both URLSession deadlines need an
    // override; changing only URLRequest still hits the ordinary resource limit.
    var dedicatedSession: URLSession?
    if timeout != nil || uploadProgress != nil {
      let configuration = session.configuration
      if let timeout {
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        request.timeoutInterval = timeout
      }
      dedicatedSession = URLSession(
        configuration: configuration, delegate: RedirectPolicy(uploadProgress: uploadProgress),
        delegateQueue: nil)
    }
    defer { dedicatedSession?.finishTasksAndInvalidate() }
    let result: Data
    let response: URLResponse
    if uploadProgress != nil, let data {
      request.httpBody = nil
      (result, response) = try await (dedicatedSession ?? session).upload(for: request, from: data)
    } else {
      (result, response) = try await (dedicatedSession ?? session).data(for: request)
    }
    guard let http = response as? HTTPURLResponse else {
      throw APIError("The server returned an invalid response.")
    }
    // A response can prove reachability even when its payload cannot be decoded
    // or the requested action is rejected. Server failures need a separate check.
    if http.statusCode < 500, !Task.isCancelled { await onReachable?() }
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
  public func send(
    channel: Channel, bot: Bot?, input: SendInput, timeout: TimeInterval? = nil
  ) async throws -> Message {
    let path =
      bot.map { "/api/v0/conversations/\(Self.segment($0.conversationId))/messages" }
      ?? "/api/v0/channels/\(Self.segment(channel.id))/messages"
    let result = try await request(path, method: "POST", body: .encode(input), timeout: timeout)
    return try result["message"].decode(Message.self)
  }
}
