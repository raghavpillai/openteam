import CryptoKit
import SwiftUI
import UIKit

/// Site icons for chat links. Icons come from the linked site itself, never a
/// third-party icon service, so only the site sees that its link was shown.
/// Found icons are kept for a week and misses for a day, on disk and in memory.
@MainActor @Observable final class FaviconStore {
  static let shared = FaviconStore()
  enum State { case loading, icon(UIImage), missing }
  private(set) var icons: [String: UIImage] = [:]
  private(set) var missed: Set<String> = []
  @ObservationIgnored private var tasks: [String: Task<UIImage?, Never>] = [:]
  @ObservationIgnored private let session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 8
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    return URLSession(configuration: configuration)
  }()
  private nonisolated static let hitLifetime: TimeInterval = 7 * 24 * 60 * 60
  private nonisolated static let missLifetime: TimeInterval = 24 * 60 * 60
  private nonisolated static let pixelSize: CGFloat = 64

  /// Public web hosts only: no IP literals, localhost or local-network names,
  /// so a message link never makes the app probe the user's own network.
  static func host(of url: URL) -> String? {
    guard ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
      let host = url.host()?.lowercased(), host.contains("."), !host.contains(":"),
      host.range(of: #"^[0-9.]+$"#, options: .regularExpression) == nil,
      !host.hasSuffix(".local"), !host.hasSuffix(".localhost"), !host.hasSuffix(".internal") else { return nil }
    return host
  }

  /// Loading until the site answers, then its icon or missing. Starts the fetch
  /// when needed, so it is safe to call from a view body.
  func state(for url: URL) -> State {
    guard let host = Self.host(of: url) else { return .missing }
    if let icon = icons[host] { return .icon(icon) }
    if missed.contains(host) { return .missing }
    if tasks[host] == nil { Task { _ = await self.load(host) } }
    return .loading
  }

  func load(_ host: String) async -> UIImage? {
    if let icon = icons[host] { return icon }
    if missed.contains(host) { return nil }
    if let task = tasks[host] { return await task.value }
    let task = Task<UIImage?, Never> { [session] in
      #if DEBUG
        // UI tests hold icons back to show the loading skeleton.
        if ProcessInfo.processInfo.arguments.contains("--slow-favicons") {
          try? await Task.sleep(for: .seconds(5))
        }
      #endif
      switch Self.readCache(host) {
      case .hit(let image): return image
      case .miss: return nil
      case .none: break
      }
      let image = await Self.fetch(host, session: session)
      Self.writeCache(host, image)
      return image
    }
    tasks[host] = task
    let image = await task.value
    tasks[host] = nil
    if let image { icons[host] = image } else { missed.insert(host) }
    return image
  }

  /// A PNG data URL for the rich document renderer, whose page loads no network images.
  func dataURL(_ host: String) async -> String? {
    guard let png = await load(host)?.pngData() else { return nil }
    return "data:image/png;base64," + png.base64EncodedString()
  }

  // MARK: Fetching

  private nonisolated static func fetch(_ host: String, session: URLSession) async -> UIImage? {
    guard let root = URL(string: "https://" + host + "/") else { return nil }
    // The page's declared icon is usually sharper than /favicon.ico.
    if let declared = await declaredIcon(root, session: session), let image = await image(declared, session: session) {
      return image
    }
    for path in ["/favicon.ico", "/apple-touch-icon.png"] {
      if let url = URL(string: path, relativeTo: root), let image = await image(url, session: session) {
        return image
      }
    }
    return nil
  }

  private nonisolated static func image(_ url: URL, session: URLSession) async -> UIImage? {
    guard let (data, response) = try? await session.data(from: url),
      (response as? HTTPURLResponse)?.statusCode == 200, data.count < 1_000_000,
      let image = UIImage(data: data), image.size.width >= 8 else { return nil }
    return resized(image)
  }

  /// Reads `<link rel="icon">` (or apple-touch-icon) from the page's head.
  private nonisolated static func declaredIcon(_ page: URL, session: URLSession) async -> URL? {
    guard let (data, response) = try? await session.data(from: page),
      (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
    let html = String(decoding: data.prefix(256_000), as: UTF8.self)
    let base = response.url ?? page
    var best: (score: Int, url: URL)?
    let tag = /<link\b[^>]*>/.ignoresCase()
    for match in html.matches(of: tag) {
      let element = String(match.output)
      guard let rel = attribute("rel", in: element)?.lowercased(), rel.contains("icon"),
        let href = attribute("href", in: element), let url = URL(string: href, relativeTo: base)?.absoluteURL,
        ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { continue }
      if url.pathExtension.lowercased() == "svg" { continue }  // UIImage cannot draw SVG.
      let score = rel.contains("apple-touch-icon") ? 3 : (attribute("sizes", in: element) != nil ? 2 : 1)
      if score > (best?.score ?? 0) { best = (score, url) }
    }
    return best?.url
  }

  private nonisolated static func attribute(_ name: String, in element: String) -> String? {
    let pattern = "\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))"
    guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive),
      let match = regex.firstMatch(in: element, range: NSRange(element.startIndex..., in: element)) else { return nil }
    for group in 1...3 {
      if let range = Range(match.range(at: group), in: element) { return String(element[range]) }
    }
    return nil
  }

  private nonisolated static func resized(_ image: UIImage) -> UIImage {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let size = CGSize(width: pixelSize, height: pixelSize)
    return UIGraphicsImageRenderer(size: size, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: size))
    }
  }

  // MARK: Disk cache

  private enum Cached { case hit(UIImage), miss }
  private nonisolated static var directory: URL {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appending(path: "LinkFavicons", directoryHint: .isDirectory)
  }
  private nonisolated static func file(_ host: String, _ suffix: String) -> URL {
    let digest = SHA256.hash(data: Data(host.utf8)).map { String(format: "%02x", $0) }.joined()
    return directory.appending(path: digest + suffix)
  }
  private nonisolated static func age(_ url: URL) -> TimeInterval? {
    guard let date = try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
    else { return nil }
    return Date().timeIntervalSince(date)
  }
  private nonisolated static func readCache(_ host: String) -> Cached? {
    let hit = file(host, ".png")
    if let age = age(hit), age < hitLifetime, let data = try? Data(contentsOf: hit), let image = UIImage(data: data) {
      return .hit(image)
    }
    if let age = age(file(host, ".miss")), age < missLifetime { return .miss }
    return nil
  }
  private nonisolated static func writeCache(_ host: String, _ image: UIImage?) {
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    if let data = image?.pngData() {
      try? data.write(to: file(host, ".png"), options: .atomic)
      try? FileManager.default.removeItem(at: file(host, ".miss"))
    } else {
      try? Data().write(to: file(host, ".miss"), options: .atomic)
    }
  }

  // MARK: Inline icons

  /// A square icon for inline text, drawn at the text's size: a skeleton while
  /// the site's icon loads, a globe when it has none. All hold the same space,
  /// so the message never reflows.
  static func inlineImage(_ state: State, size: CGFloat, fallback: UIColor) -> UIImage {
    let format = UIGraphicsImageRendererFormat()
    format.opaque = false
    let rect = CGRect(x: 0, y: 0, width: size, height: size)
    return UIGraphicsImageRenderer(size: rect.size, format: format).image { _ in
      UIBezierPath(roundedRect: rect, cornerRadius: size * 0.24).addClip()
      switch state {
      case .icon(let icon):
        // The icon sits inset on a white tile, like the reference: dark or
        // transparent icons stay legible on every bubble color.
        UIColor.white.setFill()
        UIRectFill(rect)
        icon.draw(in: rect.insetBy(dx: size * 0.16, dy: size * 0.16))
      case .loading:
        fallback.withAlphaComponent(0.22).setFill()
        UIRectFill(rect)
      case .missing:
        let configuration = UIImage.SymbolConfiguration(pointSize: size * 0.8, weight: .regular)
        let globe = UIImage(systemName: "globe", withConfiguration: configuration)?
          .withTintColor(fallback, renderingMode: .alwaysOriginal)
        if let globe {
          let side = size * 0.86
          globe.draw(in: CGRect(x: (size - side) / 2, y: (size - side) / 2, width: side, height: side))
        }
      }
    }
  }
}
