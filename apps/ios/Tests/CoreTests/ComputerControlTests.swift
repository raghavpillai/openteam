import XCTest
@testable import OpenTeamCore
final class ComputerControlTests: XCTestCase {
  func testAnotherDeviceDoesNotGrantInput() {
    let status: JSON = .object(["humanTakeover": .bool(true), "controlSession": .object(["id": .string("desktop"), "generation": .number(4)])])
    XCTAssertFalse(ComputerControl.owns(status, viewerID: "ios"))
    XCTAssertTrue(ComputerControl.owns(status, viewerID: "desktop"))
    XCTAssertFalse(ComputerControl.owns(.object(["humanTakeover": .bool(true)]), viewerID: "ios"))
  }
  func testReleaseCarriesOwnershipGenerationAndHasNoRenewal() {
    let body = ComputerControl.request(active: false, viewerID: "ios", generation: 9)
    XCTAssertEqual(body["controlId"], .string("ios"))
    XCTAssertEqual(body["generation"], .number(9))
    XCTAssertEqual(body["active"], .bool(false))
    XCTAssertEqual(body["renew"], .null)
  }
}
