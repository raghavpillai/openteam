import UIKit
import XCTest

@MainActor final class PhotoInteractionUITests: XCTestCase {
  private let base = ProcessInfo.processInfo.environment["UI_FIXTURE_SERVER"] ?? "http://127.0.0.1:20054"
  private let lastPhoto = String(repeating: "6", count: 64)
  private let previousPhoto = String(repeating: "5", count: 64)

  private func control(_ path: String, _ body: [String: Any] = [:]) async throws {
    var request = URLRequest(url: URL(string: base + path)!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }

  private func openGallery() async throws -> XCUIApplication {
    continueAfterFailure = false
    try await control("/__qa/reset")
    try await control("/__qa/content", ["scene": "media"])
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--server", base, "--appearance", "dark",
      "--open-channel", "channel-research",
    ]
    app.launch()
    let attachment = app.buttons["attachment-" + lastPhoto]
    XCTAssertTrue(attachment.waitForExistence(timeout: 20))
    XCTAssertTrue(element(app, "chat-loading").waitForNonExistence(timeout: 15))
    let ready = expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: attachment)
    await fulfillment(of: [ready], timeout: 10)
    attachment.tap()
    XCTAssertTrue(app.buttons["photo-close"].waitForExistence(timeout: 12))
    XCTAssertTrue(photo(app, lastPhoto).waitForExistence(timeout: 12))
    try await settle()
    return app
  }

  private func photo(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: "photo-image-" + id).firstMatch
  }

  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: id).firstMatch
  }

  private func assertChrome(_ app: XCUIApplication, visible: Bool,
    file: StaticString = #filePath, line: UInt = #line)
  {
    for id in ["photo-close", "photo-options", "photo-caption", "photo-filmstrip"] {
      let value = element(app, id)
      XCTAssertTrue(visible ? value.waitForExistence(timeout: 5) : value.waitForNonExistence(timeout: 5),
        "\(id) should be \(visible ? "visible" : "hidden")", file: file, line: line)
    }
  }

  private func settle() async throws {
    // UIKit's zoom and spring animations can outlast the accessibility snapshot.
    try await Task.sleep(for: .milliseconds(600))
  }

  private func capture(_ name: String, _ app: XCUIApplication) {
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "photo-" + name
    screenshot.lifetime = .keepAlways
    add(screenshot)
    let hierarchy = XCTAttachment(string: app.debugDescription)
    hierarchy.name = "photo-tree-" + name
    hierarchy.lifetime = .keepAlways
    add(hierarchy)
  }

  private func processID(_ app: XCUIApplication) throws -> Int {
    let description = app.debugDescription
    let marker = try XCTUnwrap(description.range(of: "pid: "))
    return try XCTUnwrap(Int(description[marker.upperBound...].prefix(while: { $0.isNumber })))
  }

  private func centerPixels(_ app: XCUIApplication) throws -> Data {
    // Compare visible image content, excluding chrome, status time and home indicator.
    // This verifies actual magnification without exposing the private zoom scale.
    let image = try XCTUnwrap(app.screenshot().image.cgImage)
    let bounds = CGRect(x: CGFloat(image.width) * 0.3, y: CGFloat(image.height) * 0.4,
      width: CGFloat(image.width) * 0.4, height: CGFloat(image.height) * 0.2).integral
    let crop = try XCTUnwrap(image.cropping(to: bounds))
    return try XCTUnwrap(UIImage(cgImage: crop).pngData())
  }

  private func drag(_ image: XCUIElement, dx: CGFloat = 0, dy: CGFloat) {
    let start = image.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
    start.press(forDuration: 0.05,
      thenDragTo: start.withOffset(CGVector(dx: dx, dy: dy)),
      withVelocity: .slow, thenHoldForDuration: 0.3)
  }

  func testSingleTapTogglesEveryControlAndExpandsPhotoArea() async throws {
    let app = try await openGallery()
    defer { app.terminate() }
    let image = photo(app, lastPhoto)
    assertChrome(app, visible: true)
    let visibleFrame = image.frame
    capture("chrome-visible", app)

    image.tap()
    assertChrome(app, visible: false)
    XCTAssertGreaterThan(image.frame.height, visibleFrame.height + 50)
    XCTAssertGreaterThan(image.frame.width, visibleFrame.width)
    capture("chrome-hidden-expanded", app)

    image.tap()
    assertChrome(app, visible: true)
    XCTAssertEqual(image.frame.height, visibleFrame.height, accuracy: 2)
    XCTAssertEqual(element(app, "photo-caption").label, "Desktop capture 6")
    capture("chrome-restored", app)

    image.swipeRight()
    let previousCaption = expectation(for: NSPredicate(format: "label == %@",
      "Omnibox after handoff with _HANDOFF_TEST appended"), evaluatedWith: element(app, "photo-caption"))
    await fulfillment(of: [previousCaption], timeout: 5)
    XCTAssertTrue(app.buttons["photo-thumbnail-" + previousPhoto].isSelected)
    photo(app, previousPhoto).swipeLeft()
    let restoredCaption = expectation(for: NSPredicate(format: "label == %@", "Desktop capture 6"),
      evaluatedWith: element(app, "photo-caption"))
    await fulfillment(of: [restoredCaption], timeout: 5)
    XCTAssertTrue(app.buttons["photo-thumbnail-" + lastPhoto].isSelected)
    capture("swipe-paging-restored", app)
  }

  func testDoubleTapPinchAndZoomedPanKeepGalleryOpen() async throws {
    let app = try await openGallery()
    defer { app.terminate() }
    let image = photo(app, lastPhoto)
    let fit = try centerPixels(app)

    image.doubleTap()
    try await settle()
    assertChrome(app, visible: true)
    XCTAssertNotEqual(try centerPixels(app), fit, "Double tap must magnify the photo")
    capture("double-tap-zoom", app)

    drag(image, dy: 180)
    XCTAssertTrue(image.exists, "Panning a zoomed photo must keep the gallery open")
    let verticallyPanned = try centerPixels(app)
    drag(image, dx: 65, dy: 0)
    try await settle()
    XCTAssertNotEqual(try centerPixels(app), verticallyPanned, "A zoomed horizontal drag must pan the photo")
    XCTAssertTrue(app.buttons["photo-thumbnail-" + lastPhoto].isSelected,
      "Panning a zoomed photo must not page to a different image")
    assertChrome(app, visible: true)
    image.tap()
    assertChrome(app, visible: false)
    capture("zoomed-pan-chrome-hidden", app)
    image.tap()
    assertChrome(app, visible: true)

    image.doubleTap()
    try await settle()
    XCTAssertEqual(try centerPixels(app), fit, "Second double tap must return to fit")
    image.pinch(withScale: 2, velocity: 1)
    try await settle()
    XCTAssertNotEqual(try centerPixels(app), fit, "Pinch must magnify the photo")
    drag(image, dy: 180)
    XCTAssertTrue(image.exists, "A downward pan after pinching must keep the gallery open")
    capture("pinch-zoom-pan", app)

    image.doubleTap()
    try await settle()
    XCTAssertEqual(try centerPixels(app), fit)
  }

  func testIncompleteDownwardDragReturnsToPlaceThenSwipeDismisses() async throws {
    let app = try await openGallery()
    defer { app.terminate() }
    let image = photo(app, lastPhoto)
    let originalFrame = image.frame
    drag(image, dy: 45)
    try await settle()
    XCTAssertTrue(image.exists, "An incomplete dismissal drag must keep the photo open")
    XCTAssertEqual(image.frame.midY, originalFrame.midY, accuracy: 2)
    assertChrome(app, visible: true)
    drag(image, dy: -120)
    try await settle()
    XCTAssertTrue(image.exists, "An upward drag must keep the gallery open")
    XCTAssertEqual(image.frame.midY, originalFrame.midY, accuracy: 2)
    capture("incomplete-drag-restored", app)

    image.tap()
    assertChrome(app, visible: false)
    let hiddenFrame = image.frame
    drag(image, dy: 45)
    try await settle()
    XCTAssertTrue(image.exists, "An incomplete drag with hidden chrome must recover")
    XCTAssertEqual(image.frame, hiddenFrame)
    assertChrome(app, visible: false)
    capture("hidden-incomplete-drag-restored-before-dismiss", app)
    drag(image, dy: 240)
    XCTAssertTrue(image.waitForNonExistence(timeout: 8))
    XCTAssertTrue(app.buttons["attachment-" + lastPhoto].isHittable)
    capture("swipe-down-dismissed", app)
  }

  func testHomeAndOtherAppPreserveSelectionZoomAndHiddenChrome() async throws {
    let app = try await openGallery()
    defer { app.terminate() }
    let thumbnail = app.buttons["photo-thumbnail-" + previousPhoto]
    XCTAssertTrue(thumbnail.waitForExistence(timeout: 8))
    thumbnail.tap()
    let image = photo(app, previousPhoto)
    XCTAssertTrue(image.waitForExistence(timeout: 8))
    XCTAssertEqual(element(app, "photo-caption").label,
      "Omnibox after handoff with _HANDOFF_TEST appended")
    image.doubleTap()
    try await settle()
    image.tap()
    assertChrome(app, visible: false)
    try await settle()
    let centered = try centerPixels(app)
    drag(image, dx: 65, dy: 0)
    try await settle()
    XCTAssertNotEqual(try centerPixels(app), centered, "The zoomed photo must pan before backgrounding")
    let zoomed = try centerPixels(app)
    let zoomedFrame = image.frame
    let originalPID = try processID(app)
    capture("before-background-selected-zoomed-hidden", app)

    XCUIDevice.shared.press(.home)
    // Home can only reveal the system indicator in this runtime's immersive mode.
    // Activating Settings guarantees a genuine foreground swap before returning.
    let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
    settings.activate()
    defer { settings.terminate() }
    XCTAssertTrue(settings.wait(for: .runningForeground, timeout: 8))
    let backgrounded = expectation(for: NSPredicate { _, _ in
      app.state == .runningBackground || app.state == .runningBackgroundSuspended
    }, evaluatedWith: app)
    await fulfillment(of: [backgrounded], timeout: 8)
    let backgroundScreen = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    backgroundScreen.name = "photo-settings-foreground-app-state-\(app.state.rawValue)"
    backgroundScreen.lifetime = .keepAlways
    add(backgroundScreen)

    app.activate()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
    let returnedPID = try processID(app)
    XCTAssertEqual(returnedPID, originalPID, "Background recovery must use the same app process")
    let processEvidence = XCTAttachment(string:
      "Before Settings PID: \(originalPID)\nAfter Settings PID: \(returnedPID)\nSettings foreground and app background states were asserted.\n")
    processEvidence.name = "photo-same-process-lifecycle"
    processEvidence.lifetime = .keepAlways
    add(processEvidence)
    XCTAssertTrue(image.waitForExistence(timeout: 8), "The selected gallery photo must survive activation")
    assertChrome(app, visible: false)
    try await settle()
    capture("returned-from-settings", app)
    XCTAssertEqual(image.frame, zoomedFrame)
    XCTAssertEqual(try centerPixels(app), zoomed, "The visible zoom and pan must survive activation")

    image.tap()
    assertChrome(app, visible: true)
    XCTAssertTrue(app.buttons["photo-thumbnail-" + previousPhoto].isSelected)
    XCTAssertEqual(element(app, "photo-caption").label,
      "Omnibox after handoff with _HANDOFF_TEST appended")
    image.doubleTap()
    try await settle()
    drag(image, dy: 240)
    XCTAssertTrue(image.waitForNonExistence(timeout: 8))
    capture("dismissed-after-app-switch", app)
  }
}
