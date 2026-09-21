import XCTest

@testable import OpenTeamCore

final class AuthorizationPresentationTests: XCTestCase {
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
  func testOAuthExpiryHandlesPreciseMalformedAndExpiredDates() throws {
    var connection: JSON = .object([
      "status": .string("needs_auth"), "authorizationUrl": .string("https://a.test/?state=x"),
    ])
    let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-09-17T12:00:00Z"))
    connection["authorizationExpiresAt"] = .string("2026-09-17T12:01:00.000Z")
    XCTAssertEqual(PluginAuthorizationSession(connection, now: now)?.expired, false)
    for expiry in ["2026-09-17T12:00:00Z", "2026-09-16T12:00:00Z", "invalid"] {
      connection["authorizationExpiresAt"] = .string(expiry)
      XCTAssertEqual(PluginAuthorizationSession(connection, now: now)?.expired, true)
    }
  }
  func testApprovalSelectionUsesExactProfileAndHostIdentity() {
    XCTAssertEqual(
      ApprovalPresentation.siteKey(profileID: "Profile 2", origin: "https://example.com"),
      "[\"Profile 2\",\"https://example.com\"]")
    XCTAssertNotEqual(
      ApprovalPresentation.siteKey(profileID: "Profile 1", origin: "example.com"),
      ApprovalPresentation.siteKey(profileID: "Profile 2", origin: "example.com"))
  }
  func testPermissionReceiptDoesNotClaimExecutionCompleted() throws {
    let data = Data(
      #"{"id":"a","runId":"r","kind":"tool","status":"pending","details":{},"ownerConversationId":"c"}"#
        .utf8)
    var approval = try JSONDecoder().decode(Approval.self, from: data)
    XCTAssertTrue(ApprovalPresentation.isPending(approval))
    approval.status = "accepted"
    XCTAssertEqual(ApprovalPresentation.status(approval), "Approved")
    for (state, label) in [
      ("running", "Running"), ("completed", "Completed"), ("failed", "Failed"),
    ] {
      approval.details["actionState"] = .string(state)
      XCTAssertEqual(ApprovalPresentation.status(approval), label)
      XCTAssertFalse(ApprovalPresentation.isPending(approval))
    }
    approval.status = "declined"
    XCTAssertEqual(ApprovalPresentation.status(approval), "Denied")
    approval.status = "expired"
    XCTAssertEqual(ApprovalPresentation.status(approval), "Expired")
  }
}
