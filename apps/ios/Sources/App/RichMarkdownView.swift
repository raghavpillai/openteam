import SwiftUI
import WebKit

/// Complex document content uses iOS WebKit with bundled, offline renderers.
/// Ordinary chat, code and every app control stay native SwiftUI.
struct RichMarkdownView: View {
  let source: String
  var forceDark = false
  @Environment(\.colorScheme) private var scheme
  @ScaledMetric(relativeTo: .body) private var fontSize = 17.0
  @State private var height: CGFloat = 40
  @State private var failure = false
  var body: some View {
    if failure || DocumentHeightCache.shared.recentlyFailed(source) {
      Text(source).font(.body).textSelection(.enabled)
    } else {
      let dark = forceDark || scheme == .dark
      // Read the measured height and cache revision in body, so a measurement,
      // including one made offscreen before WebKit renders here, resizes the row.
      let measured = height
      let _ = DocumentHeightCache.shared.revision
      DocumentFrame { width in
        width.flatMap { DocumentHeightCache.shared.height(source: source, width: $0, dark: dark, font: fontSize) }
          ?? measured
      } content: {
        MarkdownDocument(
          source: source, forceDark: forceDark, dark: dark,
          fontSize: fontSize, height: $height,
          failure: $failure
        )
        .id(Self.usesDiagrams(source))
      }.clipped().accessibilityIdentifier("rich-markdown")
    }
  }
  private static let documentPattern = try! NSRegularExpression(pattern:
    #"(?m)^(#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|>\s|\|.*\||```mermaid|\$\$|---\s*$)|\\\(|\\\[|\$[^\s$][^\n$]*\$"#)
  static func required(_ source: String) -> Bool {
    documentPattern.firstMatch(in: source, range: NSRange(location: 0, length: source.utf16.count)) != nil
  }
  /// Measures a transcript row's document before the row is displayed.
  static func prefetcher(_ row: MessagePresentation.Row) -> (() -> Void)? {
    let (source, isUser): (String, Bool) = switch row.content {
    case .confirmed(let entry): (entry.message.displayContent, entry.message.isUser)
    case .pending(let send): (send.input.content, true)
    }
    guard !source.isEmpty else { return nil }
    return { DocumentMeasurer.shared.prefetch(source, forceDark: isUser) }
  }
  private static let diagramPattern = try! NSRegularExpression(pattern: #"(?m)^\s*```mermaid\b"#)
  static func usesDiagrams(_ source: String) -> Bool {
    diagramPattern.firstMatch(in: source, range: NSRange(location: 0, length: source.utf16.count)) != nil
  }
}

/// A fixed-height frame whose height is resolved at the proposed width. A
/// recycled or revisited document takes its measured height in the row's first
/// layout pass, rather than a placeholder corrected after WebKit renders again.
private struct DocumentFrame<Content: View>: View {
  let height: (CGFloat?) -> CGFloat
  @ViewBuilder let content: Content
  var body: some View { Resolver(height: height) { content } }
  private struct Resolver: Layout {
    let height: (CGFloat?) -> CGFloat
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
      let value = height(proposal.width.flatMap { $0.isFinite && $0 > 0 ? $0 : nil })
      let width = subviews.first?.sizeThatFits(ProposedViewSize(width: proposal.width, height: value)).width
      return CGSize(width: width ?? proposal.width ?? 0, height: value)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
      subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
    }
  }
}

/// Measurements survive cell recycling. Keep a bounded cache of hashes and
/// dimensions; no message text or entered form values are retained here.
@MainActor @Observable private final class DocumentHeightCache {
  static let shared = DocumentHeightCache()
  private struct Key: Hashable { let source: Int; let width: Int; let dark: Bool; let font: Int }
  private(set) var revision = 0
  @ObservationIgnored private var values: [Key: CGFloat] = [:]
  @ObservationIgnored private var order: [Key] = []
  @ObservationIgnored private var failures: [Int: Date] = [:]
  func recentlyFailed(_ source: String) -> Bool {
    (failures[source.hashValue] ?? .distantPast) > Date()
  }
  func failed(_ source: String) {
    failures = failures.filter { $0.value > Date() }
    if failures.count >= 256 { failures.removeAll() }
    // Cell recycling must not restart a failed renderer indefinitely while the
    // opening layout is settling. A later visit can attempt WebKit again.
    failures[source.hashValue] = Date().addingTimeInterval(30)
  }
  func height(source: String, width: CGFloat, dark: Bool, font: CGFloat) -> CGFloat? {
    values[key(source: source, width: width, dark: dark, font: font)]
  }
  private func key(source: String, width: CGFloat, dark: Bool, font: CGFloat) -> Key {
    Key(source: source.hashValue, width: Int((width * 2).rounded()), dark: dark, font: Int((font * 2).rounded()))
  }
  func clear() { values = [:]; order = []; failures = [:] }
  func save(_ value: CGFloat, source: String, width: CGFloat, dark: Bool, font: CGFloat) {
    let key = key(source: source, width: width, dark: dark, font: font)
    guard values[key] != value else { return }
    revision += 1
    values[key] = value
    order.removeAll { $0 == key }
    order.append(key)
    if order.count > 256 { values.removeValue(forKey: order.removeFirst()) }
  }
}

private struct MarkdownDocument: UIViewRepresentable {
  let source: String
  let forceDark: Bool
  let dark: Bool
  let fontSize: CGFloat
  @Binding var height: CGFloat
  @Binding var failure: Bool
  func makeCoordinator() -> Coordinator { Coordinator(self) }
  func makeUIView(context: Context) -> ReusableDocumentView {
    let diagrams = RichMarkdownView.usesDiagrams(source)
    let view = DocumentPool.shared.take(diagrams: diagrams)
    view.alpha = 0
    view.measuredSize = nil
    view.participatesInHistoryLayout = true
    view.lease = context.coordinator.lease
    view.onLayoutReady = { [weak coordinator = context.coordinator] in coordinator?.timeout?.cancel() }
    context.coordinator.armTimeout()
    view.configuration.userContentController.add(context.coordinator, name: "height")
    view.navigationDelegate = context.coordinator
    context.coordinator.ready = view.rendererReady
    if !view.rendererReady {
      if let html = DocumentPool.shared.html(diagrams: diagrams) {
        view.loadHTMLString(html, baseURL: nil)
      } else { DispatchQueue.main.async { failure = true } }
    }
    return view
  }
  func updateUIView(_ view: ReusableDocumentView, context: Context) {
    context.coordinator.parent = self
    context.coordinator.render(view)
  }
  static func dismantleUIView(_ view: ReusableDocumentView, coordinator: Coordinator) {
    coordinator.timeout?.cancel()
    DocumentMeasurer.shared.endVisibleRender(coordinator.lease)
    view.participatesInHistoryLayout = false
    view.onLayoutReady = nil
    view.navigationDelegate = nil
    view.configuration.userContentController.removeScriptMessageHandler(forName: "height")
    if view.rendererReady {
      view.evaluateJavaScript("++renderVersion; activeLease=''; document.getElementById('message').replaceChildren()")
      DocumentPool.shared.recycle(view)
    } else { view.stopLoading() }
  }
  @MainActor final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    var parent: MarkdownDocument
    let lease = UUID().uuidString
    var ready = false
    var key = ""
    var renderToken = ""
    var timeout: DispatchWorkItem?
    init(_ parent: MarkdownDocument) { self.parent = parent }
    func armTimeout() {
      timeout?.cancel()
      let work = DispatchWorkItem { [weak self] in self?.fail() }
      timeout = work
      // A failed/hung WebKit process must not leave the chat behind a spinner.
      // Native text is the terminal fallback and participates in normal sizing.
      DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: work)
    }
    func fail() {
      timeout?.cancel()
      DocumentMeasurer.shared.endVisibleRender(lease)
      DocumentHeightCache.shared.failed(parent.source)
      parent.failure = true
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      ready = true
      (webView as? ReusableDocumentView)?.rendererReady = true
      render(webView)
    }
    func render(_ view: WKWebView) {
      let next = "\(parent.dark)-\(parent.fontSize)-" + parent.source
      guard ready, next != key else { return }
      key = next
      renderToken = UUID().uuidString
      let token = renderToken
      if let document = view as? ReusableDocumentView {
        document.measuredSize = nil
        document.alpha = 0
      }
      armTimeout()
      DocumentMeasurer.shared.beginVisibleRender(lease)
      var delay = 0
      #if DEBUG
      if ProcessInfo.processInfo.arguments.contains("--ui-testing-delay-document") { delay = 1000 }
      if ProcessInfo.processInfo.arguments.contains("--ui-testing-stall-document") { delay = 12000 }
      #endif
      view.callAsyncJavaScript(
        "await window.renderMessage(source,dark,fontSize,colors,lease,delay); return true;",
        arguments: [
          "source": parent.source, "dark": parent.dark, "fontSize": parent.fontSize,
          "colors": NativePalette.documentColors(dark: parent.dark), "lease": token, "delay": delay,
        ],
        in: nil, in: .page
      ) { [weak self, weak view] result in
        guard let self, self.renderToken == token,
          (view as? ReusableDocumentView)?.lease == self.lease else { return }
        if case .failure = result { self.fail() }
      }
    }
    func userContentController(
      _ controller: WKUserContentController, didReceive message: WKScriptMessage
    ) {
      if let value = message.body as? [String: Any], value["lease"] as? String == renderToken,
        value["ready"] as? Bool == true,
        let height = value["height"] as? Double, let width = value["width"] as? Double,
        let nativeWidth = message.webView?.bounds.width,
        DocumentHeightMeasurement.isValid(
          height: height, width: width, viewportWidth: Double(nativeWidth)) {
        let measuredHeight = max(1, CGFloat(height))
        DocumentMeasurer.shared.endVisibleRender(lease)
        if abs(parent.height - measuredHeight) > 0.5 { parent.height = measuredHeight }
        if let view = message.webView as? ReusableDocumentView {
          DocumentHeightCache.shared.save(measuredHeight, source: parent.source, width: CGFloat(width),
            dark: parent.dark, font: parent.fontSize)
          DocumentMeasurer.shared.noteLayout(forceDark: parent.forceDark, width: CGFloat(width),
            dark: parent.dark, font: parent.fontSize)
          view.measuredSize = CGSize(width: width, height: measuredHeight)
          view.setNeedsLayout()
        }
      }
    }
    func webView(
      _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
      decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
      if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url {
        if ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") {
          UIApplication.shared.open(url)
        }
        decisionHandler(.cancel)
      } else {
        decisionHandler(navigationAction.request.url?.scheme == "about" ? .allow : .cancel)
      }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
      (webView as? ReusableDocumentView)?.rendererReady = false
      fail()
    }
  }
}

