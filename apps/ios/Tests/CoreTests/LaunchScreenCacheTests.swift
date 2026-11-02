import CoreGraphics
import Foundation
import ImageIO
import XCTest
@testable import OpenTeamCore

final class LaunchScreenCacheTests: XCTestCase {
  private var folder: URL!

  override func setUpWithError() throws {
    folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  }
  override func tearDownWithError() throws { try? FileManager.default.removeItem(at: folder) }

  /// Writes a fill the way iOS caches it: Apple's texture container in a .ktx file.
  private func cache(_ name: String, dark: Bool, width: Int = 120, height: Int = 260) throws {
    let context = try XCTUnwrap(CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.setFillColor(red: dark ? 0 : 1, green: dark ? 0 : 1, blue: dark ? 0 : 1, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let url = folder.appendingPathComponent(name)
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: url)
    let destination = try XCTUnwrap(
      CGImageDestinationCreateWithURL(url as CFURL, "com.apple.atx" as CFString, 1, nil))
    CGImageDestinationAddImage(destination, try XCTUnwrap(context.makeImage()), nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
  }
  private func isDark(_ name: String) throws -> Bool? {
    let source = try XCTUnwrap(
      CGImageSourceCreateWithURL(folder.appendingPathComponent(name) as CFURL, nil))
    return LaunchScreenCache.isDark(try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil)))
  }
  private func sync(_ appearance: LaunchScreenCache.Appearance) -> Int {
    LaunchScreenCache.sync(appearance, directory: folder)
  }

  func testChosenAppearanceRepaintsMismatchedPicturesWithASmallFill() throws {
    try cache("light@3x.ktx", dark: false)
    try cache("dark@3x.ktx", dark: true)
    XCTAssertEqual(sync(.dark), 1)
    XCTAssertEqual(try isDark("light@3x.ktx"), true)
    XCTAssertEqual(try isDark("dark@3x.ktx"), true)
    let bytes = try FileManager.default.attributesOfItem(
      atPath: folder.appendingPathComponent("light@3x.ktx").path)[.size] as? Int
    XCTAssertLessThan(try XCTUnwrap(bytes), 4096)
    XCTAssertEqual(sync(.dark), 0, "an up-to-date cache is left alone")
    XCTAssertEqual(sync(.light), 2)
    XCTAssertEqual(try isDark("light@3x.ktx"), false)
    XCTAssertEqual(try isDark("dark@3x.ktx"), false)
  }

  func testSystemRestoresEachPicturesOriginalFill() throws {
    try cache("light@3x.ktx", dark: false)
    try cache("dark@3x.ktx", dark: true)
    sync(.dark)
    XCTAssertEqual(sync(.system), 1)
    XCTAssertEqual(try isDark("light@3x.ktx"), false)
    XCTAssertEqual(try isDark("dark@3x.ktx"), true)
  }

  func testOriginalFillIsKeptOnThePictureItself() throws {
    try cache("light@3x.ktx", dark: false)
    sync(.dark)
    // Clearing local data leaves the cache in Library; only the files remain.
    let record = try XCTUnwrap(LaunchScreenCache.fills(folder.appendingPathComponent("light@3x.ktx")))
    XCTAssertEqual(record.original, false)
    XCTAssertEqual(record.current, true)
    XCTAssertEqual(sync(.system), 1)
    XCTAssertEqual(try isDark("light@3x.ktx"), false)
  }

  func testPictureRedrawnBySystemIsTakenAsTheNewOriginal() throws {
    try cache("first@3x.ktx", dark: false)
    sync(.dark)
    // iOS redraws the picture, here in Dark, after the app's last repaint.
    try cache("first@3x.ktx", dark: true)
    try cache("added@3x.ktx", dark: false)
    XCTAssertEqual(sync(.dark), 1, "only the added light picture needs a repaint")
    XCTAssertEqual(sync(.system), 1)
    XCTAssertEqual(try isDark("first@3x.ktx"), true)
    XCTAssertEqual(try isDark("added@3x.ktx"), false)
  }

  func testDownscaledCopiesAreRepaintedToo() throws {
    try cache("full@2x.ktx", dark: false)
    try cache("downscaled/small@2x.ktx", dark: false, width: 60, height: 80)
    XCTAssertEqual(sync(.dark), 2)
    XCTAssertEqual(try isDark("downscaled/small@2x.ktx"), true)
  }

  func testMissingCacheDoesNothing() {
    try? FileManager.default.removeItem(at: folder)
    XCTAssertEqual(sync(.dark), 0)
  }
}
