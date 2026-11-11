import SwiftUI
import UIKit

/// Native links use a local globe. Do not fetch icons from message-supplied
/// hosts: URLSession cannot pin public DNS answers while preserving host TLS.
/// Remote icons can return only with a transport that enforces that boundary
/// for the page, declared icons and every redirect.
@MainActor final class FaviconStore {
  static let shared = FaviconStore()
  enum State { case loading, icon(UIImage), missing }

  func state(for url: URL) -> State { .missing }
  func load(_ host: String) async -> UIImage? { nil }
  func dataURL(_ host: String) async -> String? { nil }

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
