import SwiftUI
import UIKit

extension View {
  /// A reference sheet whose top corners are never rounder than the display corner on that
  /// side. On a folded iPhone Duo the outer display's left corners are much tighter than its
  /// right, so the sheet follows; elsewhere both corners stay at the usual 34 pt.
  func displayAwareSheet() -> some View {
    modifier(DisplayAwareSheet())
  }
}

/// The radii of a display's top-left and top-right corners, and its window's size.
private struct TopDisplayCorners: Equatable {
  var left: CGFloat
  var right: CGFloat
  var window: CGSize = .zero
}

private struct DisplayAwareSheet: ViewModifier {
  /// The size is needed before the sheet first lays out, so read the active window directly.
  @MainActor static var keyWindowSize: CGSize {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      .first { $0.activationState == .foregroundActive }?.keyWindow?.bounds.size ?? .zero
  }
  @State private var display = TopDisplayCorners(left: 34, right: 34)
  func body(content: Content) -> some View {
    let left = min(34, display.left), right = min(34, display.right)
    let window = display.window == .zero ? Self.keyWindowSize : display.window
    content
      .background(TopDisplayCornerProbe { display = $0 })
      // Wide displays get the full-height card; phones open at 98% of the height.
      .presentationDetents(window.width > 700 ? [.large] : [.fraction(0.98), .large])
      // The system rounds every corner alike, so clip to the tighter one and draw the
      // sheet's own surface with each corner's radius.
      .presentationCornerRadius(min(left, right))
      .presentationBackground {
        UnevenRoundedRectangle(
          topLeadingRadius: left, bottomLeadingRadius: 0, bottomTrailingRadius: 0,
          topTrailingRadius: right, style: .continuous
        ).fill(NativePalette.background)
      }
  }
}

/// Reports the radii of the top display corners of the window the view is in, using a
/// hidden window-sized view whose corners are concentric with the display.
private struct TopDisplayCornerProbe: UIViewRepresentable {
  var update: (TopDisplayCorners) -> Void
  func makeUIView(context: Context) -> ProbeView { ProbeView() }
  func updateUIView(_ view: ProbeView, context: Context) { view.update = update }

  final class ProbeView: UIView {
    var update: ((TopDisplayCorners) -> Void)?
    private let window_ = UIView()
    private var last: TopDisplayCorners?
    override init(frame: CGRect) {
      super.init(frame: frame)
      isUserInteractionEnabled = false
      window_.isUserInteractionEnabled = false
      window_.alpha = 0
      window_.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      if #available(iOS 26, *) { window_.cornerConfiguration = .corners(radius: .containerConcentric()) }
    }
    required init?(coder: NSCoder) { fatalError() }
    override func didMoveToWindow() {
      super.didMoveToWindow()
      guard let window else { window_.removeFromSuperview(); return }
      window.insertSubview(window_, at: 0)
      window_.frame = window.bounds
      setNeedsLayout()
    }
    override func layoutSubviews() {
      super.layoutSubviews()
      guard #available(iOS 26, *), let window else { return }
      window_.frame = window.bounds
      window_.layoutIfNeeded()
      let corners = TopDisplayCorners(
        left: window_.effectiveRadius(corner: .topLeft), right: window_.effectiveRadius(corner: .topRight),
        window: window.bounds.size)
      guard corners.left > 0 || corners.right > 0, corners != last else { return }
      last = corners
      let update = update
      DispatchQueue.main.async { update?(corners) }
    }
  }
}