@MainActor enum MessageDocuments {
  /// Load idle renderers before the first document scrolls into view. A cold
  /// renderer page takes long enough that its row is mid-screen when it sizes.
  static func prewarm() {
    DocumentPool.shared.prewarm()
    DocumentMeasurer.shared.prewarm()
  }
  static func clear() {
    MessageTextCache.clear()
    AttachmentPreviewCache.clear()
    DocumentMeasurer.shared.clear()
    DocumentHeightCache.shared.clear()
    DocumentPool.shared.clear()
  }
}

@MainActor private final class ReusableDocumentView: WKWebView, HistoryLayoutReadiness {
  var rendererReady = false
  var lease = ""
  var measuredSize: CGSize?
  var participatesInHistoryLayout = false
  var onLayoutReady: (() -> Void)?
  var historyLayoutReady: Bool {
    guard participatesInHistoryLayout else { return true }
    guard let measuredSize else { return false }
    return abs(bounds.width - measuredSize.width) <= 1 && abs(bounds.height - measuredSize.height) <= 1
  }
  let diagrams: Bool
  let poolEpoch: UUID
  init(diagrams: Bool, epoch: UUID, dataStore: WKWebsiteDataStore) {
    self.diagrams = diagrams
    poolEpoch = epoch
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = dataStore
    super.init(frame: .zero, configuration: configuration)
    isOpaque = false
    backgroundColor = .clear
    scrollView.backgroundColor = .clear
    scrollView.isScrollEnabled = false
    clipsToBounds = true
    isInspectable = false
  }
  required init?(coder: NSCoder) { fatalError("Not used") }
  override func layoutSubviews() {
    super.layoutSubviews()
    let ready = historyLayoutReady
    let wasReady = alpha == 1
    alpha = ready ? 1 : 0
    if ready && !wasReady {
      onLayoutReady?()
      // The hosting cell must commit the measured height before the list opens.
      var ancestor = superview
      while let view = ancestor {
        if let table = view as? UITableView { table.setNeedsLayout(); break }
        ancestor = view.superview
      }
    }
  }
}

