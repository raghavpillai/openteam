import SwiftUI
import UIKit

/// SwiftUI's linguistic line breaker can insert visible hyphens into long
/// identifiers. Keep those literal tokens unchanged, without changing ordinary
/// prose, Markdown, links or the message's underlying/copyable content.
struct IdentifierMessageText: UIViewRepresentable {
  let source: String
  let color: Color
  @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 17
  @MainActor static func requiresNativeWrapping(_ source: String) -> Bool {
    guard !source.contains("`"), !source.contains("*"), !source.contains("["),
      source.range(of: "[A-Z0-9_]{24,}", options: .regularExpression) != nil else { return false }
    let parsed = MessageTextCache.inline(source)
    return String(parsed.characters) == source && parsed.runs.allSatisfy {
      ($0.inlinePresentationIntent?.isEmpty ?? true) && $0.link == nil
    }
  }
  func makeUIView(context: Context) -> UILabel {
    let label = UILabel()
    label.numberOfLines = 0
    label.lineBreakMode = .byWordWrapping
    label.lineBreakStrategy = .standard
    label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return label
  }
  func updateUIView(_ label: UILabel, context: Context) {
    let style = NSMutableParagraphStyle()
    style.lineBreakMode = .byWordWrapping
    style.lineBreakStrategy = .standard
    style.hyphenationFactor = 0
    style.usesDefaultHyphenation = false
    style.lineSpacing = 1.5
    label.attributedText = NSAttributedString(string: source, attributes: [
      .font: UIFont.systemFont(ofSize: fontSize), .foregroundColor: UIColor(color), .paragraphStyle: style,
    ])
    label.accessibilityLabel = source
  }
  func sizeThatFits(_ proposal: ProposedViewSize, uiView: UILabel, context: Context) -> CGSize? {
    guard let width = proposal.width, width > 0 else { return nil }
    let size = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    return CGSize(width: min(width, size.width), height: ceil(size.height * 3) / 3)
  }
}
