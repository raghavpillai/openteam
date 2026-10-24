import CoreGraphics
import Foundation
import ImageIO

/// iOS shows a cached picture of the launch screen before any app code runs,
/// drawn in the phone's appearance: white in Light mode and black in Dark. With
/// Day or Night chosen in Settings, a launch whose phone appearance differs
/// showed that picture, then faded to the app's color.
///
/// The pictures are plain fills, cached per appearance and window size as they
/// are first needed, in the app's Library (iPad also keeps downscaled copies).
/// This repaints them in the chosen appearance, and back to their original fill
/// for System. iOS stretches a picture over the screen, so a small fill does.
///
/// Each picture records its original fill on the file itself, so the record
/// survives clearing local data and is gone when iOS writes the picture again,
/// which is when its fill must be read anew. Should iOS stop reading these
/// files, launches look as they did before.
public enum LaunchScreenCache {
  public enum Appearance: String, Sendable {
    case system, light, dark
  }

  /// "<original>:<current>", each "dark" or "light".
  static let attribute = "dev.openteam.launch-fill"
  /// Side of the square fill written in place of a picture.
  static let fillSide = 16

  /// The folder iOS keeps this app's launch pictures in.
  public static func directory(library: URL, bundleID: String) -> URL {
    library.appendingPathComponent("SplashBoard/Snapshots/\(bundleID) - {DEFAULT GROUP}")
  }

  /// Repaints each cached picture to match `appearance`. Returns the number of
  /// pictures it rewrote.
  @discardableResult
  public static func sync(_ appearance: Appearance, directory: URL) -> Int {
    guard
      let files = FileManager.default.enumerator(
        at: directory, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])
    else { return 0 }
    var rewritten = 0
    for case let url as URL in files where url.pathExtension == "ktx" {
      let record = fills(url)
      // A picture without a record is as iOS drew it.
      guard let original = record?.original ?? image(at: url).flatMap(isDark) else { continue }
      let current = record?.current ?? original
      let target = appearance == .dark ? true : appearance == .light ? false : original
      if current != target {
        guard write(fill: target, to: url) else { continue }
        rewritten += 1
      }
      if record?.original != original || record?.current != target {
        setFills(url, original: original, current: target)
      }
    }
    return rewritten
  }

  static func fills(_ url: URL) -> (original: Bool, current: Bool)? {
    var buffer = [UInt8](repeating: 0, count: 32)
    let length = getxattr(url.path, attribute, &buffer, buffer.count, 0, 0)
    guard length > 0 else { return nil }
    let parts = String(decoding: buffer[..<length], as: UTF8.self).split(separator: ":")
    guard parts.count == 2 else { return nil }
    return (parts[0] == "dark", parts[1] == "dark")
  }

  private static func setFills(_ url: URL, original: Bool, current: Bool) {
    let value = Array("\(original ? "dark" : "light"):\(current ? "dark" : "light")".utf8)
    _ = setxattr(url.path, attribute, value, value.count, 0, 0)
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

  /// Writes the fill in iOS's image format to a temporary file, then swaps it in whole.
  private static func write(fill dark: Bool, to url: URL) -> Bool {
    guard
      let context = CGContext(
        data: nil, width: fillSide, height: fillSide, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return false }
    let value: CGFloat = dark ? 0 : 1
    context.setFillColor(red: value, green: value, blue: value, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: fillSide, height: fillSide))
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
