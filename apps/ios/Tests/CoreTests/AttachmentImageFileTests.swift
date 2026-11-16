import CoreGraphics
import ImageIO
import XCTest

@testable import OpenTeamCore

@MainActor final class AttachmentImageFileTests: XCTestCase {
  private func photo(orientation: Int = 1) throws -> Data {
    let context = try XCTUnwrap(CGContext(
      data: nil, width: 2400, height: 1200, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
    context.setFillColor(CGColor(red: 0.2, green: 0.6, blue: 0.9, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: 2400, height: 1200))
    let image = try XCTUnwrap(context.makeImage())
    let data = NSMutableData()
    let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, [kCGImagePropertyOrientation: orientation] as CFDictionary)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    return data as Data
  }

  func testPreviewThumbnailAndGalleryDecodeFromOneUnchangedOriginal() async throws {
    let data = try photo()
    let url = try await AttachmentImageFile.write(data, named: "../Camera roll/Photo.jpg")
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    XCTAssertEqual(url.lastPathComponent, "Photo.jpg")
    for size in [960, 144, 2048, 144] {
      let decoded = try await AttachmentImageFile.decode(url, maximumPixels: size)
      let image = try XCTUnwrap(decoded)
      XCTAssertEqual(image.width, size)
      XCTAssertEqual(image.height, size / 2)
    }
    XCTAssertEqual(try Data(contentsOf: url), data, "Share/Save must retain original bytes")
  }

  func testPhotoOrientationAndInvalidData() async throws {
    let url = try await AttachmentImageFile.write(photo(orientation: 6), named: "Rotated.jpg")
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let decoded = try await AttachmentImageFile.decode(url, maximumPixels: 144)
    let image = try XCTUnwrap(decoded)
    XCTAssertEqual(image.width, 72)
    XCTAssertEqual(image.height, 144)
    let file = try await AttachmentImageFile.write(Data("Not a picture".utf8), named: "File.txt")
    defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
    let invalid = try await AttachmentImageFile.decode(file, maximumPixels: 144)
    let skipped = try await AttachmentImageFile.decode(url, maximumPixels: 0)
    XCTAssertNil(invalid)
    XCTAssertNil(skipped)
  }
}
