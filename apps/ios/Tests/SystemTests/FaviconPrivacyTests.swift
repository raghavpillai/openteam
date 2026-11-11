import XCTest
import os
import ObjectiveC
@testable import OpenTeamNative

private final class FaviconPrivacyProtocol: URLProtocol, @unchecked Sendable {
  static let requests = OSAllocatedUnfairLock(initialState: [String]())
  override class func canInit(with request: URLRequest) -> Bool { request.url?.scheme == "https" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    Self.requests.withLock { $0.append(request.url!.absoluteString) }
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 404,
      httpVersion: nil, headerFields: [:])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

private extension URLSessionConfiguration {
  @objc class func faviconPrivacyEphemeral() -> URLSessionConfiguration {
    let configuration = faviconPrivacyEphemeral()
    configuration.protocolClasses = [FaviconPrivacyProtocol.self]
    return configuration
  }
}

@MainActor final class FaviconPrivacyTests: XCTestCase {
  func testMessageHostsNeverTriggerAutomaticNetworkRequests() async throws {
    // Install an interceptor before constructing the real store. This also
    // makes the pre-fix regression safe: no synthetic destination is contacted.
    let original = try XCTUnwrap(class_getClassMethod(URLSessionConfiguration.self,
      NSSelectorFromString("ephemeralSessionConfiguration")))
    let replacement = try XCTUnwrap(class_getClassMethod(URLSessionConfiguration.self,
      #selector(URLSessionConfiguration.faviconPrivacyEphemeral)))
    method_exchangeImplementations(original, replacement)
    defer { method_exchangeImplementations(original, replacement) }
    let calibration = URLSession(configuration: .ephemeral)
    defer { calibration.invalidateAndCancel() }
    FaviconPrivacyProtocol.requests.withLock { $0.removeAll() }
    _ = try await calibration.data(from: URL(string: "https://calibration.release-qa.invalid/")!)
    XCTAssertEqual(FaviconPrivacyProtocol.requests.withLock { $0.count }, 1, "Interceptor must be active")
    FaviconPrivacyProtocol.requests.withLock { $0.removeAll() }

    let store = FaviconStore()
    for host in ["127.0.0.1", "192.168.1.1", "169.254.169.254", "printer.local",
      "favicon-" + UUID().uuidString.lowercased() + ".release-qa.invalid"] {
      let image = await store.load(host)
      let data = await store.dataURL(host)
      XCTAssertNil(image)
      XCTAssertNil(data)
      if case .missing = store.state(for: URL(string: "https://" + host + "/")!) {} else {
        XCTFail("Native links should immediately show the local fallback")
      }
    }
    XCTAssertEqual(FaviconPrivacyProtocol.requests.withLock { $0 }, [], "Message text must not cause native network requests")
  }
}
