import Foundation
import XCTest

@testable import OpenTeamCore

private func requestBody(_ request: URLRequest) throws -> Data {
  if let data = request.httpBody { return data }
  let stream = try XCTUnwrap(request.httpBodyStream)
  stream.open()
  defer { stream.close() }
  var data = Data()
  var buffer = [UInt8](repeating: 0, count: 4096)
  while true {
    let count = stream.read(&buffer, maxLength: buffer.count)
    if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
    if count == 0 { return data }
    data.append(contentsOf: buffer.prefix(count))
  }
}

private final class RequestStub: @unchecked Sendable {
  let lock = NSLock()
  private var callback: (@Sendable (URLRequest) throws -> (Int, [String: String], Data))?
  func set(_ callback: @escaping @Sendable (URLRequest) throws -> (Int, [String: String], Data)) {
    lock.lock()
    defer { lock.unlock() }
    self.callback = callback
  }
  func run(_ request: URLRequest) throws -> (Int, [String: String], Data) {
    lock.lock()
    let f = callback
    lock.unlock()
    return try f!(request)
  }
}
private final class MockProtocol: URLProtocol, @unchecked Sendable {
  static let stub = RequestStub()
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    do {
      let (status, headers, data) = try Self.stub.run(request)
      client?.urlProtocol(
        self,
        didReceive: HTTPURLResponse(
          url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!,
        cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}

final class TransportTests: XCTestCase, @unchecked Sendable {
  func testNativeSignInFailureMessagesAndRequiredHeader() async throws {
    for (status, fragment) in [(401, "username or password"), (403, "cannot sign in"), (429, "Too many sign-in attempts"), (503, "try again shortly")] {
      MockProtocol.stub.set { _ in (status, [:], Data("{}".utf8)) }
      do { _ = try await api().signIn(username: "owner", password: "fixture"); XCTFail("Must reject failed login") }
      catch { XCTAssertTrue(error.localizedDescription.contains(fragment), error.localizedDescription) }
    }
    MockProtocol.stub.set { _ in (200, [:], Data(#"{"user":{"id":"owner"}}"#.utf8)) }
    do { _ = try await api().signIn(username: "owner", password: "fixture"); XCTFail("A response without the session header is not authentication") }
    catch { XCTAssertTrue(error.localizedDescription.contains("did not complete sign-in")) }
  }
  func testStrictServerDiscoveryRejectsReachableNonOpenTeamEndpoints() async throws {
    for body in ["<html>Sign in</html>", "{}", #"{"mode":"unknown"}"#] {
      MockProtocol.stub.set { _ in (200, [:], Data(body.utf8)) }
      do { _ = try await api().validateServer(); XCTFail("Must reject incompatible endpoint") }
      catch { XCTAssertTrue(error.localizedDescription.contains("not a compatible OpenTeam")) }
    }
    MockProtocol.stub.set { _ in (503, [:], Data()) }
    do { _ = try await api().validateServer(); XCTFail("Unavailable is not disabled authentication") }
    catch { XCTAssertTrue(error.localizedDescription.contains("temporarily unavailable")) }
    for mode in ["required", "disabled"] {
      MockProtocol.stub.set { _ in (200, [:], Data("{\"mode\":\"\(mode)\"}".utf8)) }
      let result = try await api().validateServer(); XCTAssertEqual(result, mode)
    }
  }
  func testRecoverableNetworkErrorsAndCredentialRedaction() {
    XCTAssertTrue(UserFacingError.message(URLError(.timedOut)).contains("too long"))
    XCTAssertTrue(UserFacingError.message(URLError(.notConnectedToInternet)).contains("Check the address"))
    XCTAssertTrue(UserFacingError.message(URLError(.serverCertificateUntrusted)).contains("certificate"))
    XCTAssertTrue(UserFacingError.isCancelled(URLError(.cancelled)))
    let value = UserFacingError.redact("Bearer example-secret PASSWORD=hidden https://owner:private@example.invalid {\"token\":\"secret-value\"}")
    for secret in ["example-secret", "hidden", "private", "secret-value"] { XCTAssertFalse(value.contains(secret)) }
    XCTAssertTrue(value.contains("[REDACTED]"))
  }
  func api(token: String? = nil) throws -> API {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [MockProtocol.self]
    return try API(
      server: "https://fixture.invalid/team", token: token,
      session: URLSession(configuration: config))
  }
  func testLoginUsesUsernameProtocolAndHeaderToken() async throws {
    MockProtocol.stub.set { request in
      XCTAssertEqual(request.url?.path, "/team/api/auth/login")
      XCTAssertEqual(request.httpMethod, "POST")
      XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
      let body = try JSONDecoder().decode(JSON.self, from: requestBody(request))
      XCTAssertEqual(body["username"].string, "owner")
      XCTAssertEqual(body["password"].string, "fixture-only")
      XCTAssertTrue(body["rememberMe"].bool)
      return (
        200, ["set-auth-token": "fixture-session"],
        Data(#"{"user":{"id":"owner","name":"Owner"}}"#.utf8)
      )
    }
    let result = try await api().signIn(username: " owner ", password: "fixture-only")
    XCTAssertEqual(result.token, "fixture-session")
    XCTAssertEqual(result.user["id"].string, "owner")
  }
  func testAuthenticatedRequestAnd401AreNotTreatedAsOfflineSuccess() async throws {
    MockProtocol.stub.set { request in
      XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-session")
      return (401, [:], Data(#"{"error":{"message":"Expired"}}"#.utf8))
    }
    do {
      _ = try await api(token: "fixture-session").request("/api/v0/client-bootstrap")
      XCTFail("401 must fail")
    } catch let error as APIError {
      XCTAssertTrue(error.unauthorized)
      XCTAssertEqual(error.message, "Expired")
    }
  }
  func testSuccessfulMalformedJSONFailsAndEmpty204Succeeds() async throws {
    MockProtocol.stub.set { _ in (200, [:], Data("not-json".utf8)) }
    do {
      _ = try await api().request("/x")
      XCTFail("Malformed response must fail")
    } catch let error as APIError {
      XCTAssertEqual(error.message, "The server returned an invalid response.")
    }
    MockProtocol.stub.set { _ in (204, [:], Data()) }
    let result = try await api().request("/x", method: "DELETE")
    XCTAssertEqual(result, .object([:]))
  }
  func testDirectAndGroupSendUseDifferentServerRoutesWithStableNonce() async throws {
    let url = Bundle.module.url(
      forResource: "bootstrap", withExtension: "json", subdirectory: "Fixtures")!
    let fixture = try JSONDecoder().decode(Bootstrap.self, from: Data(contentsOf: url))
    let message = fixture.latestMessages[0]
    let encoded = try JSONEncoder().encode(JSON.object(["message": .encode(message)]))
    let input = SendInput(
      content: "Hello", clientId: "stable-nonce", replyToMessageId: "message-1", isFork: true)
    for direct in [true, false] {
      MockProtocol.stub.set { request in
        XCTAssertEqual(
          request.url?.path,
          direct
            ? "/team/api/v0/conversations/conversation-research/messages"
            : "/team/api/v0/channels/channel-research/messages")
        let body = try JSONDecoder().decode(SendInput.self, from: requestBody(request))
        XCTAssertEqual(body, input)
        return (200, [:], encoded)
      }
      let result = try await api().send(
        channel: fixture.channels[0], bot: direct ? fixture.bots[0] : nil, input: input)
      XCTAssertEqual(result.id, message.id)
    }
  }
  func testStagedFilesSurviveRestartsAndDoNotAllowPathTraversal() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let disk = try DiskStore(directory: root, scope: "fixture-owner")
    let bytes = Data("offline attachment".utf8)
    let file = try disk.stage(bytes, fileName: "notes.txt", mimeType: "text/plain")
    var state = SavedState()
    var draft = Draft()
    draft.stagedFiles = [file]
    state.drafts["channel"] = draft
    try disk.save(state)
    let reopened = try DiskStore(directory: root, scope: "fixture-owner")
    let recovered = try reopened.load().drafts["channel"]!.stagedFiles![0]
    XCTAssertEqual(try Data(contentsOf: reopened.fileURL(recovered)), bytes)
    var malformed = recovered
    malformed.id = "../../outside"
    XCTAssertThrowsError(try reopened.fileURL(malformed))
    try reopened.clear()
    XCTAssertFalse(FileManager.default.fileExists(atPath: disk.attachmentDirectory.path))
  }
}
