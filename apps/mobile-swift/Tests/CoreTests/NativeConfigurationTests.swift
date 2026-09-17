import Foundation
import XCTest

final class NativeConfigurationTests: XCTestCase {
  func testUserSelectedHTTPServersAreNotOverriddenByFineGrainedATSPolicies() throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    let data = try Data(contentsOf: root.appendingPathComponent("Resources/Info.plist"))
    let plist = try XCTUnwrap(
      PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    let ats = try XCTUnwrap(plist["NSAppTransportSecurity"] as? [String: Any])
    XCTAssertEqual(ats["NSAllowsArbitraryLoads"] as? Bool, true)
    // The presence of any of these keys causes iOS to ignore the broad HTTP allowance,
    // even if their value is false. Loopback tests alone don't expose that conflict.
    for key in ["NSAllowsLocalNetworking", "NSAllowsArbitraryLoadsForMedia", "NSAllowsArbitraryLoadsInWebContent"] {
      XCTAssertNil(ats[key], "\(key) would block user-selected HTTP server IPs")
    }
  }
}
