import SwiftUI
import UIKit

/// Views are constructed only for reusable visible cells, never for the entire
/// transcript. Stable delivery IDs keep a pending send's cell when it is accepted.
struct NativeHistoryItem {
  let id: String
  let scrollID: String
  let version: Int
  var anchorToBottom = false
  let content: () -> AnyView
}

struct HistoryScrollRequest: Equatable {
  let id: String
  var animated = true
  let token = UUID()
}

struct NativeMessageList: UIViewControllerRepresentable {
  let items: [NativeHistoryItem]
  var initialTarget = "bottom"
  var request: HistoryScrollRequest?
  var onPositioned: () -> Void = {}
  var onScroll: (_ atBottom: Bool, _ following: Bool) -> Void = { _, _ in }

  func makeUIViewController(context: Context) -> HistoryListController {
    let controller = HistoryListController()
    controller.initialTarget = initialTarget
    controller.onPositioned = onPositioned
    controller.onScroll = onScroll
    return controller
  }
  func updateUIViewController(_ controller: HistoryListController, context: Context) {
    controller.onPositioned = onPositioned
    controller.onScroll = onScroll
    controller.update(items, request: request)
  }
}

@MainActor final class HistoryListController: UIViewController, UITableViewDelegate, UIGestureRecognizerDelegate {
  private let table = HistoryTable(frame: .zero, style: .plain)
  private var source: UITableViewDiffableDataSource<Int, String>!
  private var items: [String: NativeHistoryItem] = [:]
  private var orderedIDs: [String] = []
  private var displayedIDs: [String] = []
  private var bottomAnchoredIDs = Set<String>()
  private var windowStart = 0
  private let windowSize = 80
  private var measuredHeights: [String: CGFloat] = [:]
  private var lastRequest: UUID?
  private var pendingRequest: HistoryScrollRequest?
  private var positioning = false
  private var positioned = false
  private var following = true
  private var updating = false
  private var needsApply = false
  private var pendingChanges = Set<String>()
  private var scrollingToTarget = false
  private var dragDirection: CGFloat = 0
  private var readingAnchor: Anchor?
  private var reported: (Bool, Bool)?
  private var lastBounds = CGSize.zero
  private var lastContent = CGSize.zero
  private var lastFooterHeight: CGFloat?
  private var footerDisplayLink: CADisplayLink?
  private var footerStartTime: CFTimeInterval = 0
  private var footerStartOffset: CGFloat = 0
  private var footerDuration: CFTimeInterval = 0.28
  private var settle: DispatchWorkItem?
  private var feedback = ScrollEdgeFeedback()
  var initialTarget = "bottom"
  var onPositioned: () -> Void = {}
  var onScroll: (Bool, Bool) -> Void = { _, _ in }

  override func loadView() {
    view = HistoryViewport()
    view.backgroundColor = .clear
    table.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(table)
    NSLayoutConstraint.activate([
      table.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      table.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      table.topAnchor.constraint(equalTo: view.topAnchor),
      table.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
    table.backgroundColor = .clear
    table.clipsToBounds = false
    table.separatorStyle = .none
    table.allowsSelection = false
    table.rowHeight = UITableView.automaticDimension
    table.estimatedRowHeight = 90
    table.sectionHeaderTopPadding = 0
    table.contentInsetAdjustmentBehavior = .automatic
    table.keyboardDismissMode = .interactive
    table.selfSizingInvalidation = .enabledIncludingConstraints
    table.isPrefetchingEnabled = false
    table.delegate = self
    let outsideTap = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboard(_:)))
    outsideTap.cancelsTouchesInView = false
    outsideTap.delegate = self
    table.addGestureRecognizer(outsideTap)
    table.accessibilityIdentifier = "chat-history"
    table.register(UITableViewCell.self, forCellReuseIdentifier: "message")
    table.didLayout = { [weak self] in self?.didLayout() }
    source = UITableViewDiffableDataSource<Int, String>(tableView: table) { [weak self] table, path, id in
      guard let self, let item = self.items[id] else { return nil }
      let cell = table.dequeueReusableCell(withIdentifier: "message", for: path)
      cell.backgroundColor = .clear
      cell.selectionStyle = .none
      cell.contentConfiguration = UIHostingConfiguration {
        item.content().id(id)
      }.margins(.all, 0).minSize(width: 0, height: 0)
      return cell
    }
  }

