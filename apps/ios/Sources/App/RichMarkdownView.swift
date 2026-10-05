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
      MarkdownDocument(
        source: source, dark: forceDark || scheme == .dark,
        fontSize: fontSize, height: $height,
        failure: $failure
      )
      .id(Self.usesDiagrams(source))
      .frame(height: height).clipped().accessibilityIdentifier("rich-markdown")
      .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { _, value in
        if let cached = DocumentHeightCache.shared.height(source: source, width: value,
          dark: forceDark || scheme == .dark, font: fontSize),
          abs(cached - height) > 0.5 { height = cached }
      }
    }
  }
  private static let documentPattern = try! NSRegularExpression(pattern:
    #"(?m)^(#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|>\s|\|.*\||```mermaid|\$\$|---\s*$)|\\\(|\\\[|\$[^\s$][^\n$]*\$"#)
  static func required(_ source: String) -> Bool {
    documentPattern.firstMatch(in: source, range: NSRange(location: 0, length: source.utf16.count)) != nil
  }
  private static let diagramPattern = try! NSRegularExpression(pattern: #"(?m)^\s*```mermaid\b"#)
  static func usesDiagrams(_ source: String) -> Bool {
    diagramPattern.firstMatch(in: source, range: NSRange(location: 0, length: source.utf16.count)) != nil
  }
}

/// Measurements survive cell recycling. Keep a bounded cache of hashes and
/// dimensions; no message text or entered form values are retained here.
@MainActor private final class DocumentHeightCache {
  static let shared = DocumentHeightCache()
  private struct Key: Hashable { let source: Int; let width: Int; let dark: Bool; let font: Int }
  private var values: [Key: CGFloat] = [:]
  private var order: [Key] = []
  private var failures: [Int: Date] = [:]
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
    values[Key(source: source.hashValue, width: Int(width * 2), dark: dark, font: Int(font * 2))]
  }
  func clear() { values = [:]; order = []; failures = [:] }
  func save(_ value: CGFloat, source: String, width: CGFloat, dark: Bool, font: CGFloat) {
    let key = Key(source: source.hashValue, width: Int(width * 2), dark: dark, font: Int(font * 2))
    values[key] = value
    order.removeAll { $0 == key }
    order.append(key)
    if order.count > 256 { values.removeValue(forKey: order.removeFirst()) }
  }
}

private struct MarkdownDocument: UIViewRepresentable {
  let source: String
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
        if abs(parent.height - measuredHeight) > 0.5 { parent.height = measuredHeight }
        if let view = message.webView as? ReusableDocumentView {
          DocumentHeightCache.shared.save(measuredHeight, source: parent.source, width: CGFloat(width),
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
  static func clear() {
    MessageTextCache.clear()
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
  private var dataStore = WKWebsiteDataStore.nonPersistent()
  private var epoch = UUID()
  private var sources: [Bool: String] = [:]
  func take(diagrams: Bool) -> ReusableDocumentView {
    if let index = views.firstIndex(where: { $0.diagrams == diagrams && $0.rendererReady }) {
      return views.remove(at: index)
    }
    return ReusableDocumentView(diagrams: diagrams, epoch: epoch, dataStore: dataStore)
  }
  func html(diagrams: Bool) -> String? {
    if let cached = sources[diagrams] { return cached }
    guard let url = Bundle.main.url(forResource: diagrams ? "MessageRenderer" : "TextDocumentRenderer", withExtension: "html"),
      let source = try? String(contentsOf: url, encoding: .utf8) else { return nil }
    sources[diagrams] = source
    return source
  }
  func recycle(_ view: ReusableDocumentView) {
    guard view.poolEpoch == epoch, view.rendererReady, views.count < 3 else { return }
    views.append(view)
  }
  func clear() {
    epoch = UUID()
    views = []
    dataStore = .nonPersistent()
  }
}
