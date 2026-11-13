import SwiftUI
import XCTest
import os
@testable import OpenTeamNative

/// Baseline-compatible: the interceptor handles every synthetic target before
/// connection. This test intentionally fails on the original direct loader.
private final class PresentationImageProtocol: URLProtocol, @unchecked Sendable {
  static let requests = OSAllocatedUnfairLock(initialState: [String]())
  override class func canInit(with request: URLRequest) -> Bool {
    guard let url = request.url else { return false }
    return url.path.hasPrefix("/presentation-privacy-")
  }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    Self.requests.withLock { $0.append(request.url!.absoluteString) }
    let data = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=")!
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200,
      httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

@MainActor final class PresentationImagePrivacyTests: XCTestCase {
  func testHostedRankedPhotosNeverRequestRawPrivateProviderURLs() async throws {
    XCTAssertTrue(URLProtocol.registerClass(PresentationImageProtocol.self))
    defer { URLProtocol.unregisterClass(PresentationImageProtocol.self) }
    let nonce = UUID().uuidString
    PresentationImageProtocol.requests.withLock { $0.removeAll() }
    _ = try await URLSession.shared.data(from: URL(string: "https://calibration.example.com/presentation-privacy-\(nonce)")!)
    XCTAssertEqual(PresentationImageProtocol.requests.withLock { $0.count }, 1, "Interceptor must catch the original shared-session loader")
    PresentationImageProtocol.requests.withLock { $0.removeAll() }
    let hosts = ["127.0.0.1", "[::1]", "192.168.1.1", "169.254.169.254", "printer.local"]
    let places = hosts.enumerated().map { index, host in
      ["id": "p\(index)", "name": "Private fixture \(index)", "latitude": 40.7, "longitude": -74.0,
       "imageUrl": "https://\(host)/presentation-privacy-\(nonce)-\(index).png"] as [String: Any]
    }
    let payload: [String: Any] = ["version": 1, "places": places,
      "blocks": [["type": "ranked_media_list", "items": hosts.indices.map {
        ["id": "r\($0)", "title": "Fixture \($0)", "placeId": "p\($0)"]
      }]]]
    let value = try JSONDecoder().decode(JSON.self, from: JSONSerialization.data(withJSONObject: payload))
    let presentation = try XCTUnwrap(PresentationPayload.parse(value))
    let host = UIHostingController(rootView: PresentationMessageView(presentation: presentation)
      .environment(AppStore()).environment(MessageModalPresenter()))
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 1100))
    window.rootViewController = host; window.isHidden = false
    defer { window.isHidden = true; window.rootViewController = nil }
    host.view.frame = window.bounds; host.view.layoutIfNeeded()
    try await Task.sleep(for: .milliseconds(500))
    XCTAssertEqual(PresentationImageProtocol.requests.withLock { $0 }, [], "Automatic photos must use the selected server's protected image endpoint")
  }
}
