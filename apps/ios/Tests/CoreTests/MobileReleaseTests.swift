import Foundation
import XCTest

@testable import OpenTeamCore

final class MobileReleaseTests: XCTestCase {
  func release(_ version: String = "0.0.4", _ build: String = "51") -> MobileRelease {
    MobileRelease(version: version, buildNumber: build, bundleIdentifier: "dev.openbot.mobile")
  }

  func testSameVersionTestFlightBuildIsAnUpdate() {
    XCTAssertTrue(release().isNewer(thanVersion: "0.0.4", buildNumber: "50"))
    XCTAssertFalse(release().isNewer(thanVersion: "0.0.4", buildNumber: "51"))
    XCTAssertFalse(release().isNewer(thanVersion: "0.0.4", buildNumber: "52"))
    XCTAssertTrue(release("0.0.4", "100").isNewer(thanVersion: "0.0.4", buildNumber: "99"))
  }

  func testMarketingVersionTakesPrecedenceOverBuildNumber() {
    XCTAssertTrue(release("0.0.5", "1").isNewer(thanVersion: "0.0.4", buildNumber: "99"))
    XCTAssertFalse(release().isNewer(thanVersion: "0.0.5", buildNumber: "1"))
    XCTAssertTrue(release("0.0.10", "1").isNewer(thanVersion: "0.0.9", buildNumber: "99"))
    XCTAssertTrue(release("1.0", "2.10").isNewer(thanVersion: "1.0.0", buildNumber: "2.9"))
  }

  func testInvalidVersionsNeverAdvertiseAnUpdate() {
    for invalid in ["", "v0.0.5", "1..2", "-1", "1.2.3.4", "beta", "1.2 ", "99999999999999999999"] {
      XCTAssertFalse(release(invalid).isNewer(thanVersion: "0.0.4", buildNumber: "50"))
      XCTAssertFalse(release("0.0.4", invalid).isNewer(thanVersion: "0.0.4", buildNumber: "50"))
      XCTAssertFalse(release().isNewer(thanVersion: invalid, buildNumber: "50"))
      XCTAssertFalse(release().isNewer(thanVersion: "0.0.4", buildNumber: invalid))
    }
  }

  func testFeedCanAdvertiseOrWithdrawARelease() throws {
    let data = Data(
      #"{"release":{"version":"0.0.4","buildNumber":"51","bundleIdentifier":"dev.openbot.mobile"}}"#
        .utf8)
    XCTAssertEqual(try MobileReleaseFeed.decode(data), release())
    XCTAssertNil(try MobileReleaseFeed.decode(Data(#"{"release":null}"#.utf8)))
    for invalid in [
      "{}", "[]", "not json", #"{"release":{"version":"0.0.4"}}"#,
      #"{"release":{"version":"bad","buildNumber":"51","bundleIdentifier":"dev.openbot.mobile"}}"#,
      #"{"release":{"version":"0.0.4","buildNumber":"51","bundleIdentifier":"another.app"}}"#,
    ] {
      XCTAssertThrowsError(try MobileReleaseFeed.decode(Data(invalid.utf8)))
    }
  }

}