  func update(_ values: [NativeHistoryItem], request: HistoryScrollRequest?) {
    loadViewIfNeeded()
    let ids = values.map(\.id)
    let old = items
    let changed = Set(values.filter { old[$0.id]?.version != $0.version }.map(\.id))
    let oldVisible = displayedIDs
    items = Dictionary(uniqueKeysWithValues: values.map { ($0.id, $0) })
    if let request, request.token != lastRequest {
      lastRequest = request.token
      pendingRequest = request
    }
    let previousIDs = orderedIDs
    orderedIDs = ids
    if !positioned {
      centerWindow(on: initialTarget)
    } else if let request = pendingRequest {
      centerWindow(on: request.id)
    } else if following {
      windowStart = max(0, ids.count - windowSize)
    } else if let first = oldVisible.first, let index = ids.firstIndex(of: first) {
      windowStart = min(index, max(0, ids.count - windowSize))
    } else { windowStart = min(windowStart, max(0, ids.count - windowSize)) }
    let next = windowIDs
    guard oldVisible != next || !changed.isDisjoint(with: next) else {
      applyPendingRequest()
      return
    }
    let addedAtEnd = positioned && following && previousIDs != ids
      && previousIDs.last == ids.last
    applyWindow(changed: changed, animateArrival: addedAtEnd)
  }
  private var windowIDs: [String] {
    Array(orderedIDs.dropFirst(windowStart).prefix(windowSize))
  }
  private func centerWindow(on target: String) {
    if target == "bottom" { windowStart = max(0, orderedIDs.count - windowSize) }
    else if let index = orderedIDs.firstIndex(where: { items[$0]?.scrollID == target }) {
      windowStart = min(max(0, index - windowSize / 2), max(0, orderedIDs.count - windowSize))
    }
  }
  private func applyWindow(changed: Set<String> = [], animateArrival: Bool = false) {
    pendingChanges.formUnion(changed)
    guard !updating else { needsApply = true; return }
    stopFooterFollow()
    let next = windowIDs
    let oldIDs = Set(displayedIDs)
    let changes = pendingChanges
    pendingChanges.removeAll()
    let anchor = positioned ? captureAnchor(forContentUpdate: true) : nil
    displayedIDs = next
    bottomAnchoredIDs = Set(next.filter { items[$0]?.anchorToBottom == true })
    measuredHeights = measuredHeights.filter { items[$0.key] != nil }
    var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
    snapshot.appendSections([0])
    snapshot.appendItems(next)
    snapshot.reconfigureItems(next.filter { changes.contains($0) && oldIDs.contains($0) })
    updating = true
    let completed: () -> Void = { [weak self] in
      guard let self else { return }
      self.table.layoutIfNeeded()
      self.updating = false
      if let anchor {
        self.readingAnchor = self.following ? nil : anchor
        self.restore(anchor)
      }
      // A delivery acknowledgement, document resize or history response may
      // arrive while UIKit is applying the previous snapshot. Never drop it.
      if self.needsApply {
        self.needsApply = false
        self.applyWindow(animateArrival: animateArrival)
        return
      }
      if self.positioned && self.following {
        let destination = self.bottomOffset
        let oldOffset = self.table.contentOffset
        if animateArrival && !UIAccessibility.isReduceMotionEnabled {
          self.scrollingToTarget = true
          self.table.contentOffset = oldOffset
          UIView.animate(withDuration: 0.32, delay: 0, options: [.beginFromCurrentState, .curveEaseInOut]) {
            self.table.contentOffset = destination
          } completion: { _ in self.scrollingToTarget = false; self.reportScroll() }
        } else { self.table.setContentOffset(destination, animated: false) }
      }
      self.applyPendingRequest()
      self.didLayout()
    }
    source.apply(snapshot, animatingDifferences: false, completion: completed)
  }
  /// Keep UIKit's layout and accessibility working set bounded as well as its
  /// onscreen cells. Crossing either boundary shifts a contiguous overlapping
  /// window and retains the visible message's pixel position.
  private func advanceWindowIfNeeded() {
    guard positioned, !updating, !positioning, !scrollingToTarget, !following,
      let paths = table.indexPathsForVisibleRows, !paths.isEmpty else { return }
    let previous = windowStart
    // Only advance in the user's direction. A short-message viewport can span
    // both overlap thresholds after a shift; reacting to both would oscillate
    // between windows and prevent the user reaching older messages.
    if dragDirection > 0, (paths.map(\.row).min() ?? 0) < 16, windowStart > 0 {
      windowStart = max(0, windowStart - windowSize / 2)
    } else if dragDirection < 0, (paths.map(\.row).max() ?? 0) > displayedIDs.count - 17,
      windowStart + displayedIDs.count < orderedIDs.count {
      windowStart = min(max(0, orderedIDs.count - windowSize), windowStart + windowSize / 2)
    }
    if previous != windowStart { applyWindow() }
  }

