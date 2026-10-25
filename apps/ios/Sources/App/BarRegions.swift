import SwiftUI
import UIKit

/// Where system bars go on this screen, from UIKit's bar layout regions
/// (iOS 27.1). On iPhone Duo they follow the status bar, the camera, the
/// Dynamic Island and Live Activities, which change height while the app runs.
struct BarRegions: Equatable {
  /// The edge iOS puts vertical bars on, if any.
  var sideEdge: HorizontalEdge?
  /// The side region's width and its usable span, from the screen's top and bottom.
  var sideWidth: CGFloat = 0
  var sideTop: CGFloat = 0
  var sideBottom: CGFloat = 0
  /// Where a top bar's region begins, from the screen's top.
  var top: CGFloat = 0

  static let none = BarRegions()
  /// Height of the top bar the regions are measured for.
  static let topBarExtent: CGFloat = 44
}

extension View {
  /// Reports the window's bar regions now and whenever they change.
  func readingBarRegions(_ update: @escaping (BarRegions) -> Void) -> some View {
    modifier(BarRegionsReader(update: update))
  }
}

private struct BarRegionsReader: ViewModifier {
  var update: (BarRegions) -> Void
  func body(content: Content) -> some View {
    if #available(iOS 27.1, *) {
      content.modifier(VerticalBarEdgeReader(update: update))
    } else {
      content
    }
  }
}

@available(iOS 27.1, *)
private struct VerticalBarEdgeReader: ViewModifier {
  @Environment(\.toolbarVerticalEdge) private var edge
  var update: (BarRegions) -> Void
  func body(content: Content) -> some View {
    content.background(BarRegionProbe(edge: edge, update: update).allowsHitTesting(false))
  }
}

/// Pins two markers to the window's top and side bar layout guides. The guides
/// move with the status area, so the markers resize and report each change.
@available(iOS 27.1, *)
private struct BarRegionProbe: UIViewRepresentable {
  var edge: HorizontalEdge?
  var update: (BarRegions) -> Void
  func makeUIView(context: Context) -> ProbeView { ProbeView() }
  func updateUIView(_ view: ProbeView, context: Context) {
    view.edge = edge
    view.update = update
    view.report()
  }

  final class ProbeView: UIView {
    var edge: HorizontalEdge? { didSet { if edge != oldValue { pin() } } }
    var update: ((BarRegions) -> Void)?
    private var last: BarRegions?
    private let topMarker = Marker(), sideMarker = Marker()
    private var pins: [NSLayoutConstraint] = []

    override init(frame: CGRect) {
      super.init(frame: frame)
      isHidden = true
      for marker in [topMarker, sideMarker] {
        marker.translatesAutoresizingMaskIntoConstraints = false
        marker.onLayout = { [weak self] in self?.report() }
        addSubview(marker)
      }
    }
    required init?(coder: NSCoder) { fatalError() }

    override func didMoveToWindow() {
      super.didMoveToWindow()
      pin()
    }
    override func safeAreaInsetsDidChange() {
      super.safeAreaInsetsDidChange()
      pin()
    }
    override func layoutSubviews() {
      super.layoutSubviews()
      report()
    }

    private var sideRegion: UIView.LayoutRegion? {
      guard let window, let edge, sideWidth(window) > 0 else { return nil }
      return .bar(onEdge: edge == .trailing ? .trailing : .leading, extent: sideWidth(window))
    }
    private func sideWidth(_ window: UIWindow) -> CGFloat {
      let insets = window.safeAreaInsets
      return edge == .leading ? insets.left : insets.right
    }

    private func pin() {
      NSLayoutConstraint.deactivate(pins)
      pins = []
      guard let window else { return }
      let top = window.layoutGuide(for: .bar(onEdge: UIRectEdge.top, extent: BarRegions.topBarExtent))
      pins += [
        topMarker.topAnchor.constraint(equalTo: top.topAnchor),
        topMarker.bottomAnchor.constraint(equalTo: top.bottomAnchor),
        topMarker.leadingAnchor.constraint(equalTo: leadingAnchor),
        topMarker.widthAnchor.constraint(equalToConstant: 1),
      ]
      if let region = sideRegion {
        let side = window.layoutGuide(for: region)
        pins += [
          sideMarker.topAnchor.constraint(equalTo: side.topAnchor),
          sideMarker.bottomAnchor.constraint(equalTo: side.bottomAnchor),
          sideMarker.leadingAnchor.constraint(equalTo: leadingAnchor),
          sideMarker.widthAnchor.constraint(equalToConstant: 1),
        ]
      }
      NSLayoutConstraint.activate(pins)
      report()
    }

    func report() {
      guard let window else { return }
      var regions = BarRegions(top: window.edgeInsets(for: .bar(onEdge: UIRectEdge.top, extent: BarRegions.topBarExtent)).top)
      if let region = sideRegion {
        let insets = window.edgeInsets(for: region)
        regions.sideEdge = edge
        regions.sideWidth = sideWidth(window)
        regions.sideTop = insets.top
        regions.sideBottom = insets.bottom
      }
      guard regions != last else { return }
      last = regions
      let update = update
      DispatchQueue.main.async { update?(regions) }
    }
  }

  final class Marker: UIView {
    var onLayout: (() -> Void)?
    override func layoutSubviews() {
      super.layoutSubviews()
      onLayout?()
    }
  }
}
