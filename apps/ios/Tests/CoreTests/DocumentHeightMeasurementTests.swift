import XCTest

@testable import OpenTeamCore

final class DocumentHeightMeasurementTests: XCTestCase {
  func testRejectsInflatedMeasurementBeforeDocumentHasWidth() {
    XCTAssertFalse(DocumentHeightMeasurement.isValid(
      height: 21_438, width: 0, viewportWidth: 298))
    XCTAssertTrue(DocumentHeightMeasurement.isValid(
      height: 890, width: 298, viewportWidth: 298))
  }

  func testRejectsMeasurementsFromOldViewportAfterResize() {
    XCTAssertFalse(DocumentHeightMeasurement.isValid(
      height: 890, width: 298, viewportWidth: 420))
    XCTAssertTrue(DocumentHeightMeasurement.isValid(
      height: 640, width: 420, viewportWidth: 420))
  }

  func testAllowsWidthRoundingAndEmptyDocumentHeight() {
    XCTAssertTrue(DocumentHeightMeasurement.isValid(
      height: 0, width: 298.5, viewportWidth: 298))
    XCTAssertFalse(DocumentHeightMeasurement.isValid(
      height: 890, width: 299.1, viewportWidth: 298))
  }

  func testRejectsInvalidGeometry() {
    for invalid in [0.0, -1, .nan, .infinity, -.infinity] {
      XCTAssertFalse(DocumentHeightMeasurement.isValid(
        height: 890, width: invalid, viewportWidth: 298))
      XCTAssertFalse(DocumentHeightMeasurement.isValid(
        height: 890, width: 298, viewportWidth: invalid))
    }
    for invalid in [-1.0, .nan, .infinity, -.infinity] {
      XCTAssertFalse(DocumentHeightMeasurement.isValid(
        height: invalid, width: 298, viewportWidth: 298))
    }
  }
}
