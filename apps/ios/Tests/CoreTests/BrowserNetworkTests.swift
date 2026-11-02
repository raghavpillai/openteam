import XCTest
@testable import OpenTeamCore

final class BrowserNetworkTests: XCTestCase {
  func view(_ state: String = "ready", connected: Bool = true, active: String = "air") throws -> BrowserNetworkView {
    let value: JSON = .object([
      "settings": .object(["mode":.string("ranked"),"machineId":.null,"revision":.number(8),"sourceOrder":.array([.string("air"),.string("server")])]),
      "runtime":.object(["state":.string(state),"activeMachineId":.string(active)]),
      "devices":.array([.object(["machineId":.string("air"),"label":.string("MacBook Air"),"enabled":.bool(true),"connected":.bool(connected),"sharingAllowed":.bool(true)])]),
    ])
    return try value.decode(BrowserNetworkView.self)
  }
  func testPriorityRequestIncludesServerOrderAndConditionalRevision() {
    let request = BrowserNetworkRequest.priority(["air","server","mini"], revision:8)
    XCTAssertEqual(request["mode"],.string("ranked"))
    XCTAssertEqual(request["machineId"],.null)
    XCTAssertEqual(request["expectedRevision"],.number(8))
    XCTAssertEqual(request["sourceOrder"],.array([.string("air"),.string("server"),.string("mini")]))
  }
  func testStatusUsesAppliedRuntimeRatherThanDraftOrder() throws {
    let view = try view()
    XCTAssertEqual(view.summary,"Using MacBook Air")
    XCTAssertEqual(view.status("air"),"In use")
    XCTAssertEqual(view.status("server"),"Available")
    XCTAssertEqual(view.order,["air","server"])
  }
  func testOfflineSharingDeviceIsUnavailableAndServerFallbackIsVisible() throws {
    let view = try view("server",connected:false)
    XCTAssertEqual(view.status("air"),"Offline or sharing off")
    XCTAssertEqual(view.status("server"),"In use")
    XCTAssertEqual(view.summary,"Using the server connection")
    XCTAssertEqual(view.order,["air","server"])
  }
  func testWorkingStatusTracksProviderEligibility() throws {
    XCTAssertTrue(try view().working("air"))
    XCTAssertFalse(try view("server", connected: false).working("air"))
    XCTAssertTrue(try view().working("server"))
    XCTAssertFalse(try view().working("unknown"))
    let data = Data("""
      {"settings":{"mode":"ranked","revision":1,"sourceOrder":["air","server"]},
       "runtime":{"state":"server","routeEpoch":"epoch"},
       "devices":[{"machineId":"air","label":"MacBook Air","enabled":true,"connected":true,"sharingAllowed":true,"working":false}]}
      """.utf8)
    XCTAssertFalse(try JSONDecoder().decode(BrowserNetworkView.self, from: data).working("air"))
  }
  func testEgressContractPreservesSourceAndEpoch() throws {
    let value: JSON = .object(["epoch": .string("one"), "sourceId": .string("air"),
      "ip": .string("203.0.113.10"), "location": .string("Example"), "checkedAt": .string("2026-11-01T00:00:00Z")])
    let egress = try value.decode(BrowserNetworkEgress.self)
    XCTAssertEqual(egress.epoch, "one")
    XCTAssertEqual(egress.sourceId, "air")
    XCTAssertEqual(egress.ip, "203.0.113.10")
  }
  func testQualityContractPreservesRouteAndFractionalSpeedUnits() throws {
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
  }
  func testMissingComputerRemainsVisibleWithUnavailableStatus() throws {
    let view = try view()
    XCTAssertEqual(view.name("removed"),"Unavailable computer")
    XCTAssertEqual(view.status("removed"),"Unavailable")
  }
}
