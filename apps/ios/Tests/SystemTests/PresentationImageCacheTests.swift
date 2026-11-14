import SwiftUI
import XCTest
@testable import OpenTeamNative

@MainActor final class PresentationImageCacheTests: XCTestCase {
  func testAPIRotationClearsDecodedPhotosAndCancelsPendingLoads() throws {
    let first = try API(server: "https://selected-server.example.com", token: "fixture-a")
    let rotated = try API(server: "https://selected-server.example.com", token: "fixture-b")
    PlaceImages.select(first.resourceGeneration)
    defer { PlaceImages.select(nil) }
    PlaceImages.values.setObject(UIImage(), forKey: "old-generation")
    let pending = Task<Data, Error> {
      try await Task.sleep(for: .seconds(30))
      return Data()
    }
    PlaceImages.requests[UUID()] = pending
    PlaceImages.select(rotated.resourceGeneration)
    XCTAssertNil(PlaceImages.values.object(forKey: "old-generation"))
    XCTAssertTrue(PlaceImages.requests.isEmpty)
    XCTAssertTrue(pending.isCancelled)
    XCTAssertNotEqual(first.resourceGeneration, rotated.resourceGeneration)
  }

  func testSameGenerationKeepsWarmPhotoAndSignOutClearsIt() throws {
    let api = try API(server: "http://192.168.1.5:8787", token: "fixture")
    PlaceImages.select(api.resourceGeneration)
    defer { PlaceImages.select(nil) }
    let image = UIImage()
    PlaceImages.values.setObject(image, forKey: "warm-generation")
    PlaceImages.select(api.resourceGeneration)
    XCTAssertTrue(PlaceImages.values.object(forKey: "warm-generation") === image)
    PlaceImages.select(nil)
    XCTAssertNil(PlaceImages.values.object(forKey: "warm-generation"))
  }
}
