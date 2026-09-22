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
  @State private var width: CGFloat = 0
  var body: some View {
    if failure {
      Text(source).font(.body).textSelection(.enabled)
    } else {
      MarkdownDocument(
        source: source, dark: forceDark || scheme == .dark,
        fontSize: fontSize, height: $height,
        failure: $failure
      )
      .id(Self.usesDiagrams(source))
      .frame(height: height).accessibilityIdentifier("rich-markdown")
      .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { _, value in
        width = value
        if let cached = DocumentHeightCache.shared.height(source: source, width: value,
          dark: forceDark || scheme == .dark, font: fontSize),
          abs(cached - height) > 0.5 { height = cached }
      }
      .onChange(of: height) { _, value in
        if width > 0 { DocumentHeightCache.shared.save(value, source: source, width: width,
          dark: forceDark || scheme == .dark, font: fontSize) }
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
  func height(source: String, width: CGFloat, dark: Bool, font: CGFloat) -> CGFloat? {
    values[Key(source: source.hashValue, width: Int(width * 2), dark: dark, font: Int(font * 2))]
  }
  func clear() { values = [:]; order = [] }
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
    view.lease = context.coordinator.lease
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
    init(_ parent: MarkdownDocument) { self.parent = parent }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      ready = true
      (webView as? ReusableDocumentView)?.rendererReady = true
      render(webView)
    }
    func render(_ view: WKWebView) {
      let next = "\(parent.dark)-\(parent.fontSize)-" + parent.source
      guard ready, next != key else { return }
      key = next
      view.callAsyncJavaScript(
        "await window.renderMessage(source,dark,fontSize,colors,lease); return true;",
        arguments: [
          "source": parent.source, "dark": parent.dark, "fontSize": parent.fontSize,
          "colors": NativePalette.documentColors(dark: parent.dark), "lease": lease,
        ],
        in: nil, in: .page
      ) { [weak self, weak view] result in
        guard let self, (view as? ReusableDocumentView)?.lease == self.lease else { return }
        if case .failure = result { self.parent.failure = true }
        else { view?.alpha = 1 }
      }
    }
    func userContentController(
      _ controller: WKUserContentController, didReceive message: WKScriptMessage
    ) {
      if let value = message.body as? [String: Any], value["lease"] as? String == lease,
        let height = value["height"] as? Double, height.isFinite, height >= 0,
        abs(parent.height - CGFloat(height)) > 0.5 {
        parent.height = max(1, CGFloat(height))
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
      parent.failure = true
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

@MainActor private final class ReusableDocumentView: WKWebView {
  var rendererReady = false
  var lease = ""
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
    isInspectable = false
  }
  required init?(coder: NSCoder) { fatalError("Not used") }
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