/// Recycle a small number of offline documents. Sharing one ephemeral data store
/// prevents each row from spawning an isolated WebKit session and recompiling the
/// full math/diagram runtime every time it scrolls back into view.
@MainActor private final class DocumentPool {
  static let shared = DocumentPool()
  private var views: [ReusableDocumentView] = []
  private var warming: ReusableDocumentView?
  private let warmer = Warmer()
  private var dataStore = WKWebsiteDataStore.nonPersistent()
  private var epoch = UUID()
  private var sources: [Bool: String] = [:]
  func take(diagrams: Bool) -> ReusableDocumentView {
    if let index = views.firstIndex(where: { $0.diagrams == diagrams && $0.rendererReady }) {
      return views.remove(at: index)
    }
    return make(diagrams: diagrams)
  }
  func make(diagrams: Bool) -> ReusableDocumentView {
    ReusableDocumentView(diagrams: diagrams, epoch: epoch, dataStore: dataStore)
  }
  func html(diagrams: Bool) -> String? {
    if let cached = sources[diagrams] { return cached }
    guard let url = Bundle.main.url(forResource: diagrams ? "MessageRenderer" : "TextDocumentRenderer", withExtension: "html"),
      let source = try? String(contentsOf: url, encoding: .utf8) else { return nil }
    sources[diagrams] = source
    return source
  }
  func prewarm() {
    guard warming == nil, !views.contains(where: { !$0.diagrams }), let html = html(diagrams: false) else { return }
    let view = make(diagrams: false)
    view.navigationDelegate = warmer
    warming = view
    view.loadHTMLString(html, baseURL: nil)
  }
  private final class Warmer: NSObject, WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      MainActor.assumeIsolated {
        guard let view = webView as? ReusableDocumentView, DocumentPool.shared.warming === view else { return }
        DocumentPool.shared.warming = nil
        view.navigationDelegate = nil
        view.rendererReady = true
        DocumentPool.shared.recycle(view)
      }
    }
    func webView(
      _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
      decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
      decisionHandler(navigationAction.request.url?.scheme == "about" ? .allow : .cancel)
    }
  }
  func recycle(_ view: ReusableDocumentView) {
    guard view.poolEpoch == epoch, view.rendererReady, views.count < 3 else { return }
    views.append(view)
  }
  func clear() {
    epoch = UUID()
    views = []
    warming = nil
    dataStore = .nonPersistent()
  }
}

