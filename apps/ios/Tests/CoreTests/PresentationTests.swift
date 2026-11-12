import XCTest
@testable import OpenTeamCore

final class PresentationTests: XCTestCase {
  private func fixture() throws -> JSON {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "presentation", withExtension: "json", subdirectory: "Fixtures"))
    return try JSONDecoder().decode(JSON.self, from: Data(contentsOf: url))
  }
  func testSharedWireContractKeepsGeoJSONOrderAndNativeBlocks() throws {
    let value = try XCTUnwrap(PresentationPayload.parse(fixture()))
    XCTAssertEqual(value.places.count, 3)
    XCTAssertNil(value.places[0].rating)
    guard case .map(let map) = value.blocks[0] else { return XCTFail("Missing map") }
    XCTAssertEqual(map.route?.geometry.coordinates[0], [-73.985847, 40.748191])
    XCTAssertEqual(map.route?.legs[0].toPlaceId, value.places[1].id)
    guard case .media(let media) = value.blocks[1] else { return XCTFail("Missing list") }
    XCTAssertEqual(media.items[0].title, "New York Public Library")
  }
  func testRejectsInvalidCoordinatesAndStopsBeforeMapKit() throws {
    let value = try fixture()
    guard case .object(var root) = value, case .array(var places) = root["places"], case .object(var place) = places[0] else { return XCTFail() }
    place["latitude"] = .number(120); places[0] = .object(place); root["places"] = .array(places)
    XCTAssertNil(PresentationPayload.parse(.object(root)))
    root["places"] = .array([])
    XCTAssertNil(PresentationPayload.parse(.object(root)))
  }
}
