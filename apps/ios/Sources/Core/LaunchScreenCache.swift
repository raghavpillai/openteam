import CoreGraphics
import Foundation
import ImageIO

/// iOS shows a cached picture of the launch screen before any app code runs,
/// drawn in the phone's appearance: white in Light mode and black in Dark. With
/// Day or Night chosen in Settings, a launch whose phone appearance differs
/// showed that picture, then faded to the app's own color.
///
/// The pictures are plain fills, cached per appearance and orientation as they
/// are first needed, in the app's Library. This repaints them in the chosen
/// appearance, and back to their original fill for System. A picture iOS adds or
/// replaces later is recorded as an original first. Should iOS stop reading these
/// files, launches look as they did before.
public enum LaunchScreenCache {
  public enum Appearance: String, Sendable {
    case system, light, dark
  }

  private struct Entry: Codable {
    /// The fill iOS drew, before any repaint.
    var originalDark: Bool
    var dark: Bool
    var bytes: Int
    var modified: Date
  }

  /// The folder iOS keeps this app's launch pictures in.
  public static func directory(library: URL, bundleID: String) -> URL {
    library.appendingPathComponent("SplashBoard/Snapshots/\(bundleID) - {DEFAULT GROUP}")
  }

  /// Repaints each cached picture to match `appearance`. Returns the number of
  /// pictures it rewrote.
  @discardableResult
  public static func sync(_ appearance: Appearance, directory: URL, manifest: URL) -> Int {
    let files = FileManager.default
    guard let names = try? files.contentsOfDirectory(atPath: directory.path) else { return 0 }
    var entries = (try? JSONDecoder().decode(
      [String: Entry].self, from: Data(contentsOf: manifest))) ?? [:]
    entries = entries.filter { names.contains($0.key) }
    var rewritten = 0
    for name in names where name.hasSuffix(".ktx") && !name.hasPrefix(".") {
      let url = directory.appendingPathComponent(name)
      guard let stamp = self.stamp(url) else { continue }
      var entry = entries[name]
      if entry == nil || entry?.bytes != stamp.bytes || entry?.modified != stamp.modified {
        // New, or redrawn by iOS since our last write: its fill is the original.
        guard let image = image(at: url), let dark = isDark(image) else { continue }
        entry = Entry(originalDark: dark, dark: dark, bytes: stamp.bytes, modified: stamp.modified)
      }
      guard var current = entry else { continue }
      let target = appearance == .dark ? true : appearance == .light ? false : current.originalDark
      if current.dark != target, let image = image(at: url),
        write(fill: target, width: image.width, height: image.height, to: url),
        let written = self.stamp(url)
      {
        current.dark = target
        current.bytes = written.bytes
        current.modified = written.modified
        rewritten += 1
      }
      entries[name] = current
    }
    if let data = try? JSONEncoder().encode(entries) {
      try? files.createDirectory(
        at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
      try? data.write(to: manifest, options: .atomic)
    }
    return rewritten
  }

  private static func stamp(_ url: URL) -> (bytes: Int, modified: Date)? {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
      let bytes = attributes[.size] as? Int, let modified = attributes[.modificationDate] as? Date
    else { return nil }
    return (bytes, modified)
  }

  private static func image(at url: URL) -> CGImage? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(source, 0, nil)
  }

  /// Samples the picture down to one pixel.
  static func isDark(_ image: CGImage) -> Bool? {
    var pixel = [UInt8](repeating: 0, count: 4)
    guard let context = CGContext(
      data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    context.interpolationQuality = .medium
    context.draw(image, in: CGRect(x: 0, y: 0, width: 1, height: 1))
    let luma = 0.299 * Double(pixel[0]) + 0.587 * Double(pixel[1]) + 0.114 * Double(pixel[2])
    return luma < 128
  }

  /// Writes the fill to a temporary file, then swaps it in whole.
  private static func write(fill dark: Bool, width: Int, height: Int, to url: URL) -> Bool {
    guard width > 0, height > 0,
      let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return false }
    let value: CGFloat = dark ? 0 : 1
    context.setFillColor(red: value, green: value, blue: value, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    guard let image = context.makeImage() else { return false }
    let staged = FileManager.default.temporaryDirectory
      .appendingPathComponent("\(UUID().uuidString).ktx")
    guard let destination = CGImageDestinationCreateWithURL(
      staged as CFURL, "com.apple.atx" as CFString, 1, nil)
    else { return false }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
      try? FileManager.default.removeItem(at: staged)
      return false
    }
    do {
      _ = try FileManager.default.replaceItemAt(url, withItemAt: staged)
      return true
    } catch {
      try? FileManager.default.removeItem(at: staged)
      return false
    }
  }
}
