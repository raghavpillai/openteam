import XCTest

/// Drives a loopback parity-server.ts from UI tests (`/__qa/*` control endpoints).
struct QAFixture {
  let base: String
  func post(_ path: String, _ body: [String: Any] = [:]) async throws {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }
  func state() async throws -> [String: Any] {
    let (data, _) = try await URLSession.shared.data(from: URL(string: base + "/__qa/state")!)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
}

@MainActor extension XCTestCase {
  /// SwiftUI reports destination frames before its slide finishes. Do not tap coordinates
  /// from the end of the transition while the control is still moving toward them.
  func waitForArrival(_ element: XCUIElement) {
    let ready = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "hittable == true"), object: element)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed)
    Thread.sleep(forTimeInterval: 0.5)
  }
  func dismissPasswordPrompt(_ app: XCUIApplication) {
    let prompt = app.buttons["Not Now"]
    for _ in 0..<3 {
      guard prompt.waitForExistence(timeout: 2) else { return }
      prompt.tap()
      if prompt.waitForNonExistence(timeout: 3) { return }
    }
    XCTFail("iOS password prompt did not dismiss")
  }
}
