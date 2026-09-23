import XCTest
import UIKit

@MainActor final class RobotMotionUITests: XCTestCase {
  func testIdleRobotsActuallyMoveInProfileGroupPickerAndComputerHeader() async throws {
    continueAfterFailure = false
    let base = "http://127.0.0.1:20070"
    var request = URLRequest(url: URL(string: base + "/__qa/scene")!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = Data(#"{"scene":"dark-chat-seven"}"#.utf8)
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "light",
      "--open-channel", "visual-chat"]
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(app.buttons["conversation-details"].waitForExistence(timeout: 12))
    app.buttons["conversation-details"].tap()
    let name = app.textFields["profile-name"]
    XCTAssertTrue(name.waitForExistence(timeout: 8))
    let shape = app.buttons["profile-robot-classic"]
    XCTAssertTrue(shape.waitForExistence(timeout: 5))
    XCTAssertTrue(shape.isHittable)
    try await assertMoving(app, rect: shape.frame, name: "profile-shape-idle")
    // The large preview sits immediately above the centered name field.
    try await assertMoving(app, rect: CGRect(x: app.frame.midX - 40,
      y: name.frame.minY - 100, width: 80, height: 80), name: "profile-preview-idle")
    app.terminate()
    app.launch()
    XCTAssertTrue(app.buttons["Computer"].waitForExistence(timeout: 12))
    app.buttons["Computer"].tap()
    let done = app.buttons["Done"]
    XCTAssertTrue(done.waitForExistence(timeout: 8))
    try await assertMoving(app, rect: CGRect(x: done.frame.maxX + 12,
      y: done.frame.midY - 12.5, width: 25, height: 25), name: "computer-header-idle")
    app.terminate()
    app.launchArguments = ["--ui-testing", "--server", base, "--appearance", "light"]
    app.launch()
    XCTAssertTrue(app.buttons["new-button"].waitForExistence(timeout: 12))
    app.buttons["new-button"].tap()
    app.buttons["New Group Chat"].tap()
    XCTAssertTrue(app.textFields["group-search"].waitForExistence(timeout: 5))
    let choice = app.buttons["Memory Deep 914 Server"]
    XCTAssertTrue(choice.waitForExistence(timeout: 5))
    try await assertMoving(app, rect: CGRect(x: choice.frame.minX,
      y: choice.frame.midY - 17, width: 34, height: 34), name: "group-choice-idle")
  }

  private func assertMoving(_ app: XCUIApplication, rect: CGRect, name: String) async throws {
    try await Task.sleep(for: .seconds(1))
    func pixels() throws -> Data {
      let screenshot = app.screenshot().image
      let image = try XCTUnwrap(screenshot.cgImage)
      let scale = CGFloat(image.width) / app.frame.width
      let crop = try XCTUnwrap(image.cropping(to: CGRect(x: rect.minX * scale,
        y: rect.minY * scale, width: rect.width * scale, height: rect.height * scale)))
      let attachment = XCTAttachment(image: UIImage(cgImage: crop))
      attachment.name = name
      attachment.lifetime = .keepAlways
      add(attachment)
      // Rasterize only the crop: a CGImage subimage may retain the full
      // screenshot's backing buffer, including unrelated blinking controls.
      let context = try XCTUnwrap(CGContext(data: nil, width: crop.width, height: crop.height,
        bitsPerComponent: 8, bytesPerRow: crop.width * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
      context.draw(crop, in: CGRect(x: 0, y: 0, width: crop.width, height: crop.height))
      return Data(bytes: try XCTUnwrap(context.data), count: crop.width * crop.height * 4)
    }
    let first = try pixels()
    try await Task.sleep(for: .seconds(1.7))
    XCTAssertNotEqual(first, try pixels(), "\(name) must visibly animate while idle")
  }

  private func launch(
    _ mode: String = "idle", shape: String = "classic", gallery: Bool = false,
    sample: Double? = nil, dark: Bool = false
  ) -> XCUIApplication {
    continueAfterFailure = false
    let app = XCUIApplication()
    app.launchArguments = ["--bot-motion-lab", "--bot-state", mode, "--robot-shape", shape]
    if gallery { app.launchArguments.append("--robot-gallery") }
    if let sample { app.launchArguments += ["--robot-sample", String(sample)] }
    if dark { app.launchArguments.append("--lab-dark") }
    app.launch()
    XCTAssertTrue(app.staticTexts["motion-state"].waitForExistence(timeout: 10))
    return app
  }
  private func capture(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "our-robot-" + name
    attachment.lifetime = .keepAlways
    add(attachment)
    let shapes = [
      "classic", "goggles", "tv-head", "terminal", "pod", "hex-visor", "chip", "helmet", "bulb",
      "owl", "periscope", "dual-screen",
    ]
    var frames: [String: [Double]] = [:]
    for shape in shapes {
      let cell = app.descendants(matching: .any).matching(identifier: "robot-cell-" + shape)
        .firstMatch
      if cell.exists {
        let r = cell.frame
        frames[shape] = [r.midX - 48, r.minY, 96, 96]
      }
    }
    if !frames.isEmpty,
      let data = try? JSONSerialization.data(withJSONObject: frames, options: [.sortedKeys])
    {
      let metadata = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
      metadata.name = "frames-" + name
      metadata.lifetime = .keepAlways
      add(metadata)
    }

  }
  private func pause(_ seconds: Double) async throws {
    try await Task.sleep(for: .seconds(seconds))
  }
  func testAllTwelveIdentitiesInStillAndSampledThinking() {
    let still = launch("still", gallery: true, sample: 0)
    capture("gallery-still", still)
    let thinking = launch("thinking", gallery: true, sample: 1.3)
    capture("gallery-thinking-1.3s", thinking)
    let dark = launch("thinking", gallery: true, sample: 1.3, dark: true)
    capture("gallery-dark-thinking-1.3s", dark)
  }
  func testTransitionTourAndRapidInterruptions() async throws {
    let app = launch("idle", shape: "tv-head")
    capture("idle", app)
    app.buttons["state-thinking"].tap()
    try await pause(0.12)
    app.buttons["state-idle"].tap()
    try await pause(0.12)
    app.buttons["state-thinking"].tap()
    try await pause(1.3)
    capture("thinking", app)
    app.buttons["shape-periscope"].tap()
    try await pause(1.3)
    capture("periscope-thinking", app)
    app.buttons["motion-tour"].tap()
    let ready = expectation(
      for: NSPredicate(format: "label == 'Ready'"),
      evaluatedWith: app.staticTexts["motion-tour-status"])
    await fulfillment(of: [ready], timeout: 18)
    capture("tour-complete", app)
  }
  func testReducedMotionAndBackgrounding() async throws {
    let app = launch("thinking", shape: "tv-head")
    app.switches["motion-reduced"].tap()
    try await pause(0.4)
    capture("reduced-a", app)
    try await pause(1)
    capture("reduced-b", app)
    app.buttons["state-idle"].tap()
    app.buttons["state-thinking"].tap()
    try await pause(0.4)
    capture("reduced-retargeted", app)
    XCUIDevice.shared.press(.home)
    app.activate()
    XCTAssertTrue(app.staticTexts["motion-state"].waitForExistence(timeout: 5))
    capture("reduced-resumed", app)
  }
}
