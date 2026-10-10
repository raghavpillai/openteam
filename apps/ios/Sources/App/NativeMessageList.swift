import SwiftUI
import UIKit

/// Asynchronous document views participate in the first-paint barrier. Media
/// with a reserved frame need not finish downloading before history is shown.
@MainActor protocol HistoryLayoutReadiness {
  var historyLayoutReady: Bool { get }
}

/// Views are constructed only for reusable visible cells, never for the entire
/// transcript. Stable delivery IDs keep a pending send's cell when it is accepted.
struct NativeHistoryItem {
  let id: String
  let scrollID: String
  let version: Int
  var anchorToBottom = false
  var animatesResize = false
  /// Prepares asynchronously sized content (WebKit documents) before the row
  /// scrolls into view, so it is displayed at its final height.
  var prefetch: (() -> Void)?
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
    MessageDocuments.prewarm()
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
  private var relocationSnapshot: UIView?
  private var relocationReveal: DispatchWorkItem?
  private var reported: (Bool, Bool)?
  private var lastBounds = CGSize.zero
  private var lastContent = CGSize.zero
  private var lastFooterHeight: CGFloat?
  private var layoutRows: [String: CGRect] = [:]
  private var layoutStart: (offset: CGFloat, rows: [String: CGRect])?
  private var prefetched = Set<String>()
  private var prefetchedRange: ClosedRange<Int>?
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
  private let tracesFrames = ProcessInfo.processInfo.arguments.contains("--trace-scroll-frames")
  private var frameTraceLink: CADisplayLink?
  private var frameTrace: [[String: Any]] = []
  private var lastFrameSignature = ""
  private var frameTraceWrite: DispatchWorkItem?
  private struct CommittedRow { let id: String; let frame: CGRect; weak var cell: UITableViewCell?; let hidden: Int }
  private var committedRows: [CommittedRow] = []
  private var committedOffset: CGFloat = 0
  private var commitObserver: CFRunLoopObserver?
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
    table.willLayout = { [weak self] in self?.captureLayoutStart() }
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
    #if DEBUG
    if tracesFrames {
      let link = CADisplayLink(target: self, selector: #selector(traceFrame(_:)))
      link.add(to: .main, forMode: .common)
      frameTraceLink = link
      // Runs after Core Animation's commit observer: the geometry committed for
      // display, rather than model values changed by events earlier this turn.
      let observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, 2_000_001) {
        [weak self] _, _ in MainActor.assumeIsolated { self?.captureCommittedGeometry() }
      }
      CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
      commitObserver = observer
    }
    if ProcessInfo.processInfo.arguments.contains("--ui-testing-scroll-geometry") {
      table.scrollGeometry = { [weak self] in
        guard let self else { return nil }
        let viewport = self.view.safeAreaLayoutGuide.layoutFrame
        let rows: [[String: Any]] = self.table.visibleCells.compactMap { cell in
          guard let path = self.table.indexPath(for: cell),
            let id = self.source.itemIdentifier(for: path), let item = self.items[id] else { return nil }
          let frame = cell.convert(cell.bounds, to: self.view)
          guard frame.intersects(viewport) else { return nil }
          return ["id": item.scrollID, "y": frame.minY, "height": frame.height]
        }.sorted { ($0["y"] as? CGFloat ?? 0) < ($1["y"] as? CGFloat ?? 0) }
        let value: [String: Any] = ["rows": rows, "mounted": self.displayedIDs.count,
          "offset": self.table.contentOffset.y, "following": self.following,
          "viewportTop": viewport.minY, "viewportBottom": viewport.maxY,
          "moving": self.table.isDragging || self.table.isDecelerating || self.positioning || self.updating || self.scrollingToTarget]
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return String(data: data, encoding: .utf8)
      }
    }
    #endif
  }

  func update(_ values: [NativeHistoryItem], request: HistoryScrollRequest?) {
    loadViewIfNeeded()
    let ids = values.map(\.id)
    let old = items
    let changed = Set(values.filter { old[$0.id]?.version != $0.version }.map(\.id))
    let oldVisible = displayedIDs
    let visibleAnchorID = positioned ? captureAnchor()?.id : nil
    items = Dictionary(uniqueKeysWithValues: values.map { ($0.id, $0) })
    if let request, request.token != lastRequest {
      lastRequest = request.token
      var resolved = request
      // A distant destination replaces the bounded history window. Animating
      // from its old numeric offset would briefly display unrelated messages
      // from the replacement window before reaching the requested row.
      let target = request.id == "bottom"
        ? values.last(where: { $0.id != "bottom" && $0.id != "later" })
        : values.first(where: { $0.scrollID == request.id })
      if positioned, let target,
        !displayedIDs.contains(target.id) {
        resolved.animated = false
      }
      pendingRequest = resolved
    }
    let previousIDs = orderedIDs
    orderedIDs = ids
    prefetchedRange = nil
    if !positioned {
      centerWindow(on: initialTarget)
    } else if let request = pendingRequest {
      centerWindow(on: request.id)
    } else if following {
      windowStart = max(0, ids.count - windowSize)
    } else if let first = oldVisible.first, let index = ids.firstIndex(of: first) {
      windowStart = min(index, max(0, ids.count - windowSize))
    } else { windowStart = min(windowStart, max(0, ids.count - windowSize)) }
    // A pagination control can remain at index zero while a large page is
    // prepended. Keep the actual visible message inside the native window.
    if pendingRequest == nil, !following, let visibleAnchorID,
      let index = ids.firstIndex(of: visibleAnchorID),
      !(windowStart..<windowStart + windowSize).contains(index) {
      windowStart = min(max(0, index - windowSize / 2), max(0, ids.count - windowSize))
    }
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
    let anchor = positioned ? captureAnchor(forContentUpdate: true, excluding: changes) : nil
    if positioned, next != displayedIDs, let anchor, !next.contains(anchor.id) {
      // Diffable snapshots expose the new page at the old numeric offset until
      // their completion runs. Keep the old pixels over that intermediate
      // layout; reveal only after the requested destination has settled.
      relocationReveal?.cancel()
      if relocationSnapshot == nil, let snapshot = table.snapshotView(afterScreenUpdates: false) {
        snapshot.frame = table.frame
        snapshot.backgroundColor = UIColor(NativePalette.background)
        snapshot.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        snapshot.isUserInteractionEnabled = false
        snapshot.accessibilityElementsHidden = true
        view.addSubview(snapshot)
        relocationSnapshot = snapshot
        // The table intentionally draws beyond its viewport beneath glass.
        // Hide that overflow too while the captured viewport is displayed.
        table.layer.isHidden = true
      }
    }
    // A history-window replacement removes rows before/after the viewport.
    // Preserve its anchor even during a drag or fling; leaving the old offset
    // in the new window can cascade through every boundary in one gesture.
    let preservesScrollingAnchor = next != displayedIDs && !following
      && anchor.map { next.contains($0.id) } == true
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
      if let anchor, (!resize || !self.following),
        preservesScrollingAnchor || (!self.table.isDragging && !self.table.isDecelerating) {
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
          // Retarget as the bottom moves. A new document or photo can finish
          // sizing during this scroll; a fixed destination stopped short of it,
          // leaving the latest message beneath the composer.
          self.startFooterFollow(duration: 0.32, from: oldOffset.y)
        } else { self.table.setContentOffset(destination, animated: false) }
      }
      self.applyPendingRequest()
      self.didLayout()
      self.revealRelocation()
    }
    if resize {
      // Reconfigure and resize the hosting cell inside the same UIKit animation
      // that follows its bottom edge. The old nonanimated snapshot caused a
      // height jump, followed one frame later by a content-offset jump.
      table.animatesLayout = true
      defer { table.animatesLayout = false }
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
    } else {
      source.apply(snapshot, animatingDifferences: false) {
        if preservesScrollingAnchor {
          // UIKit finishes adjusting its old estimated offset after invoking
          // the snapshot completion. Restore after that correction, while
          // keeping scroll callbacks blocked from advancing another window.
          DispatchQueue.main.async(execute: completed)
        } else { completed() }
      }
      // The completion runs after this frame is displayed. Restore the reading
      // anchor before then too, or a reconfigured row (new reactions, a card
      // answer) shows the rows around it displaced for a frame.
      if let anchor, preservesScrollingAnchor || (!table.isDragging && !table.isDecelerating) {
        table.layoutIfNeeded()
        restore(anchor)
      }
    }
  }
  /// Keep UIKit's layout and accessibility working set bounded as well as its
  /// onscreen cells. Crossing either boundary shifts a contiguous overlapping
  /// window and retains the visible message's pixel position.
  private func advanceWindowIfNeeded() {
    guard positioned, !updating, !positioning, !scrollingToTarget, !following,
      !table.isDragging, !table.isDecelerating,
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
    // The bottom of search context is not the live end of the conversation.
    items["later"] == nil && windowStart + displayedIDs.count == orderedIDs.count
      && bottomOffset.y - table.contentOffset.y <= 2
  }

  private func didLayout() {
    let start = layoutStart
    layoutStart = nil
    guard !updating, !positioning, table.bounds.height > 0, !orderedIDs.isEmpty else {
      layoutRows = [:]
      return
    }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    defer {
      recordLayoutRows()
      CATransaction.commit()
    }
    if let start, positioned, !following, !scrollingToTarget { preserveVisibleRows(from: start) }
    prefetchNearbyRows()
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
    let contentGrew = table.contentSize.height > lastContent.height + 0.5
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
        guard self.visibleDocumentsReady else {
          // WebKit can be quiet for much longer than a layout debounce while
          // parsing diagrams or starting its process. Silence is not readiness.
          self.didLayout()
          return
        }
        self.positioned = true
        self.following = self.initialTarget == "bottom"
        self.onPositioned()
        self.reportScroll()
      }
      settle = work
      if initialLayout == .nextLayout && visibleDocumentsReady {
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
      } else if contentGrew && !viewportResized && !UIAccessibility.isReduceMotionEnabled {
        // A row near the end finished sizing (a document or photo). Follow it as
        // an arrival does, instead of moving the whole transcript in one frame.
        startFooterFollow(duration: ChatActivityTiming.expansion, from: table.contentOffset.y)
      } else {
        table.setContentOffset(bottomOffset, animated: false)
      }
      positioning = false
    } else if !following && !table.isDragging && !table.isDecelerating,
      !scrollingToTarget, let readingAnchor {
      // Self-sizing hosting/document cells can finish after the snapshot's
      // completion, including offset-only corrections with unchanged size.
      restore(readingAnchor)
    }
    if positioned { reportScroll() }
  }

  private func prefetchNearbyRows() {
    guard let paths = table.indexPathsForVisibleRows, let first = paths.map(\.row).min(),
      let last = paths.map(\.row).max(), !orderedIDs.isEmpty else { return }
    let lower = max(0, windowStart + first - 12)
    let upper = min(orderedIDs.count - 1, windowStart + last + 12)
    guard lower <= upper, prefetchedRange != lower...upper else { return }
    prefetchedRange = lower...upper
    // Farthest first: the most recent requests are measured first.
    let visible = (windowStart + first)...(windowStart + last)
    let indices = (lower...upper).sorted {
      max(visible.lowerBound - $0, $0 - visible.upperBound) > max(visible.lowerBound - $1, $1 - visible.upperBound)
    }
    for index in indices {
      let id = orderedIDs[index]
      guard let item = items[id], let prefetch = item.prefetch,
        prefetched.insert(id + ":" + String(item.version)).inserted else { continue }
      prefetch()
    }
  }
  /// Rows' content frames after a layout pass. Scrolling changes only the offset;
  /// the next pass compares these to find rows UIKit resized or moved.
  private func recordLayoutRows() {
    var rows: [String: CGRect] = [:]
    for path in table.indexPathsForVisibleRows ?? [] {
      if let id = source.itemIdentifier(for: path) { rows[id] = table.rectForRow(at: path) }
    }
    layoutRows = rows
  }
  /// Rows on screen before UIKit's layout pass, in the table's current geometry.
  /// Corrections UIKit makes between passes are already reflected here.
  private func captureLayoutStart() {
    layoutStart = nil
    guard positioned, !updating, !positioning, !following, !scrollingToTarget, !layoutRows.isEmpty else { return }
    var rows: [String: CGRect] = [:]
    for id in layoutRows.keys {
      if let path = source.indexPath(for: id) { rows[id] = table.rectForRow(at: path) }
    }
    layoutStart = (table.contentOffset.y, rows)
  }
  /// UIKit's layout pass applies hosting-cell size changes (WebKit documents,
  /// cards, media) by growing the row downward, and sometimes corrects an
  /// entering row's estimated height the same way, moving every row after it.
  /// Keep the unchanged row nearest the viewport's center in place instead: rows
  /// above it extend upward and rows below it downward, so the content being
  /// read does not jump during or after a scroll.
  private func preserveVisibleRows(from start: (offset: CGFloat, rows: [String: CGRect])) {
    let inset = table.adjustedContentInset
    let top = start.offset + inset.top
    let bottom = start.offset + table.bounds.height - inset.bottom
    let center = (top + bottom) / 2
    var anchor: (before: CGRect, after: CGRect, distance: CGFloat)?
    for (id, before) in start.rows where before.maxY > top && before.minY < bottom {
      guard let path = source.indexPath(for: id) else { continue }
      let after = table.rectForRow(at: path)
      guard abs(after.height - before.height) <= 0.5 else { continue }
      let distance = max(0, before.minY - center, center - before.maxY)
      if anchor.map({ distance < $0.distance }) ?? true { anchor = (before, after, distance) }
    }
    guard let anchor else { return }
    let shift = (anchor.after.minY - anchor.before.minY) - (table.contentOffset.y - start.offset)
    guard abs(shift) > 0.5 else { return }
    var y = table.contentOffset.y + shift
    let minimum = -inset.top
    let maximum = max(minimum, table.contentSize.height - table.bounds.height + inset.bottom)
    // Leave an active rubber-band overscroll alone; otherwise stay in bounds.
    if (minimum...maximum).contains(table.contentOffset.y) { y = min(max(y, minimum), maximum) }
    positioning = true
    // Assigning the offset keeps UIKit's drag/deceleration running, as it does
    // for its own estimated-height corrections.
    table.contentOffset = CGPoint(x: table.contentOffset.x, y: y)
    positioning = false
    if readingAnchor != nil { readingAnchor = captureAnchor() }
  }

  private var visibleDocumentsReady: Bool {
    func ready(_ view: UIView) -> Bool {
      if let document = view as? HistoryLayoutReadiness, !document.historyLayoutReady { return false }
      return view.subviews.allSatisfy(ready)
    }
    return table.visibleCells.allSatisfy(ready)
  }

  private func applyPendingRequest() {
    guard positioned, let request = pendingRequest else { return }
    guard let item = items.values.first(where: { $0.scrollID == request.id }),
      source.indexPath(for: item.id) != nil, !updating else { return }
    pendingRequest = nil
    following = request.id == "bottom"
    scroll(to: request.id, animated: request.animated && !UIAccessibility.isReduceMotionEnabled)
    revealRelocation()
    reportScroll()
  }
  private func revealRelocation() {
    guard relocationSnapshot != nil else { return }
    relocationReveal?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      if self.updating || self.positioning || self.pendingRequest != nil || self.scrollingToTarget {
        self.revealRelocation()
        return
      }
      self.table.layoutIfNeeded()
      self.didLayout()
      self.relocationSnapshot?.removeFromSuperview()
      self.relocationSnapshot = nil
      self.table.layer.isHidden = false
      self.relocationReveal = nil
    }
    relocationReveal = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: work)
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
  private func captureAnchor(forContentUpdate: Bool = false, excluding changed: Set<String> = []) -> Anchor? {
    // Pagination controls move when a page is inserted. Anchor an actual message
    // underneath them, otherwise loading earlier history jumps to the new page.
    let messages = (table.indexPathsForVisibleRows ?? []).sorted().compactMap { path -> (String, CGRect)? in
      guard let id = source.itemIdentifier(for: path), !["earlier", "later", "bottom"].contains(id) else { return nil }
      return (id, table.rectForRow(at: path))
    }
    // Keep the unchanged message nearest the viewport's center in place, as a
    // layout pass does. A row above it that gains reactions, a card answer or a
    // longer document then extends upward instead of pushing what is being read.
    let inset = table.adjustedContentInset
    let center = table.contentOffset.y + (inset.top + table.bounds.height - inset.bottom) / 2
    let distance = { (rect: CGRect) in max(0, rect.minY - center, center - rect.maxY) }
    guard let (id, rect) = messages.filter({ !changed.contains($0.0) }).min(by: { distance($0.1) < distance($1.1) })
      ?? messages.first else { return nil }
    let bottom = forContentUpdate && bottomAnchoredIDs.contains(id) && items[id]?.anchorToBottom == false
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
    // Self-sizing can correct only the offset, without changing contentSize.
    // While idle, such a correction must retain the last reading anchor too.
    if !following, !table.isDragging, !table.isDecelerating,
      !scrollingToTarget, let readingAnchor {
      restore(readingAnchor)
    }
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
    // UIKit can deliver this callback while an anchor restoration cancels an
    // earlier scroll. Do not replace that anchor with intermediate geometry.
    guard !positioning, scrollingToTarget else { return }
    scrollingToTarget = false
    // A real animation may finish during a snapshot. Clear its state, but let
    // the snapshot completion restore/report the saved anchor after layout.
    guard !updating else { return }
    if !following { readingAnchor = captureAnchor() }
    else if bottomOffset.y - table.contentOffset.y > 2 && !UIAccessibility.isReduceMotionEnabled {
      // Content below grew while scrolling to the latest message.
      startFooterFollow(duration: ChatActivityTiming.expansion, from: table.contentOffset.y)
    } else if bottomOffset.y - table.contentOffset.y > 2 { table.setContentOffset(bottomOffset, animated: false) }
    reportScroll()
  }
  private func endScroll() {
    // Programmatic anchor restoration can end UIKit's deceleration. Its
    // intermediate geometry must not replace the anchor being restored.
    guard !updating, !positioning else { return }
    if atBottom { following = true }
    readingAnchor = following ? nil : captureAnchor()
    feedback.end()
    // Shift the overlapping window once the gesture has settled. Replacing
    // rows during a fling lets UIKit apply offset corrections in its old
    // coordinate space, even after restoring the new window's anchor.
    advanceWindowIfNeeded()
    dragDirection = 0
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

#if DEBUG
/// Optional QA evidence for scroll smoothness (`--trace-scroll-frames`): each
/// display frame's on-screen row positions and heights, the finger location and
/// controller state, written to `tmp/scroll-frames.json` once scrolling is idle.
/// Numeric geometry and message IDs only, never content. See
/// `scripts/scroll-frame-report.py`.
extension HistoryListController {
  fileprivate func captureCommittedGeometry() {
    guard table.window != nil else { return }
    func hidden(_ view: UIView) -> Int {
      (view is HistoryLayoutReadiness && view.alpha < 1 ? 1 : 0) + view.subviews.reduce(0) { $0 + hidden($1) }
    }
    committedOffset = table.contentOffset.y
    // Read cells without table APIs that can make UIKit update rows outside its
    // own layout pass, which would change the behavior being measured.
    committedRows = table.subviews.compactMap { $0 as? UITableViewCell }.filter { !$0.isHidden }.compactMap { cell in
      guard let path = table.indexPath(for: cell), let id = source.itemIdentifier(for: path) else { return nil }
      return CommittedRow(id: items[id]?.scrollID ?? id, frame: cell.frame, cell: cell, hidden: hidden(cell))
    }
  }
  @objc fileprivate func traceFrame(_ link: CADisplayLink) {
    guard table.window != nil else { return }
    // Committed geometry, or the presentation of animations committed with it.
    let presented = table.layer.animationKeys()?.isEmpty == false
      ? table.layer.presentation()?.bounds.origin.y ?? committedOffset : committedOffset
    var rows: [[Any]] = []
    var hiddenDocuments = 0
    for row in committedRows {
      let frame = row.cell?.layer.animationKeys()?.isEmpty == false
        ? row.cell?.layer.presentation()?.frame ?? row.frame : row.frame
      let y = frame.minY - presented + table.frame.minY
      guard y + frame.height > 0, y < view.bounds.height else { continue }
      rows.append([row.id, (Double(y) * 100).rounded() / 100, (Double(frame.height) * 100).rounded() / 100])
      hiddenDocuments += row.hidden
    }
    rows.sort { ($0[1] as? Double ?? 0) < ($1[1] as? Double ?? 0) }
    let pan = table.panGestureRecognizer
    let finger: Double? = [.began, .changed].contains(pan.state) ? Double(pan.location(in: view).y) : nil
    var flags = ""
    if table.isTracking { flags += "t" }
    if table.isDragging { flags += "d" }
    if table.isDecelerating { flags += "D" }
    if updating { flags += "u" }
    if positioning { flags += "p" }
    if scrollingToTarget { flags += "s" }
    if following { flags += "f" }
    if relocationSnapshot != nil { flags += "r" }
    if table.layer.isHidden { flags += "h" }
    if committedRows.contains(where: { $0.cell?.layer.animationKeys()?.isEmpty == false }) { flags += "a" }
    let signature = "\(presented)|\(rows.map { "\($0[0])\($0[1])\($0[2])" })|\(hiddenDocuments)|\(flags)|\(finger ?? -1)"
    guard signature != lastFrameSignature else { return }
    lastFrameSignature = signature
    var frame: [String: Any] = ["t": link.timestamp, "off": Double(presented), "model": Double(table.contentOffset.y),
      "content": Double(table.contentSize.height), "insetTop": Double(table.contentInset.top),
      "flags": flags, "rows": rows, "hiddenDocs": hiddenDocuments, "window": windowStart, "mounted": displayedIDs.count]
    if let finger { frame["finger"] = finger }
    let animations = (table.layer.animationKeys() ?? []).map { key in
      "table:\(key):\((table.layer.animation(forKey: key) as? CAPropertyAnimation)?.keyPath ?? "")"
    } + committedRows.compactMap(\.cell).flatMap { cell in
      (cell.layer.animationKeys() ?? []).map { "cell:\($0)" }
    }
    if !animations.isEmpty { frame["animations"] = Array(Set(animations)).sorted() }
    frameTrace.append(frame)
    if frameTrace.count > 20_000 { frameTrace.removeFirst(5_000) }
    // Write only once scrolling is idle, serializing off the main thread, so the
    // trace does not cause the frame drops it is measuring.
    frameTraceWrite?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.frameTraceWrite = nil
      let value: [String: Any] = ["frames": self.frameTrace,
        "viewportTop": Double(self.view.safeAreaLayoutGuide.layoutFrame.minY),
        "viewportBottom": Double(self.view.safeAreaLayoutGuide.layoutFrame.maxY)]
      let url = FileManager.default.temporaryDirectory.appendingPathComponent("scroll-frames.json")
      DispatchQueue.global(qos: .utility).async {
        if let data = try? JSONSerialization.data(withJSONObject: value) { try? data.write(to: url, options: .atomic) }
      }
    }
    frameTraceWrite = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: work)
  }
}
#endif

