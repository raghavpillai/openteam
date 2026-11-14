import XCTest

@testable import OpenTeamCore

final class RobotMotionTests: XCTestCase {
  private func assertEqual(_ a: RobotAffine, _ b: RobotAffine, accuracy: Double = 1e-9, line: UInt = #line) {
    for (x, y) in zip(a.values, b.values) { XCTAssertEqual(x, y, accuracy: accuracy, line: line) }
  }
  /// Step the engine a frame at a time, as the display link does.
  private func run(_ motion: inout RobotMotion, _ seconds: Double) {
    for _ in 0..<Int((seconds * 60).rounded()) { motion.advance(by: 1.0 / 60) }
  }
  func testAllDesktopIdentitiesAndNormalization() {
    XCTAssertEqual(RobotShape.allCases.count, 12)
    XCTAssertEqual(RobotArtwork.shared.shapes.count, 12)
    XCTAssertEqual(RobotArtwork.shared.modes, RobotAvatarMode.allCases.map(\.rawValue))
    XCTAssertEqual(RobotShape(icon: "  TV-HEAD\n"), .tvHead)
    XCTAssertEqual(RobotShape(icon: "hexagon"), .chip)
    XCTAssertEqual(RobotShape(icon: nil), .chip)
    for (index, shape) in RobotShape.allCases.enumerated() {
      let design = RobotArtwork.shared[shape]
      XCTAssertEqual(design.tempo, 6.4 + Double(index) * 0.21, accuracy: 1e-10)
      XCTAssertFalse(design.nodes.isEmpty)
      XCTAssertEqual(Set(design.elements.map(\.id)).count, design.elements.count)
      for element in design.elements {
        XCTAssertEqual(element.modes.count, RobotAvatarMode.allCases.count)
      }
    }
    XCTAssertEqual(RobotArtwork.faceColor("#000000"), "#f2f2f2")
    XCTAssertEqual(RobotArtwork.faceColor("#ff7a1a"), "#1b1b1d")
  }
  func testTransformListsInterpolateLikeCSS() {
    // Matching functions interpolate one by one; a shorter list is padded with identities.
    assertEqual(
      RobotTransformList.mixed([.rotate(-3)], [.rotate(3), .translate(0, -1)], by: 0.5),
      RobotAffine([.rotate(0), .translate(0, -0.5)]))
    assertEqual(
      RobotTransformList.mixed([], [.translate(0, -0.9), .scale(0.992, 1.022)], by: 0.5),
      RobotAffine([.translate(0, -0.45), .scale(0.996, 1.011)]))
    // A matrix bridge turns the short way and scales on the way.
    let from = RobotAffine([.scale(0.24, 0.24), .rotate(-100)])
    let half = from.mixed(with: .identity, by: 0.5)
    assertEqual(half, RobotAffine([.rotate(-50), .scale(0.62, 0.62)]))
    XCTAssertEqual(RobotEasing.value("ease-in-out", 0.5), 0.5, accuracy: 1e-6)
    XCTAssertEqual(RobotEasing.value("cubic-bezier(0.34, 1.56, 0.64, 1)", 0.5), 1.0, accuracy: 0.15)
    XCTAssertEqual(RobotEasing.value("steps(1)", 0.99), 0)
  }
  func testFaceProjectionMatchesTheBrowserFlattening() {
    // perspective(340px) rotateY(60deg) about (120, 130): measured in Chromium as
    // matrix(0.8057, 0.3311, 0, 1, 23.3213, -39.7353).
    let matrix = RobotMatrix4.perspective(340).concatenating(.rotationY(60)).flattened(about: (120, 130))
    assertEqual(matrix, .init(a: 0.8057, b: 0.3311, c: 0, d: 1, tx: 23.3213, ty: -39.7353), accuracy: 1e-4)
  }
  func testInterruptedBridgesRetainThePresentedPoseForEveryRobot() {
    for shape in RobotShape.allCases {
      var motion = RobotMotion(shape: shape, mode: .idle)
      run(&motion, 2.17)
      // (Reactions that move the antenna override its bridge, so none of these start one.)
      for next in [RobotAvatarMode.thinking, .idle, .working, .waiting, .still, .connecting, .idle] {
        let before = motion.frames()
        motion.setMode(next)
        let after = motion.frames()
        for id in motion.elementIDs where RobotRig.shared[shape]![id].bridged {
          assertEqual(before[id]!.transform, after[id]!.transform)
          XCTAssertEqual(before[id]!.opacity, after[id]!.opacity, accuracy: 1e-9)
        }
        run(&motion, 0.13)
      }
    }
  }
  func testGlyphModesFoldTheRobotIntoItsCore() throws {
    var motion = RobotMotion(shape: .classic, mode: .idle)
    run(&motion, 1)
    motion.setMode(.thinking)
    run(&motion, 2)
    let frames = motion.frames()
    XCTAssertEqual(frames["body"]!.opacity, 0, accuracy: 1e-9)
    assertEqual(frames["body"]!.transform, RobotAffine([.scale(0.24, 0.24), .rotate(-100)]))
    let rig = RobotRig.shared[.classic]!
    let core = try XCTUnwrap(rig.elements.first { $0.node?.roles["g"] == "core" })
    XCTAssertEqual(frames[core.id]!.opacity, 1, accuracy: 1e-9)
    assertEqual(frames[core.id]!.transform, RobotAffine([.scale(0.833, 0.833)]))
    let dots = try XCTUnwrap(rig.elements.first { $0.node?.roles["g"] == "dots" })
    XCTAssertEqual(frames[dots.id]!.opacity, 1, accuracy: 1e-9)
  }
  func testDoneCelebratesAndCuesNeighboursOnlyAfterWork() {
    var motion = RobotMotion(shape: .chip, mode: .working)
    run(&motion, 1)
    motion.setMode(.done)
    XCTAssertEqual(motion.pendingCue, .cheer)
    XCTAssertFalse(motion.isSettled)
    run(&motion, 0.4)
    XCTAssertFalse(motion.frame("rig").transform.approximatelyEquals(.identity))
    run(&motion, 2)
    XCTAssertTrue(motion.frame("rig").transform.approximatelyEquals(.identity, tolerance: 1e-6))
    var idle = RobotMotion(shape: .chip, mode: .idle)
    idle.setMode(.done)
    XCTAssertNil(idle.pendingCue)
  }
  func testPokeFacesReplaceTheEyesAndBlushFades() throws {
    var motion = RobotMotion(shape: .goggles, mode: .idle)
    run(&motion, 0.5)
    motion.poke(1)  // the bounce: squint and blush
    run(&motion, 0.2)
    let rig = RobotRig.shared[.goggles]!
    let eyes = try XCTUnwrap(rig.elements.first { $0.node?.part == "eyes" })
    let squint = try XCTUnwrap(rig.elements.first { $0.node?.expression == "squint" })
    let blush = try XCTUnwrap(rig.elements.first { $0.node?.expression == "blush" })
    var frames = motion.frames()
    XCTAssertFalse(frames[eyes.id]!.visible)
    XCTAssertTrue(frames[squint.id]!.visible)
    XCTAssertGreaterThan(frames[blush.id]!.opacity, 0.2)
    run(&motion, 3)
    frames = motion.frames()
    XCTAssertTrue(frames[eyes.id]!.visible)
    XCTAssertFalse(frames[squint.id]!.visible)
    XCTAssertEqual(frames[blush.id]!.opacity, 0, accuracy: 1e-6)
    XCTAssertTrue(motion.isSettled)
  }
  func testReducedMotionShowsEachStateAsAStillFrame() throws {
    var motion = RobotMotion(shape: .classic, mode: .idle)
    motion.setReducedMotion(true)
    motion.setMode(.failed)
    XCTAssertFalse(motion.isAnimating)
    assertEqual(motion.frame("body").transform, RobotAffine([.translate(0, 3), .rotate(-4)]))
    motion.poke(0)
    XCTAssertTrue(motion.isSettled)
  }
  func testLoopsShareAPhaseOffsetPerAvatar() {
    var a = RobotMotion(shape: .classic, mode: .idle)
    var b = RobotMotion(shape: .classic, mode: .idle)
    b.phase = 1.15
    run(&a, 1.15 + 0.7)
    run(&b, 0.7)
    // 1.15 s is 69 frames.
    assertEqual(a.frame("body").transform, b.frame("body").transform)
  }
}
