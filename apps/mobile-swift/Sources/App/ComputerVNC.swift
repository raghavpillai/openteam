import SwiftUI
import WebKit

/// Native controls and lifecycle; the bundled noVNC renderer owns the RFB stream.
/// Only a short-lived grant enters the isolated WebKit document, never the owner token.
@MainActor @Observable final class ComputerVNC: NSObject, WKNavigationDelegate {
  private(set) var connected = false
  private(set) var hasFrame = false
  private(set) var failure: String?
  private(set) var unauthorized = false
  @ObservationIgnored let webView: WKWebView
  @ObservationIgnored private var ready = false
  @ObservationIgnored private var controlling = false
  @ObservationIgnored private var generation = UUID()

  override init() {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    webView = WKWebView(frame: .zero, configuration: configuration)
    super.init()
    webView.isOpaque = false
    webView.backgroundColor = .black
    webView.scrollView.isScrollEnabled = false
    webView.isUserInteractionEnabled = false // Native touch and keyboard controls own input.
    webView.isInspectable = false
    webView.navigationDelegate = self
    configuration.userContentController.add(ComputerVNCEvents(owner: self), name: "computer")
    loadDocument()
  }
  private func loadDocument() {
    ready = false
    guard let url = Bundle.main.url(forResource: "ComputerVNC", withExtension: "html"),
      let html = try? String(contentsOf: url, encoding: .utf8) else {
      failure = "The computer viewer is missing. Reinstall OpenTeam."
      return
    }
    webView.loadHTMLString(html, baseURL: nil)
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { ready = true }
  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
    decisionHandler(navigationAction.request.url?.scheme == "about" ? .allow : .cancel)
  }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    disconnected()
    hasFrame = false
    loadDocument()
  }
  fileprivate func disconnected() {
    connected = false
    failure = "Computer connection interrupted. Reconnecting…"
  }
  func setControl(_ active: Bool) {
    guard controlling != active, ready else { return }
    controlling = active
    webView.callAsyncJavaScript("window.computer.control(active); return true;",
      arguments: ["active": active], in: nil, in: .page) { _ in }
  }
  func stop(clear: Bool = false) {
    generation = UUID()
    connected = false
    controlling = false
    if clear { hasFrame = false }
    if ready {
      webView.callAsyncJavaScript("window.computer.control(false); window.computer.stop(clear); return true;",
        arguments: ["clear": clear], in: nil, in: .page) { _ in }
    }
  }
  func run(api: API, botID: String) async {
    stop()
    let id = UUID()
    generation = id
    unauthorized = false
    await withTaskCancellationHandler {
      var delay = 0.5
      while !Task.isCancelled, generation == id {
        do {
          while !ready {
            try Task.checkCancellation()
            try await Task.sleep(for: .milliseconds(50))
          }
          let json = try await api.request("/api/v0/bots/\(API.segment(botID))/screen/vnc", method: "POST")
          let grant = try json.decode(ComputerVNCSession.self)
          let url = try grant.socketURL(api: api, botID: botID)
          try Task.checkCancellation()
          guard generation == id else { return }
          try await script("return await window.computer.connect(session);",
            arguments: ["session": ["url": url.absoluteString, "protocols": grant.protocols, "password": grant.password]])
          try Task.checkCancellation()
          guard generation == id else { return }
          connected = true
          hasFrame = true
          failure = nil
          delay = 0.5
          while connected, generation == id {
            try await Task.sleep(for: .milliseconds(250))
          }
        } catch {
          guard !Task.isCancelled, generation == id else { break }
          if let error = error as? APIError {
            if error.status == 401 || error.status == 403 {
              unauthorized = error.unauthorized
              failure = "Computer access expired. Sign in and reopen the computer."
              stop(clear: true)
              return
            }
            if error.status == 404 || error.status == 501 {
              failure = "Update your OpenTeam server to use the computer."
              return
            }
          }
          failure = "Could not connect to the computer. Reconnecting…"
        }
        do { try await Task.sleep(for: .seconds(delay)) } catch { break }
        delay = min(delay * 2, 5)
      }
      if generation == id { stop() }
    } onCancel: {
      Task { @MainActor [weak self] in
        if self?.generation == id { self?.stop() }
      }
    }
  }
  func input(_ body: [String: JSON]) async throws {
    guard connected, controlling else { throw APIError("Take control before using the computer.") }
    let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(JSON.object(body)))
    try await script("return await window.computer.input(input);", arguments: ["input": object])
  }
  private func script(_ source: String, arguments: [String: Any]) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      webView.callAsyncJavaScript(source, arguments: arguments, in: nil, in: .page) { result in
        switch result {
        case .success: continuation.resume()
        case .failure(let error): continuation.resume(throwing: error)
        }
      }
    }
  }
}

@MainActor private final class ComputerVNCEvents: NSObject, WKScriptMessageHandler {
  weak var owner: ComputerVNC?
  init(owner: ComputerVNC) { self.owner = owner }
  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame,
      let body = message.body as? [String: String], body["event"] == "disconnected" else { return }
    owner?.disconnected()
  }
}
