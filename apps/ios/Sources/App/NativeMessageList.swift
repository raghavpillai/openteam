import SwiftUI
import UIKit

/// Views are constructed only for reusable visible cells, never for the entire
/// transcript. Stable delivery IDs keep a pending send's cell when it is accepted.
struct NativeHistoryItem {
  let id: String
  let scrollID: String
  let version: Int
  var anchorToBottom = false
  var animatesResize = false
  let content: () -> AnyView
}

struct HistoryScrollRequest: Equatable {
  let id: String
  var animated = true
  let token = UUID()
}

struct NativeMessageList: UIViewControllerRepresentable {
  enum InitialLayout { case settled, nextLayout }
  let items: [NativeHistoryItem]
  var initialTarget = "bottom"
  var initialLayout = InitialLayout.settled
  var request: HistoryScrollRequest?
  var onPositioned: () -> Void = {}
  var onScroll: (_ atBottom: Bool, _ following: Bool) -> Void = { _, _ in }

  func makeUIViewController(context: Context) -> HistoryListController {
    let controller = HistoryListController()
    controller.initialTarget = initialTarget
    controller.initialLayout = initialLayout
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
  private var pendingArrival = false
  private var pendingResize = false
  private var scrollingToTarget = false
  private var dragDirection: CGFloat = 0
  private var readingAnchor: Anchor?
  private var reported: (Bool, Bool)?
  private var lastBounds = CGSize.zero
  private var lastContent = CGSize.zero
  private var lastFooterHeight: CGFloat?
  private var followingResize = false
  private var resizePinnedOffset: CGPoint?
  private var footerDisplayLink: CADisplayLink?
  private var footerStartTime: CFTimeInterval = 0
  private var footerStartOffset: CGFloat = 0
  private var footerTargetOffset: CGFloat = 0
  private var footerDuration: CFTimeInterval = 0.28
  private var footerCollapsing = false
  #if DEBUG
  private let recordsMotion = ProcessInfo.processInfo.arguments.contains("--trace-chat-layout")
  private var motionSamples: [[Double]] = []
  private var motionRecords: [[String: Any]] = []
  #endif
  private var settle: DispatchWorkItem?
  private var initialLayoutGeneration = 0
  private var feedback = ScrollEdgeFeedback()
  var initialTarget = "bottom"
  var initialLayout = NativeMessageList.InitialLayout.settled
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
    // Browsing history should leave the composer in either scroll direction,
    // rather than requiring a downward drag that reaches the keyboard.
    table.keyboardDismissMode = .onDrag
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
        if item.animatesResize {
          VStack(spacing: 0) {
            item.content().id(id)
            Spacer(minLength: 0)
          }
        } else { item.content().id(id) }
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
    let resize = positioned && values.contains { changed.contains($0.id) && $0.animatesResize }
    applyWindow(changed: changed, animateArrival: addedAtEnd, animateResize: resize)
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
  private func applyWindow(changed: Set<String> = [], animateArrival: Bool = false, animateResize: Bool = false) {
    pendingChanges.formUnion(changed)
    pendingArrival = pendingArrival || animateArrival
    pendingResize = pendingResize || animateResize
    guard !updating else { needsApply = true; return }
    stopFooterFollow()
    let next = windowIDs
    let oldIDs = Set(displayedIDs)
    let changes = pendingChanges
    pendingChanges.removeAll()
    let anchor = positioned ? captureAnchor(forContentUpdate: true) : nil
    let arrival = pendingArrival
    let resize = pendingResize && next == displayedIDs && !UIAccessibility.isReduceMotionEnabled
      && !table.isDragging && !table.isDecelerating
    pendingArrival = false
    pendingResize = false
    displayedIDs = next
    bottomAnchoredIDs = Set(next.filter { items[$0]?.anchorToBottom == true })
    measuredHeights = measuredHeights.filter { items[$0.key] != nil }
    var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
    snapshot.appendSections([0])
    snapshot.appendItems(next)
    snapshot.reconfigureItems(next.filter { changes.contains($0) && oldIDs.contains($0) })
    updating = true
    let previousHeight = table.contentSize.height
    let previousFooterHeight = lastFooterHeight
    followingResize = resize && following
    resizePinnedOffset = followingResize ? table.contentOffset : nil
    let completed: () -> Void = { [weak self] in
      guard let self else { return }
      self.table.layoutIfNeeded()
      var deferredFooterChange: CGFloat = 0
      self.resizePinnedOffset = nil
      if self.followingResize && self.following {
        if let previousFooterHeight,
          let path = self.source.indexPath(for: "bottom"),
          let height = self.table.cellForRow(at: path)?.bounds.height {
          deferredFooterChange = height - previousFooterHeight
          self.lastFooterHeight = height
        }
        UIView.performWithoutAnimation {
          let room = self.table.bounds.height - self.table.safeAreaInsets.top - self.table.safeAreaInsets.bottom
          self.table.contentInset.top = max(0, room - self.table.contentSize.height)
          // A working footer can start while the card is still shrinking.
          // Finish at the card's current visual bottom, then follow the footer
          // instead of snapping immediately to the combined final geometry.
          self.table.contentOffset = CGPoint(x: 0, y: self.bottomOffset.y - deferredFooterChange)
          self.table.layer.removeAnimation(forKey: "widget-bottom-follow")
        }
        self.followingResize = false
      }
      self.updating = false
      self.followingResize = false
      self.table.layer.removeAnimation(forKey: "widget-bottom-follow")
      if let anchor, (!resize || !self.following), !self.table.isDragging, !self.table.isDecelerating {
        self.readingAnchor = self.following ? nil : anchor
        self.restore(anchor)
      }
      // A delivery acknowledgement, document resize or history response may
      // arrive while UIKit is applying the previous snapshot. Never drop it.
      if self.needsApply {
        self.needsApply = false
        self.applyWindow()
        return
      }
      if self.positioned && self.following {
        let destination = self.bottomOffset
        let oldOffset = self.table.contentOffset
        if abs(deferredFooterChange) > 0.5 && !UIAccessibility.isReduceMotionEnabled {
          self.lastBounds = self.table.bounds.size
          self.lastContent = self.table.contentSize
          self.startFooterFollow(duration: deferredFooterChange > 0
            ? ChatActivityTiming.expansion : ChatActivityTiming.collapse, from: oldOffset.y)
        } else if arrival && !UIAccessibility.isReduceMotionEnabled {
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
    if resize {
      // Reconfigure and resize the hosting cell inside the same UIKit animation
      // that follows its bottom edge. The old nonanimated snapshot caused a
      // height jump, followed one frame later by a content-offset jump.
      UIView.animate(withDuration: 0.24, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) {
        self.source.apply(snapshot, animatingDifferences: true, completion: completed)
        self.table.layoutIfNeeded()
        if self.followingResize {
          let movement = CABasicAnimation(keyPath: "transform.translation.y")
          movement.fromValue = 0
          movement.toValue = previousHeight - self.table.contentSize.height
          movement.duration = 0.24
          movement.timingFunction = CAMediaTimingFunction(name: .easeOut)
          movement.fillMode = .forwards
          movement.isRemovedOnCompletion = false
          self.table.layer.add(movement, forKey: "widget-bottom-follow")
        }
      }
    } else { source.apply(snapshot, animatingDifferences: false, completion: completed) }
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
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    defer { CATransaction.commit() }
    let previousBottom = max(-table.adjustedContentInset.top,
      lastContent.height - lastBounds.height + table.adjustedContentInset.bottom)
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
      // Main history waits for its first self-sizing rows. Cached reply pages
      // can join the native push as soon as their layout stops changing.
      // Later document resizes retain the same bottom/reading anchor.
      settle?.cancel()
      initialLayoutGeneration += 1
      let generation = initialLayoutGeneration
      let work = DispatchWorkItem { [weak self] in
        guard let self, !self.positioned, !self.updating else { return }
        self.table.layoutIfNeeded()
        guard self.initialLayoutGeneration == generation else { return }
        self.positioned = true
        self.following = self.initialTarget == "bottom"
        self.onPositioned()
        self.reportScroll()
      }
      settle = work
      if initialLayout == .nextLayout {
        DispatchQueue.main.async(execute: work)
      } else {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: work)
      }
    } else if resized && following && !table.isDragging && !scrollingToTarget {
      positioning = true
      if footerResized && !viewportResized && !UIAccessibility.isReduceMotionEnabled {
        // Hosting cells report the footer's final intrinsic height. Follow that
        // change with the same timing as the robot instead of jumping 64 points.
        startFooterFollow(
          duration: footerGrowing ? ChatActivityTiming.expansion : ChatActivityTiming.collapse,
          from: previousBottom)
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
    resizePinnedOffset = nil
    table.layer.removeAnimation(forKey: "widget-bottom-follow")
    following = false
    scrollingToTarget = false
    readingAnchor = nil
    dragDirection = table.panGestureRecognizer.velocity(in: table).y
    feedback.begin()
    _ = feedback.observe(remaining: Double(bottomOffset.y - table.contentOffset.y), scrollable: true)
    reportScroll()
  }
  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    if !positioning, let pinned = resizePinnedOffset,
      abs(table.contentOffset.y - pinned.y) > 0.5 {
      // UITableView may clamp its offset on the final self-sizing frame before
      // its snapshot completion runs. Keep that model correction from flashing
      // underneath the presentation-layer bottom-follow animation.
      positioning = true
      table.setContentOffset(pinned, animated: false)
      positioning = false
      return
    }
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
  private func startFooterFollow(duration: CFTimeInterval, from offset: CGFloat) {
    stopFooterFollow()
    footerStartTime = CACurrentMediaTime()
    footerStartOffset = offset
    footerDuration = duration
    footerCollapsing = bottomOffset.y < offset
    animateFooterOffset(from: offset, to: bottomOffset.y, duration: duration)
    #if DEBUG
    if recordsMotion { motionSamples = [[0, Double(offset), Double(bottomOffset.y)]] }
    #endif
    scrollingToTarget = true
    let link = CADisplayLink(target: self, selector: #selector(followFooter(_:)))
    let rate = Float(view.window?.screen.maximumFramesPerSecond ?? 60)
    link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: rate, preferred: rate)
    footerDisplayLink = link
    link.add(to: .main, forMode: .common)
  }
  private func animateFooterOffset(from start: CGFloat, to target: CGFloat, duration: CFTimeInterval) {
    footerTargetOffset = target
    // Animate the scroll layer's presentation, while its model already has the
    // final offset. Repeated model-offset writes let UIKit expose an intermediate
    // clamp frame when a self-sizing footer appears or disappears.
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    positioning = true
    table.setContentOffset(CGPoint(x: 0, y: target), animated: false)
    positioning = false
    let movement = CABasicAnimation(keyPath: "bounds.origin.y")
    movement.fromValue = start
    movement.toValue = target
    movement.duration = max(0.001, duration)
    movement.timingFunction = footerCollapsing
      ? CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.3, 1)
      : CAMediaTimingFunction(name: .easeInEaseOut)
    table.layer.add(movement, forKey: "activity-bottom-follow")
    CATransaction.commit()
  }
  @objc private func followFooter(_ link: CADisplayLink) {
    guard following, !table.isDragging else { stopFooterFollow(); return }
    let elapsed = max(0, link.timestamp - footerStartTime)
    let progress = min(1, elapsed / footerDuration)
    let presented = table.layer.presentation()?.bounds.origin.y ?? table.contentOffset.y
    if abs(bottomOffset.y - footerTargetOffset) > 0.5 {
      animateFooterOffset(from: presented, to: bottomOffset.y, duration: footerDuration - elapsed)
    }
    #if DEBUG
    if recordsMotion { motionSamples.append([elapsed, Double(presented), Double(bottomOffset.y)]) }
    #endif
    if progress >= 1 { stopFooterFollow(); reportScroll() }
  }
  private func stopFooterFollow() {
    guard footerDisplayLink != nil else { return }
    let presented = table.layer.presentation()?.bounds.origin ?? table.contentOffset
    footerDisplayLink?.invalidate()
    footerDisplayLink = nil
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    table.layer.removeAnimation(forKey: "activity-bottom-follow")
    positioning = true
    table.setContentOffset(presented, animated: false)
    positioning = false
    CATransaction.commit()
    scrollingToTarget = false
    #if DEBUG
    if recordsMotion, !motionSamples.isEmpty {
      // Optional QA evidence: numeric geometry only, buffered until movement
      // ends. This distinguishes recorder gaps from missed display-link ticks.
      motionRecords.append(["duration": footerDuration, "samples": motionSamples,
        "completed": (motionSamples.last?.first ?? 0) >= footerDuration])
      if let data = try? JSONSerialization.data(withJSONObject: motionRecords) {
        try? data.write(to: FileManager.default.temporaryDirectory
          .appendingPathComponent("chat-motion-diagnostics.json"), options: .atomic)
      }
      motionSamples = []
    }
    #endif
  }
  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    followingResize = false
    resizePinnedOffset = nil
    table.layer.removeAnimation(forKey: "widget-bottom-follow")
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