  private var bottomOffset: CGPoint {
    CGPoint(x: 0, y: max(-table.adjustedContentInset.top,
      table.contentSize.height - table.bounds.height + table.adjustedContentInset.bottom))
  }
  private var atBottom: Bool {
    windowStart + displayedIDs.count == orderedIDs.count && bottomOffset.y - table.contentOffset.y <= 2
  }

  private func didLayout() {
    guard !updating, !positioning, table.bounds.height > 0, !orderedIDs.isEmpty else { return }
    let footerHeight = source.indexPath(for: "bottom")
      .flatMap { table.cellForRow(at: $0)?.bounds.height }
    let footerResized = footerHeight.flatMap { height in
      lastFooterHeight.map { abs(height - $0) > 0.5 }
    } ?? false
    let footerGrowing = (footerHeight ?? 0) > (lastFooterHeight ?? 0)
    lastFooterHeight = footerHeight
    let viewportResized = table.bounds.size != lastBounds
    for path in table.indexPathsForVisibleRows ?? [] {
      if let id = source.itemIdentifier(for: path), let cell = table.cellForRow(at: path) {
        measuredHeights[id] = cell.bounds.height
      }
    }
    let resized = table.bounds.size != lastBounds || table.contentSize != lastContent
    let room = table.bounds.height - table.safeAreaInsets.top - table.safeAreaInsets.bottom
    let extraTop = max(0, room - table.contentSize.height)
    if abs(table.contentInset.top - extraTop) > 0.5 {
      table.contentInset.top = extraTop
    }
    lastBounds = table.bounds.size
    lastContent = table.contentSize
    if !positioned {
      positioning = true
      scroll(to: initialTarget, animated: false)
      positioning = false
      // Wait for the first visible rows to self-size before removing the spinner.
      // Later asynchronous document resizes retain the same bottom/reading anchor.
      settle?.cancel()
      let work = DispatchWorkItem { [weak self] in
        guard let self, !self.positioned else { return }
        self.positioned = true
        self.following = self.initialTarget == "bottom"
        self.onPositioned()
        self.reportScroll()
      }
      settle = work
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: work)
    } else if resized && following && !table.isDragging && !scrollingToTarget {
      positioning = true
      if footerResized && !viewportResized && !UIAccessibility.isReduceMotionEnabled {
        // Hosting cells report the footer's final intrinsic height. Follow that
        // change with the same timing as the robot instead of jumping 64 points.
        startFooterFollow(duration: footerGrowing ? 0.28 : 0.24)
      } else {
        table.setContentOffset(bottomOffset, animated: false)
      }
      positioning = false
    } else if resized && !following && !table.isDragging && !table.isDecelerating,
      !scrollingToTarget, let readingAnchor {
      // Self-sizing hosting/document cells can finish after the snapshot's
      // completion. Preserve the same reading position through those updates.
      restore(readingAnchor)
    }
    if positioned { reportScroll() }
  }

  private func applyPendingRequest() {
    guard positioned, let request = pendingRequest else { return }
    guard let item = items.values.first(where: { $0.scrollID == request.id }),
      source.indexPath(for: item.id) != nil, !updating else { return }
    pendingRequest = nil
    following = request.id == "bottom"
    scroll(to: request.id, animated: request.animated && !UIAccessibility.isReduceMotionEnabled)
    reportScroll()
  }
  private func scroll(to id: String, animated: Bool) {
    stopFooterFollow()
    guard let item = items.values.first(where: { $0.scrollID == id }),
      let path = source.indexPath(for: item.id) else { return }
    scrollingToTarget = true
    readingAnchor = nil
    table.scrollToRow(at: path, at: id == "bottom" ? .bottom : .middle, animated: animated)
    if animated && id == "bottom" && atBottom { scrollingToTarget = false }
    if !animated {
      table.layoutIfNeeded()
      if id == "bottom" { table.setContentOffset(bottomOffset, animated: false) }
      scrollingToTarget = false
      if !following { readingAnchor = captureAnchor() }
    }
  }
  private struct Anchor { let id: String; let offset: CGFloat; let bottom: Bool }
  private func captureAnchor(forContentUpdate: Bool = false) -> Anchor? {
    // Pagination controls move when a page is inserted. Anchor an actual message
    // underneath them, otherwise loading earlier history jumps to the new page.
    guard let path = table.indexPathsForVisibleRows?.sorted().first(where: {
      guard let id = source.itemIdentifier(for: $0) else { return false }
      return !["earlier", "later", "bottom"].contains(id)
    }),
      let id = source.itemIdentifier(for: path) else { return nil }
    let bottom = forContentUpdate && bottomAnchoredIDs.contains(id) && items[id]?.anchorToBottom == false
    let rect = table.rectForRow(at: path)
    return Anchor(id: id, offset: (bottom ? rect.maxY : rect.minY) - table.contentOffset.y, bottom: bottom)
  }
  private func restore(_ anchor: Anchor) {
    guard let path = source.indexPath(for: anchor.id) else { return }
    positioning = true
    defer { positioning = false }
    // Resolve estimated heights around the anchor, then restore its pixel offset.
    if table.indexPathsForVisibleRows?.contains(path) != true {
      table.scrollToRow(at: path, at: .top, animated: false)
      table.layoutIfNeeded()
    }
    let rect = table.rectForRow(at: path)
    let y = (anchor.bottom ? rect.maxY : rect.minY) - anchor.offset
    if abs(table.contentOffset.y - y) > 0.5 {
      table.setContentOffset(CGPoint(x: 0, y: y), animated: false)
    }
  }
  func tableView(_ tableView: UITableView, estimatedHeightForRowAt indexPath: IndexPath) -> CGFloat {
    guard let id = source.itemIdentifier(for: indexPath) else { return 90 }
    return measuredHeights[id] ?? 90
  }
  func tableView(_ tableView: UITableView, willDisplay cell: UITableViewCell, forRowAt indexPath: IndexPath) {
    if let id = source.itemIdentifier(for: indexPath) { measuredHeights[id] = cell.bounds.height }
  }
  func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    stopFooterFollow()
    following = false
    scrollingToTarget = false
    readingAnchor = nil
    dragDirection = table.panGestureRecognizer.velocity(in: table).y
    feedback.begin()
    _ = feedback.observe(remaining: Double(bottomOffset.y - table.contentOffset.y), scrollable: true)
    reportScroll()
  }
  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    guard positioned, !updating, !positioning else { return }
    if table.isDragging {
      let velocity = table.panGestureRecognizer.velocity(in: table).y
      if abs(velocity) > 1 { dragDirection = velocity }
    }
    if feedback.observe(remaining: Double(max(0, bottomOffset.y - table.contentOffset.y)),
      scrollable: windowStart + displayedIDs.count == orderedIDs.count
        && table.contentSize.height > table.bounds.height) {
      NativeHaptics.play(.selection, source: "chat.latest-scroll")
    }
    advanceWindowIfNeeded()
    reportScroll()
  }
  func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    if !decelerate { endScroll() }
  }
  func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { endScroll() }
  func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
    scrollingToTarget = false
    if !following { readingAnchor = captureAnchor() }
    reportScroll()
  }
  private func endScroll() {
    dragDirection = 0
    if atBottom { following = true }
    readingAnchor = following ? nil : captureAnchor()
    feedback.end()
    reportScroll()
  }
  private func reportScroll() {
    guard positioned else { return }
    let value = (atBottom, following)
    guard reported?.0 != value.0 || reported?.1 != value.1 else { return }
    reported = value
    DispatchQueue.main.async { [weak self] in self?.onScroll(value.0, value.1) }
  }
  private func startFooterFollow(duration: CFTimeInterval) {
    stopFooterFollow()
    footerStartTime = CACurrentMediaTime()
    footerStartOffset = table.contentOffset.y
    footerDuration = duration
    scrollingToTarget = true
    let link = CADisplayLink(target: self, selector: #selector(followFooter(_:)))
    let rate = Float(view.window?.screen.maximumFramesPerSecond ?? 60)
    link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: rate, preferred: rate)
    footerDisplayLink = link
    link.add(to: .main, forMode: .common)
  }
  @objc private func followFooter(_ link: CADisplayLink) {
    guard following, !table.isDragging else { stopFooterFollow(); return }
    let progress = min(1, max(0, (link.timestamp - footerStartTime) / footerDuration))
    let eased = progress * progress * (3 - 2 * progress)
    // Re-read the destination as hosting cells finish sizing. Animating UIKit's
    // contentOffset property directly can also animate self-sizing layout and
    // leave the final reply underneath the composer after the footer collapses.
    let y = footerStartOffset + (bottomOffset.y - footerStartOffset) * eased
    positioning = true
    table.setContentOffset(CGPoint(x: 0, y: y), animated: false)
    positioning = false
    if progress >= 1 { stopFooterFollow(); reportScroll() }
  }
  private func stopFooterFollow() {
    guard footerDisplayLink != nil else { return }
    footerDisplayLink?.invalidate()
    footerDisplayLink = nil
    scrollingToTarget = false
  }
  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    stopFooterFollow()
  }
  @objc private func dismissKeyboard(_ gesture: UITapGestureRecognizer) {
    guard view.safeAreaLayoutGuide.layoutFrame.contains(gesture.location(in: view)) else { return }
    view.window?.endEditing(true)
  }
  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    guard view.safeAreaLayoutGuide.layoutFrame.contains(touch.location(in: view)) else { return false }
    var candidate = touch.view
    while let view = candidate, view !== table {
      if view is UIControl || view is UITextView || view is UITextField { return false }
      candidate = view.superview
    }
    return true
  }
  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }
}

/// History paints beneath the floating glass bars, but those pixels must never
/// receive touches belonging to the composer or header outside this viewport.
@MainActor private final class HistoryViewport: UIView {
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard safeAreaLayoutGuide.layoutFrame.contains(point) else { return nil }
    return super.hitTest(point, with: event)
  }
}

@MainActor private final class HistoryTable: UITableView {
  var didLayout: (() -> Void)?
  override func layoutSubviews() {
    super.layoutSubviews()
    didLayout?()
  }
}