/// Measures text documents near the viewport before their rows are displayed,
/// using one offscreen renderer. A row then lays out at its rendered height
/// instead of a placeholder that WebKit corrects while the row is on screen.
/// Width, colors and type size follow the latest on-screen document; until one
/// renders, requests wait. Sources stay in memory only and are cleared with the
/// account's data.
@MainActor final class DocumentMeasurer: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  static let shared = DocumentMeasurer()
  private struct Layout: Equatable { let width: CGFloat; let dark: Bool; let font: CGFloat }
  private struct Job: Equatable { let source: String; let layout: Layout }
  private var layouts: [Bool: Layout] = [:]
  private var waiting: [(source: String, forceDark: Bool)] = []
  private var queue: [Job] = []
  private var view: ReusableDocumentView?
  private var active: (job: Job, lease: String, timeout: DispatchWorkItem)?
  /// On-screen documents share WebKit's content process. Measure only while
  /// none of them is rendering, so prefetching never delays what is visible.
  private var visibleRenders = Set<String>()

  func beginVisibleRender(_ lease: String) { visibleRenders.insert(lease) }
  func endVisibleRender(_ lease: String) {
    if visibleRenders.remove(lease) != nil { pump() }
  }
  func noteLayout(forceDark: Bool, width: CGFloat, dark: Bool, font: CGFloat) {
    let layout = Layout(width: width, dark: dark, font: font)
    guard layouts[forceDark] != layout else { return }
    layouts[forceDark] = layout
    let pending = waiting
    waiting = []
    for request in pending { prefetch(request.source, forceDark: request.forceDark) }
  }
  func prefetch(_ source: String, forceDark: Bool) {
    // Diagrams are left to on-screen rendering: an offscreen diagram renderer
    // competes with the visible one for WebKit and can measure a different size.
    guard RichMarkdownView.required(source), !RichMarkdownView.usesDiagrams(source),
      !DocumentHeightCache.shared.recentlyFailed(source) else { return }
    guard let layout = layouts[forceDark] else {
      if !waiting.contains(where: { $0.source == source && $0.forceDark == forceDark }) {
        waiting.append((source, forceDark))
        if waiting.count > 32 { waiting.removeFirst() }
      }
      return
    }
    let job = Job(source: source, layout: layout)
    guard !measured(job), active?.job != job, !queue.contains(job) else { return }
    queue.append(job)
    // Rows scroll past quickly; measure the most recently requested ones first.
    if queue.count > 24 { queue.removeFirst() }
    pump()
  }
  func prewarm() { _ = renderer() }
  func clear() {
    active?.timeout.cancel()
    if let view { retire(view) }
    active = nil; queue = []; waiting = []; layouts = [:]; visibleRenders = []
  }
  private func measured(_ job: Job) -> Bool {
    DocumentHeightCache.shared.height(source: job.source, width: job.layout.width,
      dark: job.layout.dark, font: job.layout.font) != nil
  }
  private func renderer() -> ReusableDocumentView? {
    if let view { return view }
    guard let html = DocumentPool.shared.html(diagrams: false),
      let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
        .flatMap(\.windows).first(where: \.isKeyWindow) else { return nil }
    let view = DocumentPool.shared.make(diagrams: false)
    view.isUserInteractionEnabled = false
    view.accessibilityElementsHidden = true
    // In a window, so WebKit lays out at this width, but outside every screen.
    view.frame = CGRect(x: -4000, y: 0, width: 320, height: 200)
    window.addSubview(view)
    view.configuration.userContentController.add(self, name: "height")
    view.navigationDelegate = self
    view.loadHTMLString(html, baseURL: nil)
    self.view = view
    return view
  }
  private func retire(_ view: ReusableDocumentView) {
    view.navigationDelegate = nil
    view.configuration.userContentController.removeScriptMessageHandler(forName: "height")
    view.removeFromSuperview()
    if self.view === view { self.view = nil }
  }
  private func pump() {
    guard active == nil, visibleRenders.isEmpty, !queue.isEmpty, let view = renderer(), view.rendererReady
    else { return }
    while let job = queue.popLast() {
      guard !measured(job) else { continue }
      view.frame.size.width = job.layout.width
      let lease = UUID().uuidString
      let timeout = DispatchWorkItem { [weak self] in self?.finish(lease) }
      active = (job, lease, timeout)
      DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: timeout)
      view.callAsyncJavaScript(
        "await window.renderMessage(source,dark,fontSize,colors,lease,0); return true;",
        arguments: [
          "source": job.source, "dark": job.layout.dark, "fontSize": job.layout.font,
          "colors": NativePalette.documentColors(dark: job.layout.dark), "lease": lease,
        ], in: nil, in: .page
      ) { [weak self] result in
        if case .failure = result { self?.finish(lease) }
      }
      return
    }
  }
  private func finish(_ lease: String) {
    guard let run = active, run.lease == lease else { return }
    run.timeout.cancel()
    active = nil
    pump()
  }
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let view = message.webView, view === self.view, let run = active,
      let value = message.body as? [String: Any], value["lease"] as? String == run.lease,
      value["ready"] as? Bool == true,
      let height = value["height"] as? Double, let width = value["width"] as? Double else { return }
    if DocumentHeightMeasurement.isValid(height: height, width: width, viewportWidth: Double(view.bounds.width)),
      abs(CGFloat(width) - run.job.layout.width) <= 1 {
      DocumentHeightCache.shared.save(max(1, CGFloat(height)), source: run.job.source, width: run.job.layout.width,
        dark: run.job.layout.dark, font: run.job.layout.font)
    }
    finish(run.lease)
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard webView === view else { return }
    view?.rendererReady = true
    pump()
  }
  func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
  ) {
    decisionHandler(navigationAction.request.url?.scheme == "about" ? .allow : .cancel)
  }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    guard let view = webView as? ReusableDocumentView, view === self.view else { return }
    // Start a fresh renderer on the next request.
    retire(view)
    active?.timeout.cancel()
    active = nil
  }
}
