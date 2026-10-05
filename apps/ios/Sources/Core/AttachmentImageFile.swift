import Foundation
import ImageIO

/// File I/O and ImageIO decoding run on the generic executor, including when
/// requested by a message row on the main actor. Never decode a full-size photo
/// just to display its chat preview or the gallery's thumbnail strip.
public enum AttachmentImageFile {
  /// The inline frame must not depend on when image bytes finish decoding.
  public static func previewSize(width: Int?, height: Int?) -> CGSize {
    guard let width, let height, width > 0, height > 0 else {
      return CGSize(width: 240, height: 150)
    }
    let scale = min(1, 260 / Double(width), 240 / Double(height))
    return CGSize(width: Double(width) * scale, height: Double(height) * scale)
  }

  public static func write(_ data: Data, named name: String) async throws -> URL {
    try Task.checkCancellation()
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let leaf = URL(fileURLWithPath: name).lastPathComponent
    let url = folder.appendingPathComponent(leaf.isEmpty || [".", "..", "/"].contains(leaf) ? "Attachment" : leaf)
    do {
      try data.write(to: url, options: [.atomic, .completeFileProtection])
      try Task.checkCancellation()
      return url
    } catch {
      try? FileManager.default.removeItem(at: folder)
      throw error
    }
  }

  public static func decode(_ url: URL, maximumPixels: Int) async throws -> CGImage? {
    try Task.checkCancellation()
    guard maximumPixels > 0,
      let source = CGImageSourceCreateWithURL(url as CFURL, [
        kCGImageSourceShouldCache: false,
      ] as CFDictionary)
    else { return nil }
    let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceThumbnailMaxPixelSize: maximumPixels,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
    ] as CFDictionary)
    try Task.checkCancellation()
    return image
  }
}
