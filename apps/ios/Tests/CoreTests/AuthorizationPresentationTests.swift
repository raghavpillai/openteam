import XCTest

@testable import OpenTeamCore

final class AuthorizationPresentationTests: XCTestCase {
  func testConnectTimeoutStillObservesLateDesktopApproval() {
    let start = Date(timeIntervalSince1970: 1_000)
    let disconnected: JSON = .object(["status": .string("disconnected")])
    let ready: JSON = .object(["status": .string("ready")])
    var recovery = PluginConnectionRecovery()
    XCTAssertFalse(recovery.shouldPoll(disconnected, now: start))
    recovery.begin(now: start)
    // The HTTP request timed out, but desktop approval is still pending.
    XCTAssertTrue(recovery.shouldPoll(disconnected, now: start.addingTimeInterval(65)))
    XCTAssertFalse(recovery.observe(disconnected))
    XCTAssertTrue(recovery.observe(ready))
    XCTAssertFalse(recovery.shouldPoll(ready, now: start.addingTimeInterval(70)))
    XCTAssertFalse(recovery.observe(ready), "Only the pending attempt may clear its failure")

    recovery.begin(now: start)
    XCTAssertFalse(recovery.shouldPoll(disconnected, now: start.addingTimeInterval(180)))
    recovery.begin(now: start.addingTimeInterval(200))
    XCTAssertTrue(recovery.shouldPoll(disconnected, now: start.addingTimeInterval(201)))
    recovery.cancel()
    XCTAssertFalse(recovery.shouldPoll(disconnected, now: start.addingTimeInterval(202)))
    XCTAssertTrue(recovery.shouldPoll(.object(["status": .string("needs_auth")]), now: start))
  }

  func testCompatiblePackageUpdateReconnectsWithoutAnotherSignIn() {
    var connection: JSON = .object([
      "auth": .string("oauth"), "status": .string("disconnected"),
      "configured": .bool(true), "setupPhase": .string("ready_to_connect"),
    ])
    XCTAssertTrue(PluginConnectionPresentation(connection).canReconnect)
    XCTAssertEqual(PluginConnectionPresentation(connection).status, "Reconnect needed")
    connection["setupPhase"] = .string("ready_to_authorize")
    XCTAssertFalse(PluginConnectionPresentation(connection).canReconnect)
    XCTAssertEqual(PluginConnectionPresentation(connection).status, "Sign-in needed")
  }
  func testActiveDeviceApprovalKeepsPollingWhileItsChallengeIsInvalidatedOrExpired() {
    let now = Date(timeIntervalSince1970: 1_000)
    var connection: JSON = .object([
      "auth": .string("none"), "status": .string("needs_auth"),
      "deviceLink": .object([
        "sessionId": .string("active-session"),
        "qrCodeDataUrl": .string("data:image/png;base64,aGVsbG8="),
        "expiresAt": .number(1_030_000), "sessionExpiresAt": .number(1_300_000),
      ]),
    ])
    let recovery = PluginConnectionRecovery()
    XCTAssertEqual(PluginConnectionPresentation(connection, now: now).status, "Scan to connect")
    connection["deviceLink"]["qrCodeDataUrl"] = .null
    XCTAssertEqual(PluginConnectionPresentation(connection, now: now).status, "Waiting for approval")
    XCTAssertTrue(recovery.shouldPoll(connection, now: now))
    connection["deviceLink"]["qrCodeDataUrl"] = .string("data:image/png;base64,aGVsbG8=")
    let later = now.addingTimeInterval(60)
    XCTAssertEqual(PluginConnectionPresentation(connection, now: later).status, "Waiting for approval")
    XCTAssertTrue(recovery.shouldPoll(connection, now: later))
    connection["deviceLink"]["expiresAt"] = .number(1_100_000)
    XCTAssertEqual(PluginConnectionPresentation(connection, now: later).status, "Scan to connect")
  }
  func testDesktopAuthorizationCannotBeOpenedOrReplacedFromMobile() {
    var connection: JSON = .object([
      "auth": .string("oauth"), "status": .string("needs_auth"),
      "oauthCallbackMode": .string("desktop"),
    ])
    XCTAssertTrue(MobilePluginAuthorization.requiresDesktop(connection))
    connection["oauthCallbackMode"] = .string("server")
    XCTAssertFalse(MobilePluginAuthorization.requiresDesktop(connection))
    for callback in ["http://127.0.0.1:58123/callback", "http://localhost:8787/callback", "http://[::1]:9000/callback"] {
      var url = URLComponents(string: "https://accounts.example.test/start")!
      url.queryItems = [URLQueryItem(name: "state", value: "one"), URLQueryItem(name: "redirect_uri", value: callback)]
      connection["authorizationUrl"] = .string(url.url!.absoluteString)
      XCTAssertTrue(MobilePluginAuthorization.requiresDesktop(connection))
    }
    connection["authorizationUrl"] = .string("https://accounts.example.test/start?state=one&redirect_uri=https%3A%2F%2Fopenteam.example.com%2Fcallback")
    XCTAssertFalse(MobilePluginAuthorization.requiresDesktop(connection))
    connection["auth"] = .string("token")
    XCTAssertFalse(MobilePluginAuthorization.requiresDesktop(connection))
  }
  func testOAuthSessionRequiresStateAndSafeScheme() {
    var connection: JSON = .object([
      "status": .string("needs_auth"),
      "authorizationUrl": .string("https://accounts.example.test/start?state=one%2Btwo"),
    ])
    XCTAssertEqual(PluginAuthorizationSession(connection)?.state, "one+two")
    XCTAssertEqual(PluginAuthorizationSession(connection)?.expired, false)
    for url in [
      "https://accounts.example.test/start", "javascript:alert(1)?state=x", "file:///tmp?state=x",
      "https://a.test/?state=",
    ] {
      connection["authorizationUrl"] = .string(url)
      XCTAssertNil(PluginAuthorizationSession(connection))
    }
    connection["authorizationUrl"] = .string("https://accounts.example.test/start?state=x")
    connection["status"] = .string("ready")
    XCTAssertNil(PluginAuthorizationSession(connection))
  }
  func testManualLoopbackCanBeCompletedOnMobile() {
    let connection: JSON = .object([
      "auth": .string("oauth"), "status": .string("needs_auth"),
      "oauthCallbackMode": .string("manual"),
      "authorizationUrl": .string("https://accounts.example.test/start?state=one&redirect_uri=http%3A%2F%2F127.0.0.1%3A42813%2Fcallback"),
    ])
    XCTAssertTrue(PluginAuthorizationSession(connection)?.usesLoopbackCallback == true)
    XCTAssertFalse(MobilePluginAuthorization.requiresDesktop(connection))
  }
}
