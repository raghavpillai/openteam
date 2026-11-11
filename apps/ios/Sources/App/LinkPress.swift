import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass
import os

/// Tracks which chat link, if any, is under the finger, so a long press on a link
/// opens link actions instead of the message's. Plain text reports where its links
/// are drawn (``LinkRegion``); rich documents report their pressed link from WebKit.
@MainActor @Observable final class LinkPress {
  static let shared = LinkPress()
  /// The link under the finger. Drawn highlighted while the touch lasts.
  private(set) var current: URL?
  @ObservationIgnored private let regions = NSHashTable<LinkRegion>.weakObjects()

  func register(_ region: LinkRegion) { regions.add(region) }
  func touchBegan(at point: CGPoint) {
    let hit = regions.allObjects.lazy.compactMap { $0.link(at: point) }.first
    if hit != current { current = hit }
  }
  /// A rich document's script reports its own pressed link and its release.
  func setDocumentLink(_ url: URL?) { if url != current { current = url } }
  func touchEnded() { if current != nil { current = nil } }

  /// Watches touches in every window without taking part in gesture handling.
  func installTracker() {
    for window in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
      .flatMap(\.windows)
    where !(window.gestureRecognizers ?? []).contains(where: { $0 is LinkTouchTracker }) {
      window.addGestureRecognizer(LinkTouchTracker())
    }
  }
}

/// Where one plain-text block draws its links. ``LinkGeometryRenderer`` writes
/// the rects in the text's own space; the view keeps its frame in window space.
final class LinkRegion: @unchecked Sendable {
  private let state = OSAllocatedUnfairLock(initialState: (rects: [(URL, CGRect)](), frame: CGRect.null))
  func update(rects: [(URL, CGRect)]) { state.withLock { $0.rects = rects } }
  func update(frame: CGRect) { state.withLock { $0.frame = frame } }
  func link(at point: CGPoint) -> URL? {
    state.withLock { value in
      guard !value.frame.isNull, value.frame.insetBy(dx: -8, dy: -8).contains(point) else { return nil }
      let local = CGPoint(x: point.x - value.frame.minX, y: point.y - value.frame.minY)
      return value.rects.first { $0.1.insetBy(dx: -4, dy: -4).contains(local) }?.0
    }
  }
}

/// Marks the text runs that belong to a link, so the renderer can find them.
struct LinkRunTag: TextAttribute { let url: URL }

/// Draws text normally, records each link's rects, and shades the pressed link.
struct LinkGeometryRenderer: TextRenderer {
  let region: LinkRegion
  let pressed: URL?
  let highlight: Color
  func draw(layout: Text.Layout, in context: inout GraphicsContext) {
    var rects: [(URL, CGRect)] = []
    for line in layout {
      for run in line {
        if let tag = run[LinkRunTag.self] {
          let rect = run.typographicBounds.rect
          rects.append((tag.url, rect))
          if tag.url == pressed {
            context.fill(Path(roundedRect: rect.insetBy(dx: -2, dy: -1), cornerRadius: 5), with: .color(highlight))
          }
        }
        context.draw(run)
      }
    }
    region.update(rects: rects)
  }
}

/// Records touch-down and release only. It never recognizes, cancels or delays
/// touches, so scrolling, taps and the message gestures behave as before.
final class LinkTouchTracker: UIGestureRecognizer, UIGestureRecognizerDelegate {
  private var start: CGPoint?
  init() {
    super.init(target: nil, action: nil)
    cancelsTouchesInView = false
    delaysTouchesBegan = false
    delaysTouchesEnded = false
    delegate = self
  }
  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    guard let window = view, let touch = touches.first, event.allTouches?.count == 1 else {
      finish()
      return
    }
    let point = touch.location(in: window)
    start = point
    MainActor.assumeIsolated { LinkPress.shared.touchBegan(at: point) }
  }
  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
    guard let window = view, let start, let touch = touches.first else { return }
    let point = touch.location(in: window)
    if hypot(point.x - start.x, point.y - start.y) > 10 { finish() }
  }
  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) { finish() }
  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { finish() }
  override func reset() { start = nil }
  private func finish() {
    start = nil
    MainActor.assumeIsolated { LinkPress.shared.touchEnded() }
    if state == .possible { state = .failed }
  }
  override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
  override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }
  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool { true }
}

/// The sheet a long press on a link opens, as in the reference design: the
/// address, then link actions, on the system's Liquid Glass sheet. System text
/// colors keep it legible on glass; app palette colors are too faint there.
struct LinkActionsView: View {
  let url: URL
  var onOpen: () -> Void
  var onCopy: () -> Void
  var onShare: () -> Void
  @State private var height: CGFloat = 260
  @Environment(\.horizontalSizeClass) private var sizeClass
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      VStack(alignment: .leading, spacing: 3) {
        Text("Link").font(.footnote).foregroundStyle(.secondary)
        Text(url.absoluteString).font(.body).lineLimit(4).fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("link-actions-url")
      }.padding(.horizontal, 6)
      VStack(spacing: 0) {
        action("Open", "arrow.up.forward.app", onOpen)
        Divider().padding(.leading, 54)
        action("Copy Link", "square.on.square", onCopy)
        Divider().padding(.leading, 54)
        action("Share", "square.and.arrow.up", onShare)
      }.background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 16))
    }
    .padding(.horizontal, 16).padding(.top, 30).padding(.bottom, 16)
    .foregroundStyle(.primary)
    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
    .frame(maxHeight: .infinity, alignment: .top)
    // Phones: a half-height sheet over the conversation. Wider windows: a card
    // that fits its actions. No custom background, so the sheet keeps the
    // system's translucent glass.
    .presentationDetents([sizeClass == .compact ? .medium : .height(height)])
    .presentationDragIndicator(.visible)
  }
  private func action(_ title: String, _ symbol: String, _ perform: @escaping () -> Void) -> some View {
    Button(action: perform) {
      HStack(spacing: 14) {
        Image(systemName: symbol).font(.system(size: 19)).frame(width: 22)
        Text(title).font(.body)
        Spacer()
      }.padding(.horizontal, 18).frame(height: 54).contentShape(Rectangle())
    }.buttonStyle(.plain)
  }
}
