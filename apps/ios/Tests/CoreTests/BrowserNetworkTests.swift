import XCTest
@testable import OpenTeamCore

final class BrowserNetworkTests: XCTestCase {
  func testPriorityRequestIncludesServerOrderAndConditionalRevision() {
    let request = BrowserNetworkRequest.priority(["air","server","mini"], revision:8)
    XCTAssertEqual(request["mode"],.string("ranked"))
    XCTAssertEqual(request["machineId"],.null)
    XCTAssertEqual(request["expectedRevision"],.number(8))
    XCTAssertEqual(request["sourceOrder"],.array([.string("air"),.string("server"),.string("mini")]))
  }
  func testEgressAndQualityContractsPreserveSourceEpochAndUnits() throws {
    let value: JSON = .object(["epoch": .string("one"), "sourceId": .string("air"),
      "checkedAt": .string("2026-11-02T00:00:00Z"), "latencyMs": .number(42),
      "downloadMbps": .number(28.4), "uploadMbps": .number(9.2),
      "downloadBytes": .number(1048576), "uploadBytes": .number(262144)])
    let quality = try value.decode(BrowserNetworkQuality.self)
    XCTAssertEqual(quality.epoch, "one")
    XCTAssertEqual(quality.sourceId, "air")
    XCTAssertEqual(quality.latencyMs, 42)
    XCTAssertEqual(quality.downloadMbps, 28.4)
    XCTAssertEqual(quality.uploadMbps, 9.2)
    let egress = try JSON.object(["epoch": .string("one"), "sourceId": .string("air"),
      "ip": .string("203.0.113.10"), "location": .string("Example"), "checkedAt": .string("2026-11-01T00:00:00Z")])
      .decode(BrowserNetworkEgress.self)
    XCTAssertEqual([egress.epoch, egress.sourceId, egress.ip], ["one", "air", "203.0.113.10"])
  }
}
