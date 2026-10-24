import CoreGraphics
import Foundation
import ImageIO
import XCTest
@testable import OpenTeamCore

final class LaunchScreenCacheTests: XCTestCase {
  private var root: URL!
  private var folder: URL { root.appendingPathComponent("cache") }
  private var manifest: URL { root.appendingPathComponent("state/launch-screen.json") }

  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  }
  override func tearDownWithError() throws { try? FileManager.default.removeItem(at: root) }

  /// Writes a fill the way iOS caches it: Apple's texture container in a .ktx file.
  private func cache(_ name: String, dark: Bool, width: Int = 12, height: Int = 26) throws {
    let context = try XCTUnwrap(CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.setFillColor(red: dark ? 0 : 1, green: dark ? 0 : 1, blue: dark ? 0 : 1, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let url = folder.appendingPathComponent(name)
    let destination = try XCTUnwrap(
      CGImageDestinationCreateWithURL(url as CFURL, "com.apple.atx" as CFString, 1, nil))
    CGImageDestinationAddImage(destination, try XCTUnwrap(context.makeImage()), nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
  }
  private func fill(_ name: String) throws -> (dark: Bool?, width: Int, height: Int) {
    let source = try XCTUnwrap(
      CGImageSourceCreateWithURL(folder.appendingPathComponent(name) as CFURL, nil))
    let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
    return (LaunchScreenCache.isDark(image), image.width, image.height)
  }
  private func sync(_ appearance: LaunchScreenCache.Appearance) -> Int {
    LaunchScreenCache.sync(appearance, directory: folder, manifest: manifest)
  }

  func testChosenAppearanceRepaintsMismatchedPicturesAtTheirSize() throws {
    try cache("light@3x.ktx", dark: false)
    try cache("dark@3x.ktx", dark: true, width: 26, height: 12)
    XCTAssertEqual(sync(.dark), 1)
    XCTAssertEqual(try fill("light@3x.ktx").dark, true)
    XCTAssertEqual(try fill("light@3x.ktx").width, 12)
    XCTAssertEqual(try fill("light@3x.ktx").height, 26)
    XCTAssertEqual(try fill("dark@3x.ktx").dark, true)
    XCTAssertEqual(sync(.dark), 0, "an up-to-date cache is left alone")
    XCTAssertEqual(sync(.light), 2)
    XCTAssertEqual(try fill("light@3x.ktx").dark, false)
    XCTAssertEqual(try fill("dark@3x.ktx").dark, false)
  }

  func testSystemRestoresEachPicturesOriginalFill() throws {
    try cache("light@3x.ktx", dark: false)
    try cache("dark@3x.ktx", dark: true)
    sync(.dark)
    XCTAssertEqual(sync(.system), 1)
    XCTAssertEqual(try fill("light@3x.ktx").dark, false)
    XCTAssertEqual(try fill("dark@3x.ktx").dark, true)
  }

  func testPictureRedrawnByTheSystemIsTakenAsTheNewOriginal() throws {
    try cache("first@3x.ktx", dark: false)
    sync(.dark)
    // iOS redraws the picture, here in Dark, after the app's last repaint.
    try FileManager.default.removeItem(at: folder.appendingPathComponent("first@3x.ktx"))
    try cache("first@3x.ktx", dark: true, width: 10, height: 20)
    try cache("added@3x.ktx", dark: false)
    XCTAssertEqual(sync(.dark), 1, "only the added light picture needs a repaint")
    XCTAssertEqual(sync(.system), 1)
    XCTAssertEqual(try fill("first@3x.ktx").dark, true)
    XCTAssertEqual(try fill("added@3x.ktx").dark, false)
  }

  func testMissingCacheDoesNothing() {
    try? FileManager.default.removeItem(at: folder)
    XCTAssertEqual(sync(.dark), 0)
  }
}
