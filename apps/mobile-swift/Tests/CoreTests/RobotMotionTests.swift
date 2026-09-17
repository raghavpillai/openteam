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
  func testNativeKeyframesMatchActualDesktopCSSAcrossAllRobotsAndModes() throws {
    struct Frame: Decodable {
      struct Part: Decodable {
        var id: String, matrix: [Double], opacity: Double
        var origin: String, bounds: [Double]
      }
      struct Face: Decodable { var id: String, matrix: [Double] }
      var shape: RobotShape, mode: RobotAvatarMode, time: Double, parts: [Part], faces: [Face]
    }
    let url = Bundle.module.url(
      forResource: "DesktopRobotPoses", withExtension: "json", subdirectory: "Fixtures")!
    let frames = try JSONDecoder().decode([Frame].self, from: Data(contentsOf: url))
    XCTAssertEqual(frames.count, 720)
    for frame in frames {
      let design = RobotArtwork.shared[frame.shape]
      let poses = Dictionary(
        uniqueKeysWithValues: design.parts.map {
          ($0.id, RobotKeyframes.pose($0, mode: frame.mode, time: frame.time, tempo: design.tempo))
        })
      func allNodes(_ nodes: [RobotNode]) -> [RobotNode] {
        nodes.flatMap { [$0] + allNodes($0.children) }
      }
      let byID = Dictionary(uniqueKeysWithValues: allNodes(design.nodes).map { ($0.id, $0) })
      for face in frame.faces {
        let actual = RobotProjection.faceMatrix(try XCTUnwrap(byID[face.id]), poses: poses)
        for (x, y) in zip(actual, face.matrix) {
          XCTAssertEqual(
            x, y, accuracy: 0.0002, "\(frame.shape) \(frame.mode) \(frame.time) face projection")
        }
      }
      for reference in frame.parts {
        let part = try XCTUnwrap(design.parts.first { $0.id == reference.id })
        if frame.mode == .still && frame.time == 0 {
          func find(_ nodes: [RobotNode]) -> RobotNode? {
            for node in nodes {
              if node.id == reference.id { return node }
              if let child = find(node.children) { return child }
            }
            return nil
          }
          let origin = reference.origin.split(separator: " ").prefix(2).map {
            Double($0.replacingOccurrences(of: "px", with: ""))!
          }
          let expected =
            reference.id == "body" ? origin.map { $0 - 4 } : zip(origin, reference.bounds).map(+)
          let actual =
            reference.id == "body" ? [50.0, 50] : try XCTUnwrap(find(design.nodes)).origin
          for (x, y) in zip(actual, expected) {
            XCTAssertEqual(x, y, accuracy: 0.0001, "\(frame.shape) \(part.name) origin")
          }
        }
        let pose = RobotKeyframes.pose(
          part, mode: frame.mode, time: frame.time, tempo: design.tempo)
        let context = "\(frame.shape.rawValue) \(frame.mode.rawValue) \(frame.time) \(part.name)"
        for (actual, expected) in zip(pose.matrix, reference.matrix) {
          // Browser computed styles round matrix components; timing solvers also round.
          XCTAssertEqual(actual, expected, accuracy: 0.00015, context)
        }
        XCTAssertEqual(pose.opacity, reference.opacity, accuracy: 0.00015, context)
      }
    }
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
