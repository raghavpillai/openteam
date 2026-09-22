import XCTest

@MainActor final class RobotMotionUITests: XCTestCase {
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
