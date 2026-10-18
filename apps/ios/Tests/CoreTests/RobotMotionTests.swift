import XCTest

@testable import OpenTeamCore

final class RobotMotionTests: XCTestCase {
  func testAllDesktopIdentitiesAndNormalization() {
    XCTAssertEqual(RobotShape.allCases.count, 12)
    XCTAssertEqual(RobotArtwork.shared.shapes.count, 12)
    XCTAssertEqual(RobotShape(icon: "  TV-HEAD\n"), .tvHead)
    XCTAssertEqual(RobotShape(icon: "hexagon"), .chip)
    XCTAssertEqual(RobotShape(icon: nil), .chip)
    for (index, shape) in RobotShape.allCases.enumerated() {
      let design = RobotArtwork.shared[shape]
      XCTAssertEqual(design.tempo, 6.4 + Double(index) * 0.21, accuracy: 1e-10)
      XCTAssertFalse(design.nodes.isEmpty)
      XCTAssertEqual(Set(design.parts.map(\.id)).count, design.parts.count)
    }
    XCTAssertEqual(RobotArtwork.faceColor("#000000"), "#f2f2f2")
    XCTAssertEqual(RobotArtwork.faceColor("#242424"), "#f2f2f2")
    XCTAssertEqual(RobotArtwork.faceColor("#ff7a1a"), "#1b1b1d")
  }
  func testInterruptedBridgesRetainThePresentedPoseForEveryRobot() {
    for shape in RobotShape.allCases {
      var motion = RobotMotion(shape: shape, mode: .idle)
      motion.advance(by: 2.17)
      for next in [RobotAvatarMode.thinking, .idle, .thinking, .still, .idle] {
        let before = RobotArtwork.shared[shape].parts.map { motion.pose($0.id) }
        motion.setMode(next)
        let after = RobotArtwork.shared[shape].parts.map { motion.pose($0.id) }
        for (a, b) in zip(before, after) {
          for (x, y) in zip(a.matrix + [a.opacity], b.matrix + [b.opacity]) {
            XCTAssertEqual(x, y, accuracy: 1e-10)
          }
        }
        motion.advance(by: 0.13)
      }
    }
  }
  func testDestinationLoopPausesFor320MillisecondsAndCursorDoesNotRestart() throws {
    let shape = RobotShape.terminal
    let design = RobotArtwork.shared[shape]
    let cursor = try XCTUnwrap(design.parts.first { $0.name == "cursor" })
    var motion = RobotMotion(shape: shape, mode: .idle)
    motion.advance(by: 0.9)
    // Cursor entered from opacity zero, so its loop started after the 320 ms bridge.
    XCTAssertEqual(motion.pose(cursor.id).opacity, 0)
    motion.setMode(.thinking)
    XCTAssertEqual(motion.pose(cursor.id).opacity, 0)
    motion.advance(by: 0.32)
    XCTAssertEqual(motion.pose(cursor.id).opacity, 0)
    let body = RobotPart.body
    let destination = RobotKeyframes.pose(body, mode: .thinking, time: 0, tempo: design.tempo)
    XCTAssertEqual(motion.pose("body").rotation, destination.rotation, accuracy: 1e-10)
    motion.advance(by: 0.22)
    XCTAssertEqual(motion.pose(cursor.id).opacity, 0.7)
    XCTAssertEqual(
      motion.pose("body").rotation,
      RobotKeyframes.pose(body, mode: .thinking, time: 0.22, tempo: design.tempo).rotation,
      accuracy: 1e-10)
  }
  func testReducedMotionCancelsLoopsAndBridgesWithoutRevealingHiddenParts() {
    for shape in RobotShape.allCases {
      var motion = RobotMotion(shape: shape, mode: .thinking)
      motion.advance(by: 0.17)
      motion.setReducedMotion(true)
      let before = RobotArtwork.shared[shape].parts.map { motion.pose($0.id) }
      motion.advance(by: 10)
      XCTAssertFalse(motion.isAnimating)
      XCTAssertEqual(before, RobotArtwork.shared[shape].parts.map { motion.pose($0.id) })
      for part in RobotArtwork.shared[shape].parts {
        XCTAssertEqual(
          motion.pose(part.id),
          RobotKeyframes.pose(part, mode: .still, time: 0, tempo: RobotArtwork.shared[shape].tempo))
      }
      motion.setReducedMotion(false)
      XCTAssertTrue(motion.isAnimating)
      motion.setMode(.still)
      motion.advance(by: 0.32)
      XCTAssertFalse(motion.isAnimating)
    }
  }
}
