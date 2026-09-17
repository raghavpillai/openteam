import SwiftUI
import WebKit

/// Complex document content uses iOS WebKit with bundled, offline renderers.
/// Ordinary chat, code and every app control stay native SwiftUI.
struct RichMarkdownView: View {
  let source: String
  var forceDark = false
  @Environment(\.colorScheme) private var scheme
  @Environment(\.dynamicTypeSize) private var typeSize
  @State private var height: CGFloat = 40
  @State private var failure = false
  var body: some View {
    if failure {
      Text(source).font(.body).textSelection(.enabled)
    } else {
      MarkdownDocument(
        source: source, dark: forceDark || scheme == .dark,
        fontSize: UIFont.preferredFont(forTextStyle: .body).pointSize, height: $height,
        failure: $failure
      )
      .frame(height: height).accessibilityIdentifier("rich-markdown")
    }
  }
  static func required(_ source: String) -> Bool {
    source.range(
      of:
        #"(?m)^(#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|>\s|\|.*\||```mermaid|\$\$|---\s*$)|\\\(|\\\[|\$[^\s$][^\n$]*\$"#,
      options: .regularExpression) != nil
  }
}

private struct MarkdownDocument: UIViewRepresentable {
  let source: String
  let dark: Bool
  let fontSize: CGFloat
  @Binding var height: CGFloat
  @Binding var failure: Bool
  func makeCoordinator() -> Coordinator { Coordinator(self) }
  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.userContentController.add(context.coordinator, name: "height")
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.isOpaque = false
    view.backgroundColor = .clear
    view.scrollView.backgroundColor = .clear
    view.scrollView.isScrollEnabled = false
    view.navigationDelegate = context.coordinator
    view.isInspectable = false
    if let url = Bundle.main.url(forResource: "MessageRenderer", withExtension: "html"),
      let html = try? String(contentsOf: url, encoding: .utf8)
    {
      view.loadHTMLString(html, baseURL: nil)
    } else {
      DispatchQueue.main.async { failure = true }
    }
    return view
  }
  func updateUIView(_ view: WKWebView, context: Context) {
    context.coordinator.parent = self
    context.coordinator.render(view)
  }
  static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
    view.stopLoading()
    view.navigationDelegate = nil
    view.configuration.userContentController.removeScriptMessageHandler(forName: "height")
  }
  @MainActor final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    var parent: MarkdownDocument
    var ready = false
    var key = ""
    init(_ parent: MarkdownDocument) { self.parent = parent }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      ready = true
      render(webView)
    }
    func render(_ view: WKWebView) {
      let next = "\(parent.dark)-\(parent.fontSize)-" + parent.source
      guard ready, next != key else { return }
      key = next
      view.callAsyncJavaScript(
        "await window.renderMessage(source,dark,fontSize,colors); return true;",
        arguments: [
          "source": parent.source, "dark": parent.dark, "fontSize": parent.fontSize,
          "colors": NativePalette.documentColors(dark: parent.dark),
        ],
        in: nil, in: .page
      ) { [weak self] result in
        if case .failure = result { self?.parent.failure = true }
      }
    }
    func userContentController(
      _ controller: WKUserContentController, didReceive message: WKScriptMessage
    ) {
      if let height = message.body as? Double, height.isFinite, height >= 0 {
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
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { parent.failure = true }
  }
}
