import Foundation
import ImageIO

/// File I/O and ImageIO decoding run on the generic executor, including when
/// requested by a message row on the main actor. Never decode a full-size photo
/// just to display its chat preview or the gallery's thumbnail strip.
public enum AttachmentImageFile {
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