/// History paints beneath the floating glass bars, but those pixels must never
/// receive touches belonging to the composer or header outside this viewport.
@MainActor private final class HistoryViewport: UIView {
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard safeAreaLayoutGuide.layoutFrame.contains(point) else { return nil }
    return super.hitTest(point, with: event)
  }
}

@MainActor private final class HistoryTable: UITableView {
  var willLayout: (() -> Void)?
  var didLayout: (() -> Void)?
  /// Self-sizing hosting cells otherwise animate each size change from inside
  /// this layout pass, sliding every following row mid-scroll. The controller
  /// keeps visible content in place instead; it opts in for deliberate resizes.
  var animatesLayout = false
  #if DEBUG
  var scrollGeometry: (() -> String?)?
  override var accessibilityValue: String? {
    get { scrollGeometry?() ?? super.accessibilityValue }
    set { super.accessibilityValue = newValue }
  }
  #endif
  override func layoutSubviews() {
    willLayout?()
    if animatesLayout { super.layoutSubviews() } else { UIView.performWithoutAnimation { super.layoutSubviews() } }
    didLayout?()
    #if DEBUG
    if ProcessInfo.processInfo.arguments.contains("--ui-testing-layout-geometry") {
      // Read native frames in rotation tests: WebKit's remote accessibility
      // nodes can disappear or return zero rectangles during a width change.
      var documents: [[String: Any]] = []
      func collect(_ view: UIView) {
        if let document = view as? HistoryLayoutReadiness {
          let frame = view.convert(view.bounds, to: self)
          if frame.intersects(bounds), view.alpha > 0 {
            documents.append(["width": view.bounds.width, "height": view.bounds.height,
              "y": frame.minY, "ready": document.historyLayoutReady])
          }
        }
        for child in view.subviews { collect(child) }
      }
      for cell in visibleCells { collect(cell) }
      documents.sort { ($0["y"] as? CGFloat ?? 0) < ($1["y"] as? CGFloat ?? 0) }
      if let data = try? JSONSerialization.data(withJSONObject: documents) {
        accessibilityValue = String(data: data, encoding: .utf8)
      }
    }
    #endif
  }
}
